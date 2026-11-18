const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'assets', 'extensions.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'serve.js'), 'utf8');

test('task center exposes guarded task deletion and worker-based QC preparation', () => {
  assert.match(ui, /data-task-delete=/);
  assert.match(ui, /确认|confirm\(/);
  assert.match(server, /deleteTaskRoute/);
  assert.match(server, /不能只删除任务记录/);
  assert.match(server, /prepareInspectionManifest/);
  assert.ok(fs.existsSync(path.join(root, 'tools', 'inspection-manifest-worker.cjs')));
  assert.match(server, /正在读取源文件清单/);
});
