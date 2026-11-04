const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
function contained(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error('备份路径无效');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('备份路径越界');
  return resolved;
}
async function filesIn(root, relative = '') {
  const files = [];
  for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('备份不接受符号链接');
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(root, name)); else if (entry.isFile()) files.push(name);
  }
  return files;
}
async function backup(store, progress = () => {}) {
  const name = `full-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const parent = path.join(store.directory, 'backups'), staging = path.join(parent, `.${name}.partial`), target = path.join(parent, name);
  await fsp.mkdir(staging, { recursive: true });
  try {
    store.checkpoint(path.join(staging, 'platform.sqlite'));
    const snapshot = new DatabaseSync(path.join(staging, 'platform.sqlite'), { readOnly: true });
    let state;
    try { state = JSON.parse(snapshot.prepare("SELECT data FROM documents WHERE name='state'").get().data); }
    finally { snapshot.close(); }
    const required = [...new Set((state.assets || []).filter(asset => asset.serverFile).map(asset => path.join('uploads', asset.serverFile.storedName)))];
    for (const folder of ['exports', 'deliveries']) {
      const source = path.join(store.directory, folder);
      if (fs.existsSync(source)) required.push(...(await filesIn(source)).map(file => path.join(folder, file)));
    }
    const files = [], total = required.length + 1;
    files.push({ path: 'platform.sqlite', sha256: await digest(path.join(staging, 'platform.sqlite')) });
    let completed = 1;
    for (const relative of required) {
      const source = contained(store.directory, relative), dest = contained(staging, relative);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(source, dest);
      const hash = await digest(dest);
      const asset = (state.assets || []).find(item => item.serverFile && path.join('uploads', item.serverFile.storedName) === relative);
      if (asset?.serverFile.sha256 && asset.serverFile.sha256 !== hash) throw new Error(`原始文件哈希不一致：${asset.name}`);
      files.push({ path: relative.replaceAll('\\', '/'), sha256: hash });
      progress({ completed: ++completed, total, message: `已备份 ${completed}/${total} 个文件` });
    }
    await fsp.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ version: 1, sourceRoot: store.directory, createdAt: new Date().toISOString(), files }, null, 2));
    await verify(staging);
    await fsp.rename(staging, target);
    return { backup: name, fileCount: files.length, verified: true, note: '数据库、账号、原始文件和交付产物已备份并校验；可用离线恢复工具恢复到空目录。' };
  } catch (error) {
    // A partial backup is intentionally retained for diagnosis, never advertised as valid.
    throw new Error(`完整备份未完成：${error.message}`);
  }
}
async function verify(directory) {
  const root = path.resolve(directory), manifest = JSON.parse(await fsp.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.some(item => item.path === 'platform.sqlite')) throw new Error('备份清单无效');
  for (const entry of manifest.files) {
    const file = contained(root, entry.path), stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await digest(file) !== entry.sha256) throw new Error(`备份损坏：${entry.path}`);
  }
  const db = new DatabaseSync(path.join(root, 'platform.sqlite'), { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('备份数据库损坏');
    for (const name of ['state', 'auth', 'jobs', 'uploads']) JSON.parse(db.prepare('SELECT data FROM documents WHERE name=?').get(name).data);
  } finally { db.close(); }
  return manifest;
}
async function restore(source, destination) {
  const manifest = await verify(source), target = path.resolve(destination), origin = path.resolve(source);
  if (target === origin || target.startsWith(origin + path.sep) || origin.startsWith(target + path.sep)) throw new Error('恢复目录不得与备份目录重叠');
  if (fs.existsSync(target) && (await fsp.readdir(target)).length) throw new Error('恢复只允许写入空目录；请保留当前工作目录作为回退。');
  await fsp.mkdir(target, { recursive: true });
  for (const entry of manifest.files) {
    const dest = contained(target, entry.path); await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.copyFile(contained(origin, entry.path), dest);
  }
  // Delivery records hold absolute local paths. Rebase them on the restored work directory.
  const rebase = value => {
    if (typeof value === 'string' && (value === manifest.sourceRoot || value.startsWith(manifest.sourceRoot + path.sep))) return target + value.slice(manifest.sourceRoot.length);
    if (Array.isArray(value)) return value.map(rebase);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rebase(child)]));
    return value;
  };
  const db = new DatabaseSync(path.join(target, 'platform.sqlite'));
  try {
    db.exec('BEGIN IMMEDIATE');
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='service_owner'").get()) db.exec('DELETE FROM service_owner');
    for (const row of db.prepare('SELECT name,data FROM documents').all()) db.prepare('UPDATE documents SET data=?,revision=revision+1 WHERE name=?').run(JSON.stringify(row.name === 'uploads' ? [] : rebase(JSON.parse(row.data))), row.name);
    db.exec('COMMIT');
  } finally { db.close(); }
  await fsp.writeFile(path.join(target, 'storage-initialized.json'), JSON.stringify({ version: 1, restoredAt: new Date().toISOString() }));
  return { restored: true, files: manifest.files.length, destination: target };
}
module.exports = { backup, verify, restore, digest, contained };
if (require.main === module) {
  const [command, source, target] = process.argv.slice(2);
  (async () => {
    if (command === 'verify' && source) { const result = await verify(source); console.log(JSON.stringify({ verified: true, files: result.files.length })); }
    else if (command === 'restore' && source && target) console.log(JSON.stringify(await restore(source, target)));
    else throw new Error('用法：node tools/storage-backup.cjs verify <备份目录> 或 restore <备份目录> <空工作目录>');
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
