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
    const payload = body ? JSON.stringify(body) : '';
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

test('HDF5 episode import, QC, annotation and LeRobot v3 delivery close the loop', { timeout: 120000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf5-delivery-api-'));
  const dataDir = path.join(fixture, 'work');
  const sourceRoot = path.join(fixture, 'matching_cable');
  const source = path.join(sourceRoot, '68');
  fs.mkdirSync(source, { recursive: true });
  const createFrames = String.raw`
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from test_production_check import encoded_image, write_hdf5_episode
root = Path(sys.argv[2])
rgb = encoded_image(root, 'frame.jpg', 'mjpeg', 'yuvj420p', 'rgb24')
depth = encoded_image(root, 'depth.png', 'png', 'gray', 'gray')
for index, timestamp in enumerate([0, 50, 100]):
    write_hdf5_episode(root / 'matching_cable' / '68', f'{index}.hdf5', timestamp, rgb, depth)
`;
  execFileSync(python, ['-c', createFrames, path.join(root, 'tests'), fixture], { windowsHide: true });
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'serve.js')], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_WORK_DIR: dataDir, LEROBOT_PYTHON: python, LEROBOT_OFFICIAL_PYTHON: officialPython },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await request(port, 'GET', '/api/auth/status')).status === 200) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const setup = await request(port, 'POST', '/api/auth/setup', { name: 'QA', email: 'qa@example.invalid', password: 'TestPass12345' });
    assert.equal(setup.status, 201);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const imported = await request(port, 'POST', '/api/imports/server-directory', { rootPath: sourceRoot, bundleName: 'hdf5-sequence', type: '遥操', preset: 'hdf5-sequence' }, cookie);
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const bundleId = imported.body.bundleId;
    const assetIds = imported.body.assets.map(asset => asset.id);
    const previewJob = await request(port, 'POST', '/api/jobs', { kind: 'preview', payload: { assetId: assetIds[0] } }, cookie);
    assert.equal(previewJob.status, 202, JSON.stringify(previewJob.body));
    let previewResult;
    for (let attempt = 0; attempt < 120; attempt++) {
      const jobs = await request(port, 'GET', '/api/jobs', null, cookie);
      previewResult = jobs.body.jobs.find(job => job.id === previewJob.body.job.id);
      if (previewResult && ['succeeded', 'failed'].includes(previewResult.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(previewResult.status, 'succeeded', JSON.stringify(previewResult));
    assert.equal(previewResult.completed, 3);
    const previewStatus = await request(port, 'GET', `/api/episodes/${assetIds[0]}/preview/status`, null, cookie);
    assert.equal(previewStatus.status, 200);
    assert.equal(previewStatus.body.status, 'ready');
    assert.equal(previewStatus.body.preview.cameras.length, 4);
    const previewVideo = await request(port, 'GET', `/api/episodes/${assetIds[0]}/preview/camera_0.mp4`, null, cookie);
    assert.equal(previewVideo.status, 200);
    assert.equal(previewVideo.headers['accept-ranges'], 'bytes');
    assert.ok(previewVideo.body.length > 0);
    const previewThumb = await request(port, 'GET', `/api/episodes/${assetIds[0]}/preview/middle.jpg`, null, cookie);
    assert.equal(previewThumb.status, 200);
    assert.equal(previewThumb.headers['content-type'], 'image/jpeg');
    const qc = await request(port, 'POST', '/api/qc/run', { scope: '全部数据', template: '标准质检', targetIds: assetIds }, cookie);
    assert.equal(qc.status, 201, JSON.stringify(qc.body));
    assert.equal(qc.body.assets[0].status, '已通过');
    const generated = await request(port, 'POST', '/api/annotations/generate', {}, cookie);
    assert.equal(generated.status, 201);
    assert.equal(generated.body.annotations.length, 1);
    const instruction = 'insert the red cable connector into the matching socket';
    const saved = await request(port, 'POST', '/api/annotations/standard', { bundleId, action: 'save', instruction }, cookie);
    assert.equal(saved.status, 200);
    const submitted = await request(port, 'POST', '/api/annotations/batch', { groupKeys: [bundleId] }, cookie);
    assert.equal(submitted.status, 200);
    const approved = await request(port, 'POST', '/api/annotations/standard', { bundleId, action: 'approve', instruction, note: 'QA approved' }, cookie);
    assert.equal(approved.status, 200);
    assert.equal((await request(port, 'POST', '/api/bundles/status', { id: bundleId, status: '待验收', note: 'ready' }, cookie)).status, 200);
    assert.equal((await request(port, 'POST', '/api/bundles/status', { id: bundleId, status: '已验收', note: 'accepted' }, cookie)).status, 200);
    const exported = await request(port, 'POST', '/api/exports', { name: 'HDF5-Sequence-Release', bundleId, format: 'LeRobot v3.0' }, cookie);
    assert.equal(exported.status, 201, JSON.stringify(exported.body));
    const job = exported.body.job;
    assert.equal(job.trainingReady, true);
    assert.equal(job.baseFormat, 'HDF5 frame sequence');
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
