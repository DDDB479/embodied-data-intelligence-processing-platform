const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const python = process.env.LEROBOT_PYTHON || path.join(root, 'runtime', 'python', 'Scripts', 'python.exe');

test('V6 converts one accepted batch to three verified downloadable formats', { skip: !fs.existsSync(python) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-api-'));
  let child;
  try {
    execFileSync(python, ['-c', 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from test_delivery_convert import fixture; fixture(Path(sys.argv[2]))', path.join(root, 'tests'), dir], { windowsHide: true });
    const source = path.join(dir, 'source'), uploads = path.join(dir, 'uploads');
    fs.mkdirSync(uploads);
    const assets = fs.readdirSync(source, { recursive: true }).filter(name => fs.statSync(path.join(source, name)).isFile()).map((name, index) => {
      const relativePath = name.replaceAll('\\', '/'), filename = path.basename(name), data = fs.readFileSync(path.join(source, name));
      const storedName = `asset-${index}.bin`; fs.writeFileSync(path.join(uploads, storedName), data);
      const role = relativePath.startsWith('data/') ? 'trajectory' : relativePath.startsWith('videos/') ? 'media' : 'meta';
      return { id: `AST-${index}`, name: filename, bundleId: 'B-DELIVERY', bundleName: 'test-batch', bundleRole: role, relativePath, type: '遥操', format: path.extname(name).slice(1).toUpperCase(), status: '已通过', score: 100, lastQcAt: new Date().toISOString(), serverFile: { storedName, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }, ...(role === 'trajectory' ? { inspection: { lerobotSchema: { status: 'verified', issues: [] } } } : {}) };
    });
    fs.writeFileSync(path.join(dir, 'server-state.json'), JSON.stringify({ assets, bundles: [{ id: 'B-DELIVERY', status: '已验收', gateVersion: 'episode-v2' }], annotationStandards: { 'B-DELIVERY': { instruction: 'approved task', status: '已通过', reviewedAt: new Date().toISOString(), reviewer: 'QA' } } }));
    const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    child = spawn(process.execPath, [path.join(root, 'serve.js')], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_WORK_DIR: dir, LEROBOT_PYTHON: python }, stdio: 'ignore', windowsHide: true });
    function request(method, route, body, cookie = '') {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : '';
        const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
          const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const buffer = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: String(res.headers['content-type']).includes('application/json') ? JSON.parse(buffer) : buffer }); });
        }); req.on('error', reject); req.end(payload);
      });
    }
    for (let i = 0; i < 50; i++) { try { if ((await request('GET', '/api/auth/status')).status === 200) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    for (const name of ['/work/auth.json', '/work/server-state.json', '/.git/config']) assert.equal((await request('GET', name)).status, 404);
    const setup = await request('POST', '/api/auth/setup', { name: 'QA', email: 'qa@example.invalid', password: 'TestPass12345' });
    assert.equal(setup.status, 201);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const created = await request('POST', '/api/exports', { name: 'Delivery', bundleId: 'B-DELIVERY' }, cookie);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.job.id;
    assert.equal((await request('POST', '/api/exports/convert', { id, format: 'mcap' })).status, 401);
    assert.equal((await request('POST', '/api/exports/convert', { id, format: 'mcp' }, cookie)).status, 400);
    for (const format of ['mcap', 'zarr', 'lerobot']) {
      const converted = await request('POST', '/api/exports/convert', { id, format }, cookie);
      assert.equal(converted.status, 201, JSON.stringify(converted.body));
      const output = converted.body.job.conversions[format];
      assert.equal(output.ok, true); assert.equal(output.frames, 6); assert.equal(output.episodes, 2);
      assert.equal(converted.body.exports.length, 1);
      const download = await request('GET', `/api/exports/${id}/package?format=${format}`, null, cookie);
      assert.equal(download.status, 200);
      assert.equal(crypto.createHash('sha256').update(download.body).digest('hex'), output.archiveSha256);
      const duplicate = await request('POST', '/api/exports/convert', { id, format }, cookie);
      assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
    }
    assert.equal((await request('GET', `/api/exports/${id}/package?format=mcap`)).status, 401);
    const member = await request('POST', '/api/members', { name: 'Viewer', email: 'viewer@example.invalid', role: '采集运维', domain: '遥操', password: 'ViewerPass12345' }, cookie);
    assert.equal(member.status, 201);
    const login = await request('POST', '/api/auth/login', { email: 'viewer@example.invalid', password: 'ViewerPass12345' });
    const viewerCookie = login.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request('POST', '/api/exports/convert', { id, format: 'mcap' }, viewerCookie)).status, 403);
    assert.equal((await request('GET', `/api/exports/${id}/package?format=mcap`, null, viewerCookie)).status, 403);
    // A changed approved instruction invalidates the older downloadable output.
    const stateFile = path.join(dir, 'server-state.json');
    const revised = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    revised.annotationStandards['B-DELIVERY'].instruction = 'revised approved task';
    fs.writeFileSync(stateFile, JSON.stringify(revised));
    assert.equal((await request('GET', `/api/exports/${id}/package?format=mcap`, null, cookie)).status, 409);
    assert.equal((await request('GET', '/api/exports', null, cookie)).body.exports[0].conversions.mcap.current, false);
    const regenerated = await request('POST', '/api/exports/convert', { id, format: 'mcap' }, cookie);
    assert.equal(regenerated.status, 201, JSON.stringify(regenerated.body));
    assert.equal((await request('GET', `/api/exports/${id}/package?format=mcap`, null, cookie)).status, 200);
    // Replacing a source file requires rebuilding the canonical delivery snapshot.
    const replaced = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const originalHash = replaced.assets[0].serverFile.sha256;
    replaced.assets[0].serverFile.sha256 = 'changed-source-hash';
    fs.writeFileSync(stateFile, JSON.stringify(replaced));
    assert.equal((await request('POST', '/api/exports/convert', { id, format: 'mcap' }, cookie)).status, 409);
    replaced.assets[0].serverFile.sha256 = originalHash;
    fs.writeFileSync(stateFile, JSON.stringify(replaced));
    if (process.env.DELIVERY_UI_PREVIEW === '1') {
      // Test-only proxy exposes this disposable fixture, never production state.
      const preview = http.createServer((req, res) => {
        const upstream = http.request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}`, cookie } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
        upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
      });
      await new Promise(resolve => preview.listen(4186, '127.0.0.1', resolve));
      console.log('Disposable UI fixture: http://127.0.0.1:4186/ ; send a newline to close.');
      process.stdin.resume();
      await new Promise(resolve => { const timer = setTimeout(resolve, 300000); timer.unref(); process.stdin.once('data', () => { clearTimeout(timer); resolve(); }); });
      process.stdin.pause();
      await new Promise(resolve => preview.close(resolve));
    }
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
