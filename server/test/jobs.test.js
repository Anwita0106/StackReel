import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobManager } from '../src/jobs/jobManager.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(10); }
}

test('job transitions queued → running → completed with progress and logs', async () => {
  const m = createJobManager({ limits: { t: 1 } });
  m.register('t', { stages: ['a', 'b'], run: async (p, ctx) => { ctx.progress(0, 30, 'step a'); await wait(20); ctx.progress(1, 70, 'step b'); return { value: p.x * 2 }; } });
  const { job } = m.enqueue('t', { x: 21 });
  assert.equal(job.status, 'queued');
  await until(() => m.get(job.id).status === 'completed');
  const done = m.get(job.id);
  assert.deepEqual(done.result, { value: 42 });
  assert.equal(done.progress, 100);
  assert.ok(done.logs.some(l => l.msg === 'step b'));
  assert.equal(done._payload, undefined, 'payload must not leak into the public view');
  await m.shutdown();
});

test('duplicate active jobs are de-duplicated by key', async () => {
  const m = createJobManager({ limits: { t: 1 } });
  m.register('t', { stages: ['a'], run: () => wait(50) });
  const a = m.enqueue('t', {}, { key: 'same' });
  const b = m.enqueue('t', {}, { key: 'same' });
  assert.equal(b.deduplicated, true);
  assert.equal(b.job.id, a.job.id);
  await m.shutdown();
});

test('concurrency limit is respected and queued jobs can be cancelled', async () => {
  const m = createJobManager({ limits: { t: 1 } });
  let running = 0; let peak = 0;
  m.register('t', { stages: ['a'], run: async () => { running += 1; peak = Math.max(peak, running); await wait(40); running -= 1; } });
  const j1 = m.enqueue('t', {}).job; const j2 = m.enqueue('t', {}).job; const j3 = m.enqueue('t', {}).job;
  m.cancel(j3.id);
  await until(() => m.get(j2.id).status === 'completed');
  assert.equal(peak, 1);
  assert.equal(m.get(j1.id).status, 'completed');
  assert.equal(m.get(j3.id).status, 'cancelled');
  await m.shutdown();
});

test('running jobs receive an abort signal on cancel', async () => {
  const m = createJobManager({ limits: { t: 1 } });
  m.register('t', { stages: ['a'], run: (p, ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const { job } = m.enqueue('t', {});
  await until(() => m.get(job.id).status === 'running');
  m.cancel(job.id);
  await until(() => m.get(job.id).finishedAt);
  assert.equal(m.get(job.id).status, 'cancelled');
  await m.shutdown();
});

test('transient failures are retried; permanent failures surface their error', async () => {
  const m = createJobManager({ limits: { t: 1, p: 1 } });
  let attempts = 0;
  m.register('t', { stages: ['a'], maxAttempts: 2, run: async () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error('flaky'), { transient: true }); return 'ok'; } });
  m.register('p', { stages: ['a'], maxAttempts: 2, run: async () => { throw Object.assign(new Error('bad input'), { code: 'BAD' }); } });
  const t = m.enqueue('t', {}).job; const p = m.enqueue('p', {}).job;
  await until(() => m.get(t.id).status === 'completed' && m.get(p.id).status === 'failed', 8000);
  assert.equal(m.get(t.id).attempts, 2);
  assert.deepEqual(m.get(p.id).error, { code: 'BAD', message: 'bad input' });
  assert.equal(m.get(p.id).attempts, 1);
  const retried = m.retry(p.id);
  assert.ok(retried.job.id !== p.id);
  await m.shutdown();
});
