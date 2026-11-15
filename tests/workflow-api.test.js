const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const python = path.join(root, 'runtime', 'python', 'Scripts', 'python.exe');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function request(port, method, route, body, cookie = '') {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function uploadFile(port, id, name, bytes, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: `/api/assets/${id}/content`, method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'X-File-Name': name } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(bytes);
  });
}

function requestBytes(port, method, route, bytes, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(bytes);
  });
}

test('HTTP API rejects fabricated QC and completion state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embodied-api-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'serve.js')], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_WORK_DIR: dir },
    stdio: 'ignore', windowsHide: true,
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { ready = (await request(port, 'GET', '/health')).status === 200; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'isolated server did not start');
    const setup = await request(port, 'POST', '/api/auth/setup', { name: 'QA', email: 'qa@example.invalid', password: 'TestPass12345' });
    assert.equal(setup.status, 201);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];

    const capabilities = await request(port, 'GET', '/api/engine/capabilities', null, cookie);
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.engine, 'evidence-v3-embodied');
    assert.deepEqual(capabilities.body.operators.map(operator => operator.id), ['sync', 'clean', 'compliance', 'perception', 'label', 'export']);
    assert.ok(['optional', 'available'].includes(capabilities.body.operators.find(operator => operator.id === 'perception').status));
    assert.deepEqual(capabilities.body.workflowStages.map(stage => stage.id), ['import', 'clean', 'select', 'annotate', 'review', 'quality', 'convert', 'deliver']);

    const asset = await request(port, 'POST', '/api/assets', { id: 'AST-QA-1', name: 'episode_000000.parquet', type: '遥操', status: '已通过', score: 100, lastQcAt: '2099-01-01' }, cookie);
    assert.equal(asset.status, 201);
    assert.equal(asset.body.asset.status, '待质检');
    assert.equal(asset.body.asset.score, 0);
    assert.equal(asset.body.asset.lastQcAt, '');
    const started = await request(port, 'POST', '/api/uploads', { assetId: 'AST-QA-1', name: 'interrupt.bin', size: 1024, key: 'a'.repeat(64) }, cookie);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const uploadId = `UP-${started.body.upload.id}`;
    let jobs = await request(port, 'GET', '/api/jobs', null, cookie);
    assert.equal(jobs.body.jobs.find(job => job.id === uploadId).status, 'running');
    assert.equal((await request(port, 'POST', `/api/jobs/${uploadId}/pause`, null, cookie)).status, 200);
    jobs = await request(port, 'GET', '/api/jobs', null, cookie);
    assert.equal(jobs.body.jobs.find(job => job.id === uploadId).status, 'paused');
    assert.equal((await request(port, 'POST', `/api/jobs/${uploadId}/resume`, null, cookie)).status, 200);
    assert.equal((await request(port, 'DELETE', `/api/jobs/${uploadId}`, null, cookie)).status, 200);
    jobs = await request(port, 'GET', '/api/jobs', null, cookie);
    assert.equal(jobs.body.jobs.some(job => job.id === uploadId), false);
    const batchAssets = await request(port, 'POST', '/api/assets/batch', { bundleId: 'B-BATCH', assets: [
      { id: 'AST-BATCH-1', name: 'one.bin', type: '遥操', bundleId: 'B-BATCH', bundleName: 'Batch', bundleRole: 'trajectory', relativePath: 'batch/one.bin' },
      { id: 'AST-BATCH-2', name: 'two.bin', type: '遥操', bundleId: 'B-BATCH', bundleName: 'Batch', bundleRole: 'media', relativePath: 'batch/two.bin' },
    ] }, cookie);
    assert.equal(batchAssets.status, 201, JSON.stringify(batchAssets.body));
    assert.equal(batchAssets.body.assets.length, 2);
    const compactBatch = await request(port, 'POST', '/api/assets/batch', { bundleId: 'B-BATCH', compact: true, assets: [
      { id: 'AST-BATCH-1', name: 'one.bin', type: '遥操', bundleId: 'B-BATCH', bundleName: 'Batch', bundleRole: 'trajectory', relativePath: 'batch/one.bin' },
      { id: 'AST-BATCH-2', name: 'two.bin', type: '遥操', bundleId: 'B-BATCH', bundleName: 'Batch', bundleRole: 'media', relativePath: 'batch/two.bin' },
    ] }, cookie);
    assert.equal(compactBatch.status, 201, JSON.stringify(compactBatch.body));
    assert.equal(compactBatch.body.assetCount, 2);
    assert.equal(compactBatch.body.assets, undefined);
    assert.equal((await request(port, 'GET', '/api/state', null, cookie)).body.assets.filter(asset => asset.bundleId === 'B-BATCH').length, 2);
    const batchBytes = [Buffer.alloc(1024 * 1024, 67), Buffer.alloc(1024 * 1024, 68)], batchSessions = [];
    const startedBatch = await request(port, 'POST', '/api/uploads/batch-start', { files: batchBytes.map((bytes, index) => ({
      assetId: `AST-BATCH-${index + 1}`, name: `${index + 1}.bin`, size: bytes.length, key: crypto.createHash('sha256').update(`AST-BATCH-${index + 1}-key`).digest('hex'),
    })) }, cookie);
    assert.equal(startedBatch.status, 201, JSON.stringify(startedBatch.body));
    assert.equal(startedBatch.body.uploads.length, 2);
    for (let index = 0; index < 2; index++) {
      const bytes = batchBytes[index], upload = startedBatch.body.uploads.find(item => item.assetId === `AST-BATCH-${index + 1}`);
      batchSessions.push(upload.id);
      const appended = await requestBytes(port, 'PATCH', `/api/uploads/${upload.id}`, bytes, { Cookie: cookie, 'Upload-Offset': '0' });
      assert.equal(appended.status, 200, JSON.stringify(appended.body));
    }
    const completedBatch = await request(port, 'POST', '/api/uploads/complete-batch', { sessionIds: batchSessions }, cookie);
    assert.equal(completedBatch.status, 200, JSON.stringify(completedBatch.body));
    assert.equal(completedBatch.body.assets.length, 2);
    assert.ok(completedBatch.body.assets.every(asset => asset.serverFile?.size === 1024 * 1024));

    const fakeQc = await request(port, 'POST', '/api/qc', { id: 'QC-FAKE', results: [] }, cookie);
    assert.equal(fakeQc.status, 410);
    const fakeTraining = await request(port, 'POST', '/api/training', { name: '虚拟训练', datasetId: 'DS-1' }, cookie);
    assert.equal(fakeTraining.status, 410);
    const task = await request(port, 'POST', '/api/tasks', { id: 'TASK-QA-1', name: '测试任务', scene: '测试', type: '遥操', targetCount: 1, acceptanceScore: 90, status: '已完成', acceptedBy: '伪造' }, cookie);
    assert.equal(task.status, 201);
    assert.equal(task.body.task.status, '待启动');
    assert.equal(task.body.task.acceptedBy, undefined);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    assert.equal(path.dirname(dir), os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HDF5 QC separates capability blocking and aggregates repeated issues', { skip: !fs.existsSync(python), timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embodied-hdf5-qc-'));
  const session = path.join(dir, 'session'); fs.mkdirSync(session);
  const fixture = [
    'import sys',
    'from pathlib import Path',
    "sys.path.insert(0, 'tests')",
    'from test_production_check import encoded_image, write_hdf5_episode',
    'root = Path(sys.argv[1])',
    "rgb = encoded_image(root, 'frame.jpg', 'mjpeg', 'yuvj420p', 'rgb24')",
    "depth = encoded_image(root, 'depth.png', 'png', 'gray', 'gray')",
    "for index, timestamp in enumerate([0, 50, 400]): write_hdf5_episode(root, f'{index}.hdf5', timestamp, rgb, depth)",
  ].join('\n');
  execFileSync(python, ['-c', fixture, session], { cwd: root, windowsHide: true });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'serve.js')], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_WORK_DIR: dir, LEROBOT_PYTHON: python }, stdio: 'ignore', windowsHide: true,
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { ready = (await request(port, 'GET', '/health')).status === 200; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'isolated server did not start');
    const setup = await request(port, 'POST', '/api/auth/setup', { name: 'QA', email: 'hdf5@example.invalid', password: 'TestPass12345' });
    assert.equal(setup.status, 201);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const ids = [];
    for (let index = 0; index < 3; index++) {
      const id = `AST-HDF5-${index}`;
      const metadata = { id, name: `${index}.hdf5`, bundleId: 'B-HDF5', bundleName: 'HDF5 fixture', type: '遥操', format: 'HDF5', bundleRole: 'trajectory', relativePath: `session/${index}.hdf5` };
      assert.equal((await request(port, 'POST', '/api/assets', metadata, cookie)).status, 201);
      const uploaded = await uploadFile(port, id, `${index}.hdf5`, fs.readFileSync(path.join(session, `${index}.hdf5`)), cookie);
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      ids.push(id);
    }
    const unknown = path.join(session, 'unknown.hdf5');
    execFileSync(python, ['-c', "import h5py,sys; f=h5py.File(sys.argv[1],'w'); f.create_dataset('other',data=[1]); f.close()", unknown], { windowsHide: true });
    const unknownId = 'AST-HDF5-UNKNOWN';
    const unknownMetadata = { id: unknownId, name: 'unknown.hdf5', bundleId: 'B-HDF5', bundleName: 'HDF5 fixture', type: '遥操', format: 'HDF5', bundleRole: 'trajectory', relativePath: 'session/unknown.hdf5' };
    assert.equal((await request(port, 'POST', '/api/assets', unknownMetadata, cookie)).status, 201);
    assert.equal((await uploadFile(port, unknownId, 'unknown.hdf5', fs.readFileSync(unknown), cookie)).status, 201);
    ids.push(unknownId);
    const qc = await request(port, 'POST', '/api/qc/run', { scope: '全部数据', template: '标准质检', targetIds: ids }, cookie);
    assert.equal(qc.status, 201, JSON.stringify(qc.body));
    const state = (await request(port, 'GET', '/api/state', null, cookie)).body;
    assert.ok(state.assets.filter(asset => asset.id !== unknownId).every(asset => asset.status === '待深检'));
    assert.equal(state.assets.find(asset => asset.id === unknownId).status, '待质检');
    assert.equal(state.assets.find(asset => asset.id === unknownId).score, null);
    const open = state.issues.filter(issue => issue.status !== '已关闭');
    assert.equal(open.length, 1, JSON.stringify(open));
    assert.equal(open[0].metric, 'HDF5 时序连续性');
    assert.equal(open[0].affectedCount, 3);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
