const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

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

test('server directory import aggregates HDF5 frame files into episodes', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf5-import-api-'));
  const dataDir = path.join(fixture, 'work');
  const source = path.join(fixture, 'matching_cable');
  for (const [episode, count] of [['68', 3], ['69', 2]]) {
    fs.mkdirSync(path.join(source, episode), { recursive: true });
    for (let index = 0; index < count; index++) fs.writeFileSync(path.join(source, episode, `${index}.hdf5`), Buffer.from(`frame-${episode}-${index}`));
  }
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'serve.js')], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_WORK_DIR: dataDir },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await request(port, 'GET', '/api/auth/status')).status === 200) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const setup = await request(port, 'POST', '/api/auth/setup', { name: 'QA', email: 'qa@example.invalid', password: 'TestPass12345' });
    assert.equal(setup.status, 201);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const imported = await request(port, 'POST', '/api/imports/server-directory', { rootPath: `"${fixture}"`, bundleName: 'matching-cable', type: '遥操', preset: 'hdf5-sequence' }, cookie);
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.scan.episodeCount, 2);
    assert.equal(imported.body.scan.fileCount, 5);
    assert.equal(imported.body.assets.length, 2);
    assert.deepEqual(imported.body.assets.map(asset => asset.name), ['68', '69']);
    assert.ok(imported.body.assets.every(asset => asset.format === 'HDF5_SEQUENCE' && asset.serverFile.mode === 'external-hdf5-sequence'));
    assert.ok(imported.body.assets.every(asset => asset.serverFile.provenanceVersion === 'content-sha256-v1' && /^[a-f0-9]{64}$/.test(asset.serverFile.sha256)));
    assert.equal(imported.body.bundle.episodeCount, 2);
    assert.equal(imported.body.bundle.episodeMediaPending, 0);
    assert.equal(imported.body.createdCount, 2);
    assert.equal(imported.body.existingCount, 0);
    const repeated = await request(port, 'POST', '/api/imports/server-directory', { rootPath: source, bundleName: 'matching-cable', type: '遥操', preset: 'hdf5-sequence' }, cookie);
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    assert.equal(repeated.body.createdCount, 0);
    assert.equal(repeated.body.existingCount, 2);
    assert.equal(repeated.body.scan.episodeCount, 2);
    assert.deepEqual(repeated.body.assets.map(asset => asset.name), ['68', '69']);
    assert.equal(repeated.body.bundleId, imported.body.bundleId);
    const changedFrame = path.join(source, '68', '0.hdf5'), frameStat = fs.statSync(changedFrame), originalBytes = fs.readFileSync(changedFrame);
    fs.writeFileSync(changedFrame, Buffer.alloc(originalBytes.length, 90));
    fs.utimesSync(changedFrame, frameStat.atime, frameStat.mtime);
    const changed = await request(port, 'POST', '/api/imports/server-directory', { rootPath: source, bundleName: 'matching-cable', type: '遥操', preset: 'hdf5-sequence' }, cookie);
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.match(changed.body.error, /内容哈希不一致/);
    const listed = await request(port, 'GET', '/api/assets', null, cookie);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.assets.length, 2);
    const manifests = fs.readdirSync(path.join(dataDir, 'uploads')).filter(name => name.endsWith('-sequence.json'));
    assert.equal(manifests.length, 2);
    assert.equal(fs.readdirSync(path.join(dataDir, 'uploads'), { recursive: true }).filter(name => /\.hdf5$/i.test(String(name))).length, 0);
    const rejected = await request(port, 'POST', '/api/assets/batch', { assets: Array.from({ length: 201 }, (_, index) => ({ id: `A-${index}`, name: `${index}.hdf5`, format: 'HDF5', type: '遥操' })) }, cookie);
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /服务端目录导入/);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
