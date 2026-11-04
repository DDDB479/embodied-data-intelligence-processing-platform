const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PlatformStore } = require('../tools/platform-store.cjs');
const { TaskQueue } = require('../tools/task-queue.cjs');
const { ResumableUploads } = require('../tools/resumable-upload.cjs');
const { backup, verify, restore } = require('../tools/storage-backup.cjs');
const testStores = [];
function openStore(directory, defaults) { const store = new PlatformStore(directory, defaults); testStores.push(store); return store; }
const defaults = { state: () => ({ assets: [], members: [], audit: [] }), auth: () => ({ users: [], sessionSecret: 'isolated-test-secret' }) };
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'production-store-'));
  t.after(() => { for (const store of testStores) { if (store.directory.startsWith(directory)) store.close(); } fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

test('legacy migration preserves originals and refuses corrupted or missing databases', t => {
  const directory = temporary(t);
  fs.writeFileSync(path.join(directory, 'server-state.json'), '{broken');
  assert.throws(() => openStore(directory, defaults), /无法解析/);
  assert.equal(fs.readFileSync(path.join(directory, 'server-state.json'), 'utf8'), '{broken');
  assert.equal(fs.existsSync(path.join(directory, 'platform.sqlite')), false);
  fs.writeFileSync(path.join(directory, 'server-state.json'), JSON.stringify({ assets: [{ id: 'A', name: 'retained' }] }));
  const store = openStore(directory, defaults);
  assert.equal(store.read('state').assets[0].name, 'retained');
  assert.ok(fs.readdirSync(path.join(directory, 'backups')).some(name => name.startsWith('before-sqlite')));
  store.close();
  fs.renameSync(path.join(directory, 'platform.sqlite'), path.join(directory, 'saved.sqlite'));
  assert.throws(() => openStore(directory, defaults), /数据库文件缺失/);
});

test('concurrent independent edits merge; conflicting transactions roll back all documents', t => {
  const store = openStore(temporary(t), defaults); t.after(() => store.close());
  const first = store.read('state'), second = store.read('state');
  first.assets.push({ id: 'A', name: 'first' }); second.assets.push({ id: 'B', name: 'second' });
  store.write('state', first); store.write('state', second);
  assert.deepEqual(store.read('state').assets.map(item => item.id).sort(), ['A', 'B']);
  const stale = store.read('state'), latest = store.read('state'), auth = store.read('auth');
  stale.assets.find(item => item.id === 'A').name = 'stale';
  latest.assets.find(item => item.id === 'A').name = 'latest'; store.write('state', latest);
  auth.users.push({ id: 'uncommitted' });
  assert.throws(() => store.writeMany([['auth', auth], ['state', stale]]), /其他操作修改/);
  assert.equal(store.read('auth').users.length, 0);
  assert.equal(store.read('state').assets.find(item => item.id === 'A').name, 'latest');
  // Reusing a handler snapshot cannot delete an unrelated merge from another handler.
  second.audit.push({ id: 'log', event: 'later' }); store.write('state', second);
  assert.equal(store.read('state').assets.length, 2);
});

test('full backup restores accounts, source bytes and rebased output paths; tampering is rejected', async t => {
  const directory = temporary(t), store = openStore(directory, defaults); t.after(() => store.close());
  fs.mkdirSync(path.join(directory, 'uploads')); fs.mkdirSync(path.join(directory, 'exports')); fs.mkdirSync(path.join(directory, 'deliveries'));
  const bytes = Buffer.from('original-source'), state = store.read('state'), auth = store.read('auth');
  fs.writeFileSync(path.join(directory, 'uploads', 'original.bin'), bytes);
  state.assets.push({ id: 'A', serverFile: { storedName: 'original.bin', sha256: crypto.createHash('sha256').update(bytes).digest('hex') } });
  state.exports = [{ id: 'OUT', directory: path.join(directory, 'deliveries', 'OUT') }];
  auth.users.push({ id: 'owner', passwordHash: 'test-hash' }); store.writeMany([['state', state], ['auth', auth]]);
  const result = await backup(store), source = path.join(directory, 'backups', result.backup), target = path.join(directory, 'restored');
  await verify(source); await restore(source, target);
  const recovered = openStore(target, defaults);
  assert.equal(recovered.read('auth').users[0].passwordHash, 'test-hash');
  assert.equal(recovered.read('state').exports[0].directory, path.join(target, 'deliveries', 'OUT'));
  assert.deepEqual(await fsp.readFile(path.join(target, 'uploads', 'original.bin')), bytes); recovered.close();
  await assert.rejects(() => restore(source, target), /空目录/);
  fs.appendFileSync(path.join(source, 'uploads', 'original.bin'), 'corruption');
  await assert.rejects(() => verify(source), /备份损坏/);
});

test('queued work is durable, deduplicated and restart-interrupted work requires explicit retry', async t => {
  const directory = temporary(t), store = openStore(directory, defaults); t.after(() => store.close());
  const queue = new TaskQueue(store, async () => ({ completed: true })); queue.stop();
  const user = { id: 'U', name: 'Tester', sessionVersion: 1 };
  const first = queue.enqueue('quality', { targetIds: ['A'] }, user);
  assert.equal(queue.enqueue('quality', { targetIds: ['A'] }, user).id, first.id);
  queue.update(first.id, { status: 'running' });
  const executions = []; const reopened = new TaskQueue(store, async job => { executions.push(job.id); return {done:true}; }); reopened.stop();
  assert.equal(reopened.list()[0].status, 'interrupted');
  const retry = reopened.enqueue('quality', { targetIds: ['A'] }, user, first.id);
  assert.notEqual(retry.id, first.id);
  const next = reopened.enqueue('quality', {targetIds:['C']}, user);
  reopened.stopped = false; await reopened.drain(); await reopened.drain(); reopened.stop();
  assert.deepEqual(executions, [retry.id, next.id]);
  assert.equal(reopened.list().find(job => job.id === retry.id).status, 'succeeded');
});

test('resumable chunks survive reopen, reject stale offsets and discard uncommitted tails', async t => {
  const directory = temporary(t), store = openStore(directory, defaults); t.after(() => store.close());
  const uploads = new ResumableUploads(store), user = { id: 'U' }, first = Buffer.alloc(4 * 1024 ** 2, 65), last = Buffer.from('end');
  const session = uploads.start({ id: 'A', name: 'source.bin' }, { size: first.length + last.length, key: 'a'.repeat(64) }, user);
  await uploads.append(session.id, 0, first, user);
  fs.appendFileSync(uploads.file(session), 'uncommitted-tail');
  const reopened = new ResumableUploads(store);
  assert.equal(reopened.start({ id: 'A' }, { size: first.length + last.length, key: 'a'.repeat(64) }, user).offset, first.length);
  await assert.rejects(() => reopened.append(session.id, 0, last, user), /偏移/);
  await reopened.append(session.id, first.length, last, user);
  const descriptor = fs.openSync(reopened.file(session), 'r+'); fs.writeSync(descriptor, Buffer.from('B'), 0, 1, 0); fs.closeSync(descriptor);
  await assert.rejects(() => reopened.complete(session.id, user, async () => assert.fail('corrupt content cannot commit')), /分片校验失败/);
  assert.equal(store.read('uploads')[0].offset, 0);
  await reopened.append(session.id, 0, first, user); await reopened.append(session.id, first.length, last, user);
  await reopened.complete(session.id, user, async (upload, file) => assert.deepEqual(fs.readFileSync(file), Buffer.concat([first, last])));
  assert.equal(store.read('uploads')[0].status, 'complete');
});

test('LAN browser hashing fallback matches standard SHA-256 vectors', () => {
  const source = fs.readFileSync(path.join(__dirname, '../assets/extensions.js'), 'utf8');
  const code = source.slice(source.indexOf('  function localSha256('), source.indexOf('  async function fileDigest('));
  const hash = new Function(`${code}; return localSha256;`)();
  for (const bytes of [Buffer.alloc(0), Buffer.from('abc'), crypto.randomBytes(4 * 1024 ** 2)]) {
    assert.equal(hash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), crypto.createHash('sha256').update(bytes).digest('hex'));
  }
});
