const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const python = path.join(root, 'runtime/python/Scripts/python.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real import, restart resume, missing-video repair, annotation, acceptance and queued delivery', { skip: !fs.existsSync(python), timeout: 120000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'production-api-'));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`; let child, cookie = '';
  async function call(route, body, method = 'POST', custom = {}) {
    const response = await fetch(base + route, { method, headers: { Cookie: cookie, 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...custom }, ...(method === 'GET' ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {}) }) });
    const data = await response.json(); return { status: response.status, data, headers: response.headers };
  }
  async function start() {
    child = spawn(process.execPath, [path.join(root, 'serve.js')], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_WORK_DIR: directory, LEROBOT_PYTHON: python } });
    for (let i = 0; i < 60; i++) { try { if ((await call('/health', null, 'GET')).status === 200) return; } catch {} await pause(100); }
    throw new Error('isolated service did not start');
  }
  async function stop() { if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } }
  async function job(kind, payload) {
    const submitted = await call('/api/jobs', { kind, payload }); assert.equal(submitted.status, 202, JSON.stringify(submitted.data));
    for (let i = 0; i < 500; i++) {
      const jobs = await call('/api/jobs', null, 'GET'), current = jobs.data.jobs.find(item => item.id === submitted.data.job.id);
      if (current.status === 'succeeded') return current;
      if (['failed', 'interrupted'].includes(current.status)) throw new Error(`${kind}: ${current.error}`);
      await pause(100);
    }
    throw new Error('job timeout');
  }
  const ids = []; let serial = 0;
  async function upload(relativePath, bytes, interrupt = false) {
    const id = `AST-PRODUCTION-${serial++}`, name = path.basename(relativePath);
    const metadata = await call('/api/assets', { id, name, bundleId: 'B-PRODUCTION', bundleName: 'Disposable production test', relativePath, bundleRole: relativePath.startsWith('data/') ? 'trajectory' : relativePath.startsWith('videos/') ? 'media' : 'meta', type: '遥操', format: path.extname(name).slice(1).toUpperCase(), inspection: { production: { sha256: 'forged-proof' } } });
    assert.equal(metadata.status, 201, JSON.stringify(metadata.data));
    assert.equal(metadata.data.asset.inspection?.production, undefined, 'browser cannot fabricate server evidence');
    let session = await call('/api/uploads', { assetId: id, name, size: bytes.length, key: crypto.createHash('sha256').update(relativePath).digest('hex') }); assert.equal(session.status, 201, JSON.stringify(session.data));
    if (interrupt) { await stop(); await start(); session = await call(`/api/uploads/${session.data.upload.id}`, null, 'GET'); assert.equal(session.status, 200); }
    const part = await call(`/api/uploads/${session.data.upload.id}`, bytes, 'PATCH', { 'Upload-Offset': '0' }); assert.equal(part.status, 200, JSON.stringify(part.data));
    const completed = await call(`/api/uploads/${session.data.upload.id}/complete`, {}); assert.equal(completed.status, 201, JSON.stringify(completed.data));
    ids.push(id); return id;
  }
  try {
    execFileSync(python, ['-X', 'utf8', '-c', 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from test_delivery_convert import fixture; fixture(Path(sys.argv[2]))', path.join(root, 'tests'), directory], { windowsHide: true });
    execFileSync(python, ['-X', 'utf8', '-c', [
      'import av, numpy as np, sys',
      'with av.open(sys.argv[1], "w") as output:',
      ' stream=output.add_stream("mpeg4",rate=20); stream.width=640; stream.height=480; stream.pix_fmt="yuv420p"',
      ' for i in range(3):',
      '  frame=av.VideoFrame.from_ndarray(np.zeros((480,640,3),dtype=np.uint8),format="rgb24")',
      '  for packet in stream.encode(frame): output.mux(packet)',
      ' for packet in stream.encode(): output.mux(packet)',
    ].join('\n'), path.join(directory, 'source/videos/chunk-000/observation.images.head/episode_000000.mp4')], { windowsHide: true });
    await start();
    const duplicateService = spawn(process.execPath, [path.join(root, 'serve.js')], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', PORT: String(port + 1), DATA_WORK_DIR: directory } });
    const duplicateExit = await new Promise(resolve => { const timer = setTimeout(() => { duplicateService.kill(); resolve(null); }, 5000); duplicateService.once('exit', code => { clearTimeout(timer); resolve(code); }); });
    assert.equal(duplicateExit, 1, 'a second server must not take over the same database queue');
    const setup = await call('/api/auth/setup', { name: 'Producer', email: 'producer@example.invalid', password: 'TestPass12345' }); assert.equal(setup.status, 201); cookie = setup.headers.get('set-cookie').split(';')[0];
    const source = path.join(directory, 'source'), missing = 'videos/chunk-000/observation.images.head/episode_000001.mp4';
    const files = fs.readdirSync(source, { recursive: true }).filter(name => fs.statSync(path.join(source, name)).isFile()).map(name => name.replaceAll('\\', '/'));
    for (const relative of files.filter(name => name !== missing)) await upload(relative, fs.readFileSync(path.join(source, relative)), ids.length === 0);
    await job('quality', { scope: '全部数据', targetIds: ids });
    let state = (await call('/api/state', null, 'GET')).data;
    const missingIssues = state.issues.filter(issue => issue.status !== '已关闭');
    assert.ok(missingIssues.some(issue => /缺少|缺失/.test(issue.detail)), JSON.stringify(missingIssues));
    const candidate = missingIssues.find(issue => issue.locations?.some(location => location.code === 'black_frames'));
    assert.ok(candidate, 'real black frames must produce reviewable evidence');
    assert.equal((await call('/api/issues/review-media', { id: candidate.id, note: '通过' })).status, 400);
    assert.equal((await call('/api/issues/review-media', { id: candidate.id, note: '已逐帧查看本测试片段，此处黑屏为测试任务预期输出' })).status, 200);
    assert.notEqual((await call('/api/bundles/status', { id: 'B-PRODUCTION', status: '待验收' })).status, 200);
    await upload(missing, fs.readFileSync(path.join(source, missing)));
    await job('quality', { scope: '全部数据', targetIds: ids });
    state = (await call('/api/state', null, 'GET')).data;
    assert.equal(state.issues.filter(issue => issue.status !== '已关闭').length, 0, JSON.stringify(state.issues));
    assert.ok(missingIssues.every(issue => state.issues.find(item => item.id === issue.id)?.verification?.verified));
    assert.ok(state.assets.every(asset => asset.status === '已通过'), JSON.stringify(state.qcBatches[0].results));
    assert.equal((await call('/api/annotations/generate', {})).status, 201);
    const submit = await call('/api/annotations/standard', { groupKey: 'B-PRODUCTION', instruction: '插接连接器', action: 'submit' }); assert.equal(submit.status, 200, JSON.stringify(submit.data));
    assert.notEqual((await call('/api/bundles/status', { id: 'B-PRODUCTION', status: '待验收' })).status, 200, 'unreviewed annotations cannot pass');
    const member = await call('/api/members', { name: 'Reviewer', email: 'reviewer@example.invalid', role: '标注审核员', domain: '遥操', password: 'ReviewPass12345' }); assert.equal(member.status, 201);
    const ownerCookie = cookie;
    const login = await call('/api/auth/login', { email: 'reviewer@example.invalid', password: 'ReviewPass12345' }); cookie = login.headers.get('set-cookie').split(';')[0];
    const approved = await call('/api/annotations/standard', { groupKey: 'B-PRODUCTION', action: 'approve' }); assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal((await call('/api/jobs', { kind: 'backup', payload: {} })).status, 403);
    cookie = ownerCookie;
    for (const status of ['待验收', '已验收']) { const response = await call('/api/bundles/status', { id: 'B-PRODUCTION', status }); assert.equal(response.status, 200, JSON.stringify(response.data)); }
    assert.equal((await call('/api/assets', { id: ids[0], name: 'changed.json', bundleId: 'B-PRODUCTION', type: '遥操' })).status, 409, 'accepted batch content must remain frozen');
    const delivery = await job('delivery', { name: 'Production delivery', bundleId: 'B-PRODUCTION' });
    assert.ok(delivery.result.exportId);
    await job('convert', { id: delivery.result.exportId, format: 'mcap' });
    const download = await fetch(base + `/api/exports/${delivery.result.exportId}/package?format=mcap`, { headers: { Cookie: cookie } }); assert.equal(download.status, 200);
    const report = (await call('/api/health/details', null, 'GET')); assert.equal(report.status, 200);
  } finally { await stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});
