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

test('queued background tasks can pause, resume and be deleted', t => {
  const store = openStore(temporary(t), defaults); t.after(() => store.close());
  const queue = new TaskQueue(store, async () => ({ completed: true })); queue.stop();
  const user = { id: 'U-PAUSE', name: 'Tester', sessionVersion: 1 };
  const job = queue.enqueue('quality', { targetIds: ['A'] }, user);
  assert.equal(queue.pause(job.id).status, 'paused');
  assert.equal(queue.resume(job.id).status, 'queued');
  assert.equal(queue.pause(job.id).status, 'paused');
  assert.equal(queue.remove(job.id).id, job.id);
  assert.equal(queue.list().length, 0);
});

test('resumable chunks survive reopen, reject stale offsets and discard uncommitted tails', async t => {
  const directory = temporary(t), store = openStore(directory, defaults); t.after(() => store.close());
  const chunkSize = 4 * 1024 ** 2, uploads = new ResumableUploads(store, { chunkSize }), user = { id: 'U' }, first = Buffer.alloc(chunkSize, 65), last = Buffer.from('end');
  const session = uploads.start({ id: 'A', name: 'source.bin' }, { size: first.length + last.length, key: 'a'.repeat(64) }, user);
  await uploads.append(session.id, 0, first, user);
  assert.ok(fs.existsSync(uploads.manifest(session)), 'active progress must be checkpointed outside the uploads document');
  fs.appendFileSync(uploads.file(session), 'uncommitted-tail');
  const reopened = new ResumableUploads(store, { chunkSize });
  assert.equal(reopened.start({ id: 'A' }, { size: first.length + last.length, key: 'a'.repeat(64) }, user).offset, first.length);
  await assert.rejects(() => reopened.append(session.id, 0, last, user), /偏移/);
  assert.equal(reopened.pause(session.id, user).status, 'paused');
  await assert.rejects(() => reopened.append(session.id, first.length, last, user), /已暂停/);
  assert.equal(reopened.resume(session.id, user).status, 'uploading');
  await reopened.append(session.id, first.length, last, user);
  const descriptor = fs.openSync(reopened.file(session), 'r+'); fs.writeSync(descriptor, Buffer.from('B'), 0, 1, 0); fs.closeSync(descriptor);
  await assert.rejects(() => reopened.complete(session.id, user, async () => assert.fail('corrupt content cannot commit')), /分片校验失败/);
  assert.equal(reopened.get(session.id, user).offset, 0);
  await reopened.append(session.id, 0, first, user); await reopened.append(session.id, first.length, last, user);
  await reopened.complete(session.id, user, async (upload, file, evidence) => {
    const expected = Buffer.concat([first, last]);
    assert.deepEqual(fs.readFileSync(file), expected);
    assert.equal(evidence.sha256, crypto.createHash('sha256').update(expected).digest('hex'));
    assert.equal(evidence.size, expected.length);
  });
  assert.equal(store.read('uploads')[0].status, 'complete');
  const removable = reopened.start({ id: 'B', name: 'remove.bin' }, { size: first.length, key: 'b'.repeat(64) }, user);
  reopened.remove(removable.id, user);
  assert.equal(fs.existsSync(reopened.file(removable)), false);
  assert.equal(store.read('uploads').some(item => item.id === removable.id), false);
});

test('many small uploads are verified and committed in one batch', async t => {
  const store = openStore(temporary(t), defaults), chunkSize = 1 * 1024 ** 2, uploads = new ResumableUploads(store, { chunkSize }), user = { id: 'U-BATCH' };
  const bytes = [Buffer.alloc(chunkSize, 65), Buffer.alloc(chunkSize, 66)];
  const sessions = bytes.map((_, index) => uploads.start({ id: `A-${index}`, name: `${index}.hdf5` }, { size: chunkSize, key: String(index + 1).repeat(64).slice(0, 64) }, user));
  for (let index = 0; index < sessions.length; index++) await uploads.append(sessions[index].id, 0, bytes[index], user);
  let commits = 0;
  const completed = await uploads.completeMany(sessions.map(item => item.id), user, async pending => {
    commits++;
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map(item => item.evidence.sha256), bytes.map(item => crypto.createHash('sha256').update(item).digest('hex')));
  });
  assert.equal(commits, 1);
  assert.deepEqual(completed.map(item => item.status), ['complete', 'complete']);
  assert.ok(sessions.every(item => !fs.existsSync(uploads.file(item)) && !fs.existsSync(uploads.manifest(item))));
});

