const crypto = require('node:crypto');
class TaskQueue {
  constructor(store, execute) {
    this.store = store; this.execute = execute; this.busy = false; this.stopped = false;
    const jobs = store.read('jobs');
    for (const job of jobs) if (job.status === 'running') Object.assign(job, { status: 'interrupted', finishedAt: new Date().toISOString(), error: '服务重启中断任务；请检查结果后重试。已完成文件不会回滚。' });
    store.write('jobs', jobs);
  }
  list() { return this.store.read('jobs'); }
  enqueue(kind, payload, user, retryOf = null) {
    const key = crypto.createHash('sha256').update(JSON.stringify([kind, payload, user.id])).digest('hex');
    const jobs = this.list(), duplicate = jobs.find(job => job.key === key && ['queued', 'running'].includes(job.status));
    if (duplicate) return duplicate;
    const job = { id: `JOB-${crypto.randomUUID()}`, key, kind, payload, userId: user.id, userName: user.name, sessionVersion: user.sessionVersion, status: 'queued', completed: 0, total: 0, message: '等待执行', createdAt: new Date().toISOString(), retryOf };
    jobs.unshift(job); this.store.write('jobs', jobs); this.schedule(); return job;
  }
  update(id, patch) {
    const jobs = this.list(), job = jobs.find(item => item.id === id);
    if (!job) throw new Error('后台任务不存在');
    Object.assign(job, patch); this.store.write('jobs', jobs); return job;
  }
  schedule() { if (!this.stopped) setImmediate(() => this.drain()); }
  async drain() {
    if (this.busy || this.stopped) return;
    const job = this.list().findLast(item => item.status === 'queued');
    if (!job) return;
    this.busy = true;
    this.update(job.id, { status: 'running', startedAt: new Date().toISOString(), message: '正在执行' });
    try {
      const result = await this.execute(job, progress => this.update(job.id, progress));
      this.update(job.id, { status: 'succeeded', finishedAt: new Date().toISOString(), result, message: '执行完成；数据是否合格请查看检测结果' });
    } catch (error) { this.update(job.id, { status: 'failed', finishedAt: new Date().toISOString(), error: error.message, message: '执行失败，保留证据供重试' }); }
    finally { this.busy = false; this.schedule(); }
  }
  stop() { this.stopped = true; }
}
module.exports = { TaskQueue };
