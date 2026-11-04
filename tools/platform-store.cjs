// Transactional document store. Reads retain a baseline so asynchronous handlers
// can merge independent edits, while conflicting edits fail instead of overwriting.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const clone = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyed = value => Array.isArray(value) && value.every(item => plain(item) && typeof item.id === 'string') && new Set(value.map(item => item.id)).size === value.length;

function merge(base, next, current, location = '') {
  if (equal(base, next)) return clone(current);
  if (equal(base, current) || equal(next, current)) return clone(next);
  if (keyed(base) && keyed(next) && keyed(current)) {
    const before = new Map(base.map(item => [item.id, item]));
    const after = new Map(next.map(item => [item.id, item]));
    const latest = new Map(current.map(item => [item.id, item]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const value = merge(before.get(id), after.get(id), latest.get(id), `${location}/${id}`);
      if (value === undefined) latest.delete(id); else latest.set(id, value);
    }
    const order = [...next.map(item => item.id), ...current.map(item => item.id)];
    return [...new Set(order)].filter(id => latest.has(id)).map(id => latest.get(id));
  }
  if (plain(base) && plain(next) && plain(current)) {
    const result = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(next), ...Object.keys(current)])) {
      const value = merge(base[key], next[key], current[key], `${location}/${key}`);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  const error = new Error(`记录已被其他操作修改，请刷新后重试：${location}`);
  error.status = 409;
  throw error;
}

class PlatformStore {
  constructor(directory, defaults) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, 'platform.sqlite');
    this.baselines = new WeakMap();
    fs.mkdirSync(this.directory, { recursive: true });
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch { throw new Error('数据库需要 Node.js 22.13+；请使用 runtime/node.exe 或升级 Node.js。'); }
    const marker = path.join(this.directory, 'storage-initialized.json');
    if (!fs.existsSync(this.file)) {
      if (fs.existsSync(marker)) throw new Error('数据库文件缺失，请恢复备份；禁止回退旧数据或重新初始化账号。');
      const values = {};
      for (const [name, filename] of [['state', 'server-state.json'], ['auth', 'auth.json']]) {
        const source = path.join(this.directory, filename);
        if (!fs.existsSync(source)) { values[name] = defaults[name](); continue; }
        try { values[name] = JSON.parse(fs.readFileSync(source, 'utf8')); }
        catch { throw new Error(`${filename} 无法解析，已停止迁移；原文件保留，请修复或恢复备份。`); }
        if (!plain(values[name])) throw new Error(`${filename} 结构无效，已停止迁移。`);
        if (name === 'state' && values[name].assets != null && !Array.isArray(values[name].assets)) throw new Error('资产列表结构无效，已停止迁移。');
        if (name === 'auth' && (!Array.isArray(values[name].users) || !values[name].sessionSecret)) throw new Error('认证文件结构无效，已停止迁移。');
      }
      if (values.state.members?.length && !values.auth.users.length) throw new Error('已有成员但认证记录缺失，请恢复认证备份，禁止重新创建所有者。');
      const migration = path.join(this.directory, 'backups', `before-sqlite-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
      fs.mkdirSync(migration, { recursive: true });
      for (const filename of ['server-state.json', 'auth.json']) {
        const source = path.join(this.directory, filename);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(migration, filename));
      }
      const staging = `${this.file}.migration-${process.pid}`;
      const db = new DatabaseSync(staging);
      try {
        db.exec('PRAGMA synchronous=FULL; CREATE TABLE documents (name TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL); BEGIN IMMEDIATE;');
        for (const [name, value] of Object.entries({ ...values, jobs: [], uploads: [] })) db.prepare('INSERT INTO documents VALUES (?,1,?)').run(name, JSON.stringify(value));
        db.exec('COMMIT');
      } finally { db.close(); }
      fs.renameSync(staging, this.file);
      fs.writeFileSync(marker, JSON.stringify({ version: 1, migratedAt: new Date().toISOString(), legacyBackup: path.relative(this.directory, migration) }), { flag: 'wx' });
    }
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('数据库完整性检查失败，请恢复备份。');
    for (const name of ['state', 'auth', 'jobs', 'uploads']) this.read(name);
  }
  read(name) {
    const row = this.db.prepare('SELECT revision,data FROM documents WHERE name=?').get(name);
    if (!row) throw new Error(`数据库缺少 ${name}，禁止自动创建空记录。`);
    const value = JSON.parse(row.data);
    if (!value || typeof value !== 'object') throw new Error(`数据库 ${name} 结构损坏。`);
    this.baselines.set(value, { name, value: clone(value), revision: row.revision });
    return value;
  }
  track(value, name, baseline) {
    this.baselines.set(value, { name, value: clone(baseline ?? value) });
    return value;
  }
  write(name, value) {
    return this.writeMany([[name, value]]);
  }
  writeMany(entries) {
    this.db.exec('BEGIN IMMEDIATE');
    const committed = [];
    try {
      for (const [name, value] of entries) {
        const baseline = this.baselines.get(value);
        if (!baseline || baseline.name !== name) throw new Error(`缺少 ${name} 写入基线，拒绝覆盖数据库。`);
        const row = this.db.prepare('SELECT revision,data FROM documents WHERE name=?').get(name);
        const merged = merge(baseline.value, value, JSON.parse(row.data), name);
        this.db.prepare('UPDATE documents SET revision=revision+1,data=? WHERE name=?').run(JSON.stringify(merged), name);
        committed.push([value, name, merged]);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    for (const [value, name] of committed) this.track(value, name);
  }
  checkpoint(destination) {
    this.db.prepare('VACUUM INTO ?').run(destination);
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
module.exports = { PlatformStore, merge };
