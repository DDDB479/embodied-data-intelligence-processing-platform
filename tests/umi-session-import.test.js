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
    const payload = body == null ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createSession(directory, name, frameCount) {
  const base = path.join(directory, name);
  write(path.join(base, 'Metadata', 'ui_backend_metadata.json'), JSON.stringify({ session_id: name, task_name: 'cable assembly', hand_mode: 'single', quality_status: 'pass', can_process: true, capture_status: 'completed' }));
  write(path.join(base, 'single_hand', 'Metadata', 'metadata.json'), JSON.stringify({ config: { project_config_snapshot: { capture: { task_name: 'cable assembly' } } } }));
  write(path.join(base, 'single_hand', 'Metadata', 'pc_metadata.json'), '{}');
  write(path.join(base, 'single_hand', 'Metadata', 'pc_joint_metadata.json'), '{}');
  const timestamps = ['frame_id,timestamp_ns', ...Array.from({ length: frameCount }, (_, index) => `${index},${index * 25000000}`)].join('\n');
  const vive = ['timestamp_ns,vut_monotonic_ns,device_id,serial,state,x_m,y_m,z_m,qx,qy,qz,qw,vx_mps,vy_mps,vz_mps,wx_radps,wy_radps,wz_radps,flags', ...Array.from({ length: frameCount * 3 }, (_, index) => `${index * 8333333},0,1,test,2,${index / 1000},0,0,0,0,0,1,0,0,0,0,0,0,0`)].join('\n');
  const clamp = ['sample_id,timestamp_ns,monotonic_ns,value', ...Array.from({ length: frameCount * 1.5 }, (_, index) => `${index},${index * 16666666},0,${50 + index % 10}`)].join('\n');
  write(path.join(base, 'single_hand', 'RGB_Images', 'timestamps.csv'), timestamps);
  write(path.join(base, 'single_hand', 'RGB_Images', 'video.mp4'), Buffer.from('test-video'));
  write(path.join(base, 'single_hand', 'Merged_Trajectory', 'merged_trajectory.txt'), Array.from({ length: frameCount }, (_, index) => `${index / 40} 0 0 0 0 0 0 1`).join('\n'));
  write(path.join(base, 'single_hand', 'Merged_Trajectory', 'vut_raw.csv'), vive);
  write(path.join(base, 'single_hand', 'Clamp_Data', 'clamp_timebase.csv'), clamp);
  write(path.join(base, 'single_hand', 'Clamp_Data', 'clamp_data_tum.txt'), '0 0 0 0');
  write(path.join(base, 'Logs', 'capture.log'), 'ok');
  write(path.join(base, 'control', 'stop.flag'), 'done');
}

test('server directory import aggregates UMI sessions and remains idempotent', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'umi-session-import-'));
  const dataDir = path.join(fixture, 'work');
  const source = path.join(fixture, '5-umi-sessions');
  createSession(source, 'session_00001', 4);
  createSession(source, 'session_00002', 5);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'serve.js')], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_WORK_DIR: dataDir }, stdio: 'ignore', windowsHide: true,
  });
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await request(port, 'GET', '/api/auth/status')).status === 200) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const setup = await request(port, 'POST', '/api/auth/setup', { name: 'QA', email: 'umi@example.invalid', password: 'TestPass12345' });
    assert.equal(setup.status, 201);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const imported = await request(port, 'POST', '/api/imports/server-directory', { rootPath: source, bundleName: 'umi-test', type: '遥操', preset: 'auto' }, cookie);
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.scan.mode, 'umi-session');
    assert.equal(imported.body.scan.sessionCount, 2);
    assert.equal(imported.body.scan.frameCount, 9);
    assert.deepEqual(imported.body.assets.map(asset => asset.name), ['session_00001', 'session_00002']);
    assert.ok(imported.body.assets.every(asset => asset.format === 'UMI_SESSION' && asset.serverFile.mode === 'external-umi-session'));
    assert.equal(imported.body.bundle.preset, 'umi-session');
    assert.equal(imported.body.bundle.episodeCount, 2);
    const repeated = await request(port, 'POST', '/api/imports/server-directory', { rootPath: source, bundleName: 'umi-test', type: '遥操', preset: 'auto' }, cookie);
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    assert.equal(repeated.body.createdCount, 0);
    assert.equal(repeated.body.existingCount, 2);
    assert.equal(repeated.body.bundleId, imported.body.bundleId);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
