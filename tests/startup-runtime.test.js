const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('Windows startup path uses hidden Node processes without PowerShell', () => {
  const batch = read('启动平台.bat');
  const bootstrap = read('启动平台自动启动.vbs');
  const startupFiles = [batch, bootstrap, read('platform-launcher.cjs'), read('platform-service.cjs')];

  for (const source of startupFiles) {
    assert.doesNotMatch(source, /powershell|pwsh|platform-(?:launcher|service)\.ps1/i);
  }
  assert.match(batch, /wscript\.exe/i);
  assert.match(bootstrap, /runtime\\node\.exe/i);
  assert.match(bootstrap, /platform-launcher\.cjs/i);
  assert.match(bootstrap, /,\s*0,\s*False/i);
  assert.equal(fs.existsSync(path.join(root, 'platform-launcher.ps1')), false);
  assert.equal(fs.existsSync(path.join(root, 'platform-service.ps1')), false);
});
