const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

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
