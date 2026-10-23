// In-process job manager: typed queues with concurrency limits, duplicate
// suppression, cancellation, automatic retry of transient failures, bounded
// logs and TTL-based cleanup. Long work runs outside the request cycle.
import { newId } from '../lib/ids.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function createJobManager({ logger, limits = {}, ttlMs = 2 * 60 * 60_000, maxJobs = 300 } = {}) {
  const jobs = new Map();
  const handlers = new Map(); // type -> { run, stages, maxAttempts }
  const running = new Map(); // type -> count
  const controllers = new Map();

  function publicView(job) {
    const { _payload, ...rest } = job;
    return { ...rest, logs: rest.logs.slice(-80) };
  }

  function log(job, line) {
    job.logs.push({ t: new Date().toISOString(), msg: String(line).slice(0, 300) });
    if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
    job.updatedAt = new Date().toISOString();
  }

  function cleanup() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (TERMINAL.has(job.status) && now - Date.parse(job.finishedAt) > ttlMs) jobs.delete(id);
    }
    if (jobs.size > maxJobs) {
      const done = [...jobs.values()].filter(j => TERMINAL.has(j.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const j of done.slice(0, jobs.size - maxJobs)) jobs.delete(j.id);
    }
  }
  const timer = setInterval(cleanup, 60_000);
  timer.unref();

  function pump(type) {
    const h = handlers.get(type);
    const limit = limits[type] ?? 1;
    while ((running.get(type) || 0) < limit) {
      const next = [...jobs.values()].find(j => j.type === type && j.status === 'queued');
      if (!next) return;
      execute(next, h);
    }
  }

  async function execute(job, h) {
    running.set(job.type, (running.get(job.type) || 0) + 1);
    const controller = new AbortController();
    controllers.set(job.id, controller);
    job.status = 'running';
    job.attempts += 1;
    job.startedAt = job.startedAt || new Date().toISOString();
    log(job, job.attempts > 1 ? `Retrying (attempt ${job.attempts}/${h.maxAttempts})` : 'Job started');
    const ctx = {
      signal: controller.signal,
      progress(stageIndex, progress, line) {
        if (TERMINAL.has(job.status)) return;
        if (stageIndex != null) {
          job.stageIndex = stageIndex;
          job.stage = job.stages[stageIndex] ?? job.stage;
        }
        if (progress != null) job.progress = Math.max(job.progress, Math.min(99, Math.round(progress)));
        if (line) log(job, line);
        job.updatedAt = new Date().toISOString();
      },
      setStage(name, progress, line) {
        let idx = job.stages.indexOf(name);
        if (idx < 0) idx = job.stageIndex;
        this.progress(idx, progress, line);
      },
      log: (line) => log(job, line),
    };
    try {
      const result = await h.run(job._payload, ctx, job);
      if (job.status === 'cancelled') return;
      job.status = 'completed';
      job.progress = 100;
      job.stage = 'Complete';
      job.stageIndex = job.stages.length;
      job.result = result;
      log(job, 'Job completed');
    } catch (err) {
      if (controller.signal.aborted || job.status === 'cancelled') {
        job.status = 'cancelled';
        log(job, 'Job cancelled');
      } else if (err.transient && job.attempts < h.maxAttempts) {
        job.status = 'queued';
        log(job, `Transient failure: ${err.message}`);
        setTimeout(() => pump(job.type), 1500 * job.attempts).unref();
      } else {
        job.status = 'failed';
        job.error = { code: err.code || 'JOB_FAILED', message: err.message || 'The job failed.', ...(err.details ? { details: err.details } : {}) };
        log(job, `Failed: ${job.error.message}`);
        logger?.warn?.('job failed', { jobId: job.id, type: job.type, code: job.error.code, msg: job.error.message });
      }
    } finally {
      if (TERMINAL.has(job.status)) job.finishedAt = new Date().toISOString();
      controllers.delete(job.id);
      running.set(job.type, (running.get(job.type) || 1) - 1);
      setImmediate(() => pump(job.type));
    }
  }

  return {
    register(type, { run, stages, maxAttempts = 1 }) {
      handlers.set(type, { run, stages, maxAttempts });
    },
    /** Creates a job, or returns the active job with the same dedupe key. */
    enqueue(type, payload, { key, meta = {} } = {}) {
      const h = handlers.get(type);
      if (!h) throw new Error(`unknown job type ${type}`);
      if (key) {
        const existing = [...jobs.values()].find(j => j.type === type && j.key === key && !TERMINAL.has(j.status));
        if (existing) return { job: publicView(existing), deduplicated: true };
      }
      const queuedCount = [...jobs.values()].filter(j => j.type === type && j.status === 'queued').length;
      if (queuedCount >= 20) {
        const err = new Error('Too many jobs are queued. Try again shortly.');
        err.status = 503; err.code = 'QUEUE_FULL';
        throw err;
      }
      const now = new Date().toISOString();
      const job = {
        id: newId('job'), type, key: key || null, status: 'queued', stage: 'Queued', stageIndex: -1, stages: h.stages,
        progress: 0, attempts: 0, logs: [], error: null, result: null, meta,
        createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, _payload: payload,
      };
      jobs.set(job.id, job);
      log(job, 'Job queued');
      cleanup();
      setImmediate(() => pump(type));
      return { job: publicView(job), deduplicated: false };
    },
    get(id) { const j = jobs.get(id); return j ? publicView(j) : null; },
    list({ type, active } = {}) {
      return [...jobs.values()]
        .filter(j => (!type || j.type === type) && (!active || !TERMINAL.has(j.status)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(publicView);
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (TERMINAL.has(job.status)) return publicView(job);
      if (job.status === 'queued') {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        log(job, 'Job cancelled before it started');
      } else {
        job.status = 'cancelled';
        log(job, 'Cancellation requested');
        controllers.get(id)?.abort();
      }
      return publicView(job);
    },
    retry(id) {
      const job = jobs.get(id);
      if (!job || !['failed', 'cancelled'].includes(job.status)) return null;
      return this.enqueue(job.type, job._payload, { key: job.key, meta: job.meta });
    },
    activeCount() { return [...jobs.values()].filter(j => !TERMINAL.has(j.status)).length; },
    async shutdown() {
      clearInterval(timer);
      for (const [id] of controllers) this.cancel(id);
    },
  };
}