test('batched upload completion returns every committed file across multiple batches', async t => {
  const store = openStore(temporary(t), defaults), uploads = new ResumableUploads(store), user = { id: 'U-MULTI' }, count = 120, bytes = Buffer.alloc(1024, 69);
  const sessions = uploads.startMany(Array.from({ length: count }, (_, index) => ({ assetId: `A-${index}`, name: `${index}.hdf5`, size: bytes.length, key: crypto.createHash('sha256').update(String(index)).digest('hex') })), user);
  for (const session of sessions) await uploads.append(session.id, 0, bytes, user);
  const first = await uploads.completeMany(sessions.slice(0, 60).map(item => item.id), user, async () => {});
  const second = await uploads.completeMany(sessions.slice(60).map(item => item.id), user, async () => {});
  assert.equal(first.length, 60);
  assert.equal(second.length, 60);
});

test('completed upload sessions are compacted to prevent unbounded document growth', t => {
  const directory = temporary(t), store = openStore(directory, defaults);
  const existing = store.read('uploads');
  const sessions = Array.from({ length: 150 }, (_, index) => ({ id: `S-${index}`, status: 'complete', createdAt: new Date(2026, 0, 1, 0, index).toISOString(), chunks: ['a'.repeat(64)] }));
  existing.push(...sessions); store.write('uploads', existing);
  const uploads = new ResumableUploads(store);
  const retained = store.read('uploads');
  assert.equal(retained.length, 100);
  assert.equal(uploads.compactSessions([{ id: 'active', status: 'uploading' }, ...sessions]).length, 101);
  assert.ok(retained.every(item => item.status === 'complete' && item.chunks.length === 0));
});

test('missing upload parts are reconciled to a safe paused restart instead of ENOENT', t => {
  const store = openStore(temporary(t), defaults), uploads = new ResumableUploads(store), user = { id: 'U-MISSING', name: 'Tester' };
  const session = uploads.start({ id: 'A-MISSING', name: 'missing.bin' }, { size: 1024, key: 'c'.repeat(64) }, user);
  fs.rmSync(uploads.file(session), { force: true });
  const repaired = new ResumableUploads(store), recovered = repaired.get(session.id, user);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.offset, 0);
  assert.equal(fs.existsSync(repaired.file(recovered)), true);
});

test('stale active uploads are marked paused instead of appearing stuck after restart', async t => {
  const store = openStore(temporary(t), defaults), uploads = new ResumableUploads(store), user = { id: 'U-STALE', name: 'Tester' };
  const session = uploads.start({ id: 'A-STALE', name: 'stale.hdf5' }, { size: 1024, key: 'd'.repeat(64) }, user);
  await uploads.append(session.id, 0, Buffer.alloc(1024, 1), user);
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(uploads.file(session), old, old); fs.utimesSync(uploads.manifest(session), old, old);
  const restarted = new ResumableUploads(store);
  assert.equal(restarted.get(session.id, user).status, 'paused');
});

test('LAN browser hashing fallback matches standard SHA-256 vectors', () => {
  const source = fs.readFileSync(path.join(__dirname, '../assets/extensions.js'), 'utf8');
  const code = source.slice(source.indexOf('  function localSha256('), source.indexOf('  async function fileDigest('));
  const hash = new Function(`${code}; return localSha256;`)();
  for (const bytes of [Buffer.alloc(0), Buffer.from('abc'), crypto.randomBytes(4 * 1024 ** 2)]) {
    assert.equal(hash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), crypto.createHash('sha256').update(bytes).digest('hex'));
  }
});
