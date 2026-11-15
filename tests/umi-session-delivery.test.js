const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const python = process.env.LEROBOT_PYTHON || path.join(root, 'runtime', 'python', 'Scripts', 'python.exe');
const officialPython = process.env.LEROBOT_OFFICIAL_PYTHON || path.join(root, 'runtime', 'lerobot', 'Scripts', 'python.exe');

function request(port, method, route, body, cookie = '') {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: String(res.headers['content-type']).includes('application/json') ? JSON.parse(buffer) : buffer });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('UMI session import, QC, annotation and LeRobot v3 delivery close the loop', { skip: !fs.existsSync(officialPython), timeout: 120000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'umi-delivery-api-'));
  const dataDir = path.join(fixture, 'work');
  const sourceRoot = path.join(fixture, '5-umi-sessions');
  const createSessions = String.raw`
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from test_production_check import write_umi_session
write_umi_session(Path(sys.argv[2]) / 'session_00001')
`;
  execFileSync(python, ['-X', 'utf8', '-c', createSessions, path.join(root, 'tests'), sourceRoot], { windowsHide: true });
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'serve.js')], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_WORK_DIR: dataDir, LEROBOT_PYTHON: python, LEROBOT_OFFICIAL_PYTHON: officialPython }, stdio: 'ignore', windowsHide: true,
  });
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await request(port, 'GET', '/api/auth/status')).status === 200) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const setup = await request(port, 'POST', '/api/auth/setup', { name: 'QA', email: 'umi-qa@example.invalid', password: 'TestPass12345' });
    assert.equal(setup.status, 201);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const imported = await request(port, 'POST', '/api/imports/server-directory', { rootPath: sourceRoot, bundleName: 'umi-session', type: 'UMI', preset: 'auto' }, cookie);
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.scan.mode, 'umi-session');
    const bundleId = imported.body.bundleId, assetIds = imported.body.assets.map(asset => asset.id);
    const groupState = await request(port, 'GET', '/api/state', null, cookie);
    const annotationGroup = groupState.body.annotationGroups.find(group => group.key === bundleId);
    assert.equal(annotationGroup.stats.videoCovered, 1, JSON.stringify(annotationGroup));
    assert.equal(annotationGroup.stats.missingVideoCount, 0, JSON.stringify(annotationGroup));
    const previewStatus = await request(port, 'GET', `/api/episodes/${assetIds[0]}/preview/status`, null, cookie);
    assert.equal(previewStatus.status, 200, JSON.stringify(previewStatus.body));
    assert.equal(previewStatus.body.status, 'not_generated');
    const generatedPreview = await request(port, 'POST', '/api/episodes/preview', { assetId: assetIds[0] }, cookie);
    assert.equal(generatedPreview.status, 201, JSON.stringify(generatedPreview.body));
    assert.equal(generatedPreview.body.preview.profile, 'umi-session-preview-v1');
    const previewAsset = groupState.body.assets.find(asset => asset.id === assetIds[0]);
    const previewFile = path.join(dataDir, 'previews', assetIds[0], previewAsset.serverFile.sha256, 'camera_0.mp4');
    assert.equal(fs.existsSync(previewFile), true);
    const previewCodec = execFileSync(officialPython, ['-c', 'import av,sys; c=av.open(sys.argv[1]); print(c.streams.video[0].codec_context.name)', previewFile], { encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(previewCodec, 'h264');
    const readyPreview = await request(port, 'GET', `/api/episodes/${assetIds[0]}/preview/status`, null, cookie);
    assert.equal(readyPreview.body.status, 'ready');
    const sourceVideo = await request(port, 'GET', `/api/episodes/${assetIds[0]}/source-video`, null, cookie);
    assert.equal(sourceVideo.status, 200);
    assert.ok(sourceVideo.body.length > 0);
    const qc = await request(port, 'POST', '/api/qc/run', { scope: '全部数据', template: '标准质检', targetIds: assetIds }, cookie);
    assert.equal(qc.status, 201, JSON.stringify(qc.body));
    assert.equal(qc.body.assets[0].status, '已通过', JSON.stringify(qc.body.batch.results));
    const generated = await request(port, 'POST', '/api/annotations/generate', {}, cookie);
    assert.equal(generated.status, 201);
    assert.equal(generated.body.annotations.length, 1);
    const instruction = 'insert the cable connector into the matching socket', saved = await request(port, 'POST', '/api/annotations/standard', { bundleId, action: 'save', instruction }, cookie);
    assert.equal(saved.status, 200);
    assert.equal((await request(port, 'POST', '/api/annotations/batch', { groupKeys: [bundleId] }, cookie)).status, 200);
    assert.equal((await request(port, 'POST', '/api/annotations/standard', { bundleId, action: 'approve', instruction, note: 'QA approved' }, cookie)).status, 200);
    assert.equal((await request(port, 'POST', '/api/bundles/status', { id: bundleId, status: '待验收', note: 'ready' }, cookie)).status, 200);
    assert.equal((await request(port, 'POST', '/api/bundles/status', { id: bundleId, status: '已验收', note: 'accepted' }, cookie)).status, 200);
    const exported = await request(port, 'POST', '/api/exports', { name: 'UMI-Release', bundleId, format: 'LeRobot v3.0' }, cookie);
    assert.equal(exported.status, 201, JSON.stringify(exported.body));
    const job = exported.body.job;
    assert.equal(job.trainingReady, true);
    assert.equal(job.baseFormat, 'TeleUMI session');
    assert.equal(job.formatVersion, 'v3.0');
    assert.equal(job.conversions.lerobot.officialVerification.status, 'passed');
    assert.equal(job.conversions.lerobot.officialVerification.officialLerobotVersion, '0.4.4');
    assert.equal(job.conversions.lerobot.independentVerification.officialVerification, 'passed');
    const download = await request(port, 'GET', `/api/exports/${job.id}/package?format=lerobot`, null, cookie);
    assert.equal(download.status, 200);
    assert.ok(download.body.length > 0);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
