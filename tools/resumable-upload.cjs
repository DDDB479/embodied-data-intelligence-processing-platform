const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class ResumableUploads {
  constructor(store) {
    this.store = store; this.locks = new Set(); this.directory = path.join(store.directory, 'upload-sessions');
    fs.mkdirSync(this.directory, { recursive: true });
  }
  start(asset, body, user) {
    const size = Number(body.size), key = String(body.key || '');
    if (!Number.isSafeInteger(size) || size <= 0 || size > 20 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(key)) throw new Error('上传大小或文件指纹无效');
    const sessions = this.store.read('uploads');
    const existing = sessions.find(item => item.assetId === asset.id && item.key === key && item.userId === user.id);
    if (existing) return existing;
    const session = { id: crypto.randomUUID(), assetId: asset.id, userId: user.id, key, size, name: String(body.name || asset.name), chunkSize: 4 * 1024 ** 2, offset: 0, chunks: [], status: 'uploading', createdAt: new Date().toISOString() };
    fs.writeFileSync(this.file(session), Buffer.alloc(0), { flag: 'wx' });
    sessions.push(session); this.store.write('uploads', sessions); return session;
  }
  file(session) { return path.join(this.directory, session.id + '.part'); }
  async append(id, offset, bytes, user) {
    if (this.locks.has(id)) { const error = new Error('该上传正在写入，请稍后重试'); error.status = 409; throw error; }
    this.locks.add(id);
    try {
      const sessions = this.store.read('uploads'), session = sessions.find(item => item.id === id && item.userId === user.id);
      if (!session || session.status !== 'uploading') throw new Error('上传会话不存在或已经完成');
      if (offset !== session.offset) { const error = new Error('续传偏移已变化，请重新读取上传进度'); error.status = 409; throw error; }
      if (bytes.length !== Math.min(session.chunkSize, session.size - offset)) throw new Error('上传分片大小不符合要求');
      const descriptor = fs.openSync(this.file(session), 'r+');
      try {
        fs.ftruncateSync(descriptor, offset); // Discard an uncommitted tail left by a process crash.
        let written = 0;
        while (written < bytes.length) written += fs.writeSync(descriptor, bytes, written, bytes.length - written, offset + written);
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      session.chunks.push(crypto.createHash('sha256').update(bytes).digest('hex'));
      session.offset += bytes.length;
      this.store.write('uploads', sessions); return session;
    } finally { this.locks.delete(id); }
  }
  async complete(id, user, commit) {
    if (this.locks.has(id)) throw new Error('该文件正在写入');
    this.locks.add(id);
    try {
      const sessions = this.store.read('uploads'), session = sessions.find(item => item.id === id && item.userId === user.id);
      if (!session) throw new Error('上传会话不存在');
      if (session.status === 'complete') return session;
      if (session.offset !== session.size || fs.statSync(this.file(session)).size < session.size) throw new Error('文件尚未完整上传');
      fs.truncateSync(this.file(session), session.size);
      const descriptor = fs.openSync(this.file(session), 'r');
      try {
        for (let index = 0; index < session.chunks.length; index++) {
          const offset = index * session.chunkSize, bytes = Buffer.alloc(Math.min(session.chunkSize, session.size - offset));
          let read = 0;
          while (read < bytes.length) { const count = fs.readSync(descriptor, bytes, read, bytes.length - read, offset + read); if (!count) throw new Error('上传分片读取不完整'); read += count; }
          if (crypto.createHash('sha256').update(bytes).digest('hex') !== session.chunks[index]) {
            session.offset = offset; session.chunks = session.chunks.slice(0, index);
            this.store.write('uploads', sessions);
            throw new Error('上传分片校验失败，已回退到受损分片；请重新选择文件续传');
          }
        }
      } finally { fs.closeSync(descriptor); }
      await commit(session, this.file(session));
      session.status = 'complete'; session.completedAt = new Date().toISOString();
      this.store.write('uploads', sessions);
      fs.rmSync(this.file(session), { force: true });
      return session;
    } finally { this.locks.delete(id); }
  }
}
module.exports = { ResumableUploads };
