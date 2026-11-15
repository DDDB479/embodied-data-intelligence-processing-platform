const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_CHUNK_SIZE = 16 * 1024 ** 2;
const MIN_CHUNK_SIZE = 1 * 1024 ** 2;
const MAX_CHUNK_SIZE = 64 * 1024 ** 2;

function normalizeChunkSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < MIN_CHUNK_SIZE || size > MAX_CHUNK_SIZE) return DEFAULT_CHUNK_SIZE;
  return size;
}

function uploadProgressIsStale(...files) {
  const latest = Math.max(0, ...files.map(file => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }));
  return latest > 0 && Date.now() - latest > 2 * 60 * 1000;
}

class ResumableUploads {
  constructor(store, options = {}) {
    this.store = store;
    this.locks = new Set();
    this.cache = null;
    this.directory = path.join(store.directory, 'upload-sessions');
    const configured = options.chunkSize ?? (process.env.UPLOAD_CHUNK_SIZE_MB ? Number(process.env.UPLOAD_CHUNK_SIZE_MB) * 1024 ** 2 : process.env.UPLOAD_CHUNK_SIZE);
    this.chunkSize = normalizeChunkSize(configured);
    this.maxChunkSize = MAX_CHUNK_SIZE;
    fs.mkdirSync(this.directory, { recursive: true });
    this.prune();
    this.reconcileFiles();
  }
  compactSessions(sessions, keepCompleted = 100) {
    const completed = sessions.filter(item => item.status === 'complete').sort((left, right) => String(right.completedAt || right.createdAt || '').localeCompare(String(left.completedAt || left.createdAt || ''))).slice(0, keepCompleted).map(item => ({ ...item, chunks: [] }));
    return [...sessions.filter(item => item.status !== 'complete'), ...completed];
  }
  prune() {
    if (Array.isArray(this.cache)) {
      const compacted = this.compactSessions(this.cache);
      if (compacted.length !== this.cache.length || this.cache.some(item => item.status === 'complete' && item.chunks?.length)) {
        this.cache.splice(0, this.cache.length, ...compacted);
        this.store.write('uploads', this.cache);
      }
      return this.cache;
    }
    let sessions;
    try { sessions = this.store.read('uploads'); } catch { return []; }
    const compacted = this.compactSessions(sessions);
    if (compacted.length !== sessions.length || sessions.some(item => item.status === 'complete' && item.chunks?.length)) {
      sessions.splice(0, sessions.length, ...compacted);
      this.store.write('uploads', sessions);
    }
    for (let index = 0; index < sessions.length; index++) sessions[index] = sessions[index].status === 'complete' ? sessions[index] : this.hydrate(sessions[index]);
    this.cache = sessions;
    return this.cache;
  }
  reconcileFiles() {
    const sessions = this.prune(); let changed = false;
    for (const base of sessions.filter(item => item.status !== 'complete')) {
      const session = base, part = this.file(session), manifest = this.manifest(session);
      if (!fs.existsSync(part)) {
        base.status = 'paused'; base.offset = 0; base.chunks = []; base.updatedAt = new Date().toISOString();
        fs.writeFileSync(part, Buffer.alloc(0));
        fs.writeFileSync(manifest, JSON.stringify({ id: base.id, size: base.size, chunkSize: base.chunkSize, offset: 0, chunks: [] }));
        changed = true;
      } else if (!fs.existsSync(manifest) && Array.isArray(base.chunks) && base.chunks.length) {
        fs.writeFileSync(manifest, JSON.stringify({ id: base.id, size: base.size, chunkSize: base.chunkSize, offset: base.offset, chunks: base.chunks }));
      } else if (base.status === 'uploading' && uploadProgressIsStale(part, manifest)) {
        base.status = 'paused';
        base.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.store.write('uploads', sessions);
    return sessions;
  }
  file(session) { return path.join(this.directory, session.id + '.part'); }
  manifest(session) { return path.join(this.directory, session.id + '.json'); }
  hydrate(session) {
    if (!session || session.status === 'complete') return session;
    try {
      const saved = JSON.parse(fs.readFileSync(this.manifest(session), 'utf8'));
      const chunks = Array.isArray(saved.chunks) ? saved.chunks : null;
      const offset = Number(saved.offset);
      if (saved.id !== session.id || Number(saved.size) !== Number(session.size) || !Number.isSafeInteger(offset) || offset < 0 || offset > session.size || !chunks || chunks.length !== Math.ceil(offset / saved.chunkSize)) return session;
      return { ...session, ...saved };
    } catch { return session; }
  }
  get(id, user) {
    return this.prune().find(item => item.id === id && item.userId === user.id);
  }
  list(user) {
    return this.prune().filter(item => item.userId === user.id || user.isAdministrator || user.isPlatformOwner).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }
  setStatus(id, user, status) {
    if (this.locks.has(id)) { const error = new Error('上传分片正在写入，请稍后再试'); error.status = 409; throw error; }
    const sessions = this.prune(), index = sessions.findIndex(item => item.id === id && item.userId === user.id);
    if (index < 0) throw new Error('上传任务不存在');
    const session = sessions[index];
    if (session.status === 'complete') throw new Error('上传任务已经完成');
    sessions[index] = { ...sessions[index], status, updatedAt: new Date().toISOString() };
    this.store.write('uploads', sessions);
    return sessions[index];
  }
  pause(id, user) { return this.setStatus(id, user, 'paused'); }
  resume(id, user) { return this.setStatus(id, user, 'uploading'); }
  remove(id, user) {
    if (this.locks.has(id)) { const error = new Error('上传分片正在写入，请稍后再试'); error.status = 409; throw error; }
    const sessions = this.prune(), index = sessions.findIndex(item => item.id === id && item.userId === user.id);
    if (index < 0) throw new Error('上传任务不存在');
    const [session] = sessions.splice(index, 1);
    this.store.write('uploads', sessions);
    fs.rmSync(this.file(session), { force: true });
    fs.rmSync(this.manifest(session), { force: true });
    return session;
  }
  async saveManifest(session) {
    const target = this.manifest(session), temporary = `${target}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify({ id: session.id, size: session.size, chunkSize: session.chunkSize, offset: session.offset, chunks: session.chunks }), 'utf8');
      await fsp.rename(temporary, target);
    } finally { try { await fsp.rm(temporary, { force: true }); } catch {} }
  }
  start(asset, body, user) {
    const size = Number(body.size), key = String(body.key || '');
    if (!Number.isSafeInteger(size) || size <= 0 || size > 20 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(key)) throw new Error('上传大小或文件指纹无效');
    const sessions = this.prune();
    const existing = sessions.find(item => item.assetId === asset.id && item.key === key && item.userId === user.id);
    if (existing) return existing;
    const session = { id: crypto.randomUUID(), assetId: asset.id, userId: user.id, userName: user.name || '上传用户', key, size, name: String(body.name || asset.name), chunkSize: this.chunkSize, offset: 0, chunks: [], status: 'uploading', createdAt: new Date().toISOString() };
    fs.writeFileSync(this.file(session), Buffer.alloc(0), { flag: 'wx' });
    sessions.push(session); this.store.write('uploads', sessions); return session;
  }
  startMany(items, user) {
    if (!Array.isArray(items) || !items.length || items.length > 20000) throw new Error('批量上传数量必须在 1 到 20000 之间');
    const sessions = this.prune(), results = [];
    let changed = false;
    for (const item of items) {
      const size = Number(item.size), key = String(item.key || ''), assetId = String(item.assetId || '');
      if (!assetId || !Number.isSafeInteger(size) || size <= 0 || size > 20 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(key)) throw new Error('上传大小、资产编号或文件指纹无效');
      const existing = sessions.find(session => session.assetId === assetId && session.key === key && session.userId === user.id);
      if (existing) { results.push(existing); continue; }
      const session = { id: crypto.randomUUID(), assetId, userId: user.id, userName: user.name || '上传用户', key, size, name: String(item.name || assetId), chunkSize: this.chunkSize, offset: 0, chunks: [], status: 'uploading', createdAt: new Date().toISOString() };
      fs.writeFileSync(this.file(session), Buffer.alloc(0), { flag: 'wx' });
      sessions.push(session); results.push(session); changed = true;
    }
    if (changed) this.store.write('uploads', sessions);
    return results;
  }
  async append(id, offset, bytes, user) {
    if (this.locks.has(id)) { const error = new Error('该上传正在写入，请稍后重试'); error.status = 409; throw error; }
    this.locks.add(id);
    try {
      const sessions = this.prune();
      const session = sessions.find(item => item.id === id && item.userId === user.id);
      if (!session) { const error = new Error('上传会话不存在，请重新选择原文件'); error.status = 404; throw error; }
      if (session.status === 'complete') { const error = new Error('上传任务已经完成'); error.status = 409; throw error; }
      if (session.status === 'paused') { const error = new Error('上传任务已暂停，请继续后再上传'); error.status = 409; throw error; }
      if (offset !== session.offset) { const error = new Error('续传偏移已变化，请重新读取上传进度'); error.status = 409; throw error; }
      if (bytes.length !== Math.min(session.chunkSize, session.size - offset)) throw new Error('上传分片大小不符合要求');
      if (!fs.existsSync(this.file(session))) {
        if (offset === 0) fs.writeFileSync(this.file(session), Buffer.alloc(0));
        else {
          const base = sessions.find(item => item.id === session.id);
          Object.assign(base, { offset: 0, chunks: [], status: 'paused', updatedAt: new Date().toISOString() });
          await this.saveManifest(base);
          this.store.write('uploads', sessions);
          const error = new Error('临时分片文件已丢失，上传进度已重置；请重新选择原文件上传'); error.status = 409; throw error;
        }
      }
      const handle = await fsp.open(this.file(session), 'r+');
      try {
        const stat = await handle.stat();
        if (stat.size < offset) {
          const recoveredOffset = Math.floor(stat.size / session.chunkSize) * session.chunkSize;
          session.offset = recoveredOffset;
          session.chunks = session.chunks.slice(0, recoveredOffset / session.chunkSize);
          await this.saveManifest(session);
          const error = new Error('上传进度已回退到最近一个完整分片，请从服务端偏移继续');
          error.status = 409;
          throw error;
        }
        if (stat.size > offset) await handle.truncate(offset); // Discard an uncommitted tail left by a process crash.
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new Error('上传分片写入不完整');
          written += result.bytesWritten;
        }
      } finally { await handle.close(); }
      session.chunks.push(crypto.createHash('sha256').update(bytes).digest('hex'));
      session.offset += bytes.length;
      await this.saveManifest(session);
      return session;
    } finally { this.locks.delete(id); }
  }
  async verifyAndDigest(session) {
    const expectedChunks = Math.ceil(session.size / session.chunkSize);
    if (session.chunks.length !== expectedChunks) throw new Error('上传分片清单不完整，请重新选择文件续传');
    const handle = await fsp.open(this.file(session), 'r+');
    const whole = crypto.createHash('sha256');
    let buffer;
    try {
      for (let index = 0; index < expectedChunks; index++) {
        const offset = index * session.chunkSize;
        const length = Math.min(session.chunkSize, session.size - offset);
        if (!buffer || buffer.length < length) buffer = Buffer.allocUnsafe(session.chunkSize);
        const bytes = buffer.subarray(0, length);
        let read = 0;
        while (read < length) {
          const result = await handle.read(bytes, read, length - read, offset + read);
          if (!result.bytesRead) throw new Error('上传分片读取不完整');
          read += result.bytesRead;
        }
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== session.chunks[index]) {
          session.offset = offset;
          session.chunks = session.chunks.slice(0, index);
          await this.saveManifest(session);
          throw new Error('上传分片校验失败，已回退到受损分片；请重新选择文件续传');
        }
        whole.update(bytes);
      }
      await handle.sync();
    } finally { await handle.close(); }
    return whole.digest('hex');
  }

  async complete(id, user, commit) {
    if (this.locks.has(id)) throw new Error('该文件正在写入');
    this.locks.add(id);
    try {
      const sessions = this.prune();
      const index = sessions.findIndex(item => item.id === id && item.userId === user.id);
      const session = sessions[index];
      if (!session) throw new Error('上传会话不存在');
      if (session.status === 'complete') return session;
      if (!fs.existsSync(this.file(session))) {
        sessions[index] = { ...sessions[index], offset: 0, chunks: [], status: 'paused', updatedAt: new Date().toISOString() };
        fs.writeFileSync(this.file(session), Buffer.alloc(0));
        await this.saveManifest(sessions[index]);
        this.store.write('uploads', sessions);
        const error = new Error('临时分片文件已丢失，上传进度已重置；请重新选择原文件上传');
        error.status = 409;
        throw error;
      }
      if (session.offset !== session.size || fs.statSync(this.file(session)).size < session.size) throw new Error('文件尚未完整上传');
      fs.truncateSync(this.file(session), session.size);
      const sha256 = await this.verifyAndDigest(session);
      await commit(session, this.file(session), { sha256, size: session.size });
      session.status = 'complete';
      session.completedAt = new Date().toISOString();
      session.chunks = [];
      sessions[index] = session;
      this.store.write('uploads', sessions);
      fs.rmSync(this.file(session), { force: true });
      fs.rmSync(this.manifest(session), { force: true });
      return session;
    } finally { this.locks.delete(id); }
  }

  async completeMany(ids, user, commitMany) {
    const requested = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    if (!requested.length || requested.length > 1000) throw new Error('单次批量入库数量必须在 1 到 1000 之间');
    if (requested.some(id => this.locks.has(id))) throw new Error('部分文件正在写入，请稍后重试');
    requested.forEach(id => this.locks.add(id));
    try {
      const sessions = this.prune(), indexes = new Map(sessions.map((item, index) => [item.id, index])), pending = [];
      for (const id of requested) {
        const index = indexes.get(id);
        const session = sessions[index];
        if (!session || session.userId !== user.id) {
          const error = new Error('上传会话不存在');
          error.status = 404;
          throw error;
        }
        if (session.status === 'complete') continue;
        if (session.status === 'paused') {
          const error = new Error(`上传任务 ${session.name} 已暂停，请继续后再入库`);
          error.status = 409;
          throw error;
        }
        if (!fs.existsSync(this.file(session))) {
          sessions[index] = { ...sessions[index], offset: 0, chunks: [], status: 'paused', updatedAt: new Date().toISOString() };
          fs.writeFileSync(this.file(session), Buffer.alloc(0));
          await this.saveManifest(sessions[index]);
          this.store.write('uploads', sessions);
          const error = new Error(`上传任务 ${session.name} 的临时分片文件已丢失，进度已重置`);
          error.status = 409;
          throw error;
        }
        if (session.offset !== session.size || fs.statSync(this.file(session)).size < session.size) {
          const error = new Error(`上传任务 ${session.name} 尚未完整上传`);
          error.status = 409;
          throw error;
        }
        fs.truncateSync(this.file(session), session.size);
        const sha256 = await this.verifyAndDigest(session);
        pending.push({ session, file: this.file(session), evidence: { sha256, size: session.size } });
      }
      if (pending.length) {
        await commitMany(pending);
        const completedAt = new Date().toISOString();
        for (const item of pending) {
          Object.assign(item.session, { status: 'complete', completedAt, chunks: [] });
          sessions[indexes.get(item.session.id)] = item.session;
        }
        this.store.write('uploads', sessions);
        for (const item of pending) {
          fs.rmSync(item.file, { force: true });
          fs.rmSync(this.manifest(item.session), { force: true });
        }
      }
      const completedById = new Map(sessions.filter(item => item.userId === user.id).map(item => [item.id, item]));
      return requested.map(id => completedById.get(id)).filter(Boolean);
    } finally {
      requested.forEach(id => this.locks.delete(id));
    }
  }
}
module.exports = { ResumableUploads, DEFAULT_CHUNK_SIZE, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE };
