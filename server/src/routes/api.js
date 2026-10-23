import express from 'express';
import path from 'node:path';
import { z } from 'zod';
import { validateBody, rateLimit } from '../middleware/index.js';
import { normalizeTargetUrl, checkHostAndPort } from '../security/targetPolicy.js';
import { notFound, AppError, unavailable } from '../lib/errors.js';
import { isValidId } from '../lib/ids.js';
import { projectSummary, renderSummary } from '../store/fileStore.js';
import { RESOLUTIONS } from '../render/renderService.js';

export const renderOptionsSchema = z.object({
  resolution: z.enum(Object.keys(RESOLUTIONS)).default('720p'),
  fps: z.union([z.literal(24), z.literal(30)]).default(24),
  ttsProvider: z.enum(['auto', 'system', 'mespeak', 'openai', 'elevenlabs']).default('auto'),
  voice: z.string().max(80).regex(/^[\w .()'-]*$/, 'voice contains unsupported characters').optional(),
  rate: z.number().int().min(-5).max(5).default(0),
  burnCaptions: z.boolean().default(true),
}).strict();

export const analyzeSchema = z.object({
  url: z.string().trim().min(1, 'url is required').max(2048),
  browser: z.boolean().default(true),
  targetDurationSec: z.number().int().min(90).max(300).default(180),
  autoRender: z.boolean().default(false),
  render: renderOptionsSchema.optional(),
}).strict();

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

const MEDIA_TYPES = { mp4: 'video/mp4', jpg: 'image/jpeg', jpeg: 'image/jpeg', vtt: 'text/vtt; charset=utf-8', srt: 'application/x-subrip; charset=utf-8', wav: 'audio/wav' };

/**
 * Streams a stored file with Range support and an explicit Content-Type.
 * The directory is passed as `root` so the dot-file rule only applies to the
 * file name itself — StackReel's default data folder is "server/.data", and
 * without `root` Express rejects every file beneath it with 404 (this was the
 * cause of "Video unavailable" and broken thumbnails on default installs).
 */
function serveFile(res, next, fullPath, { cache = 'private, max-age=3600' } = {}) {
  const name = path.basename(fullPath);
  const ext = name.split('.').pop().toLowerCase();
  res.setHeader('Cache-Control', cache);
  res.sendFile(name, {
    root: path.dirname(fullPath),
    dotfiles: 'deny',
    acceptRanges: true,
    headers: MEDIA_TYPES[ext] ? { 'Content-Type': MEDIA_TYPES[ext] } : {},
  }, (err) => {
    if (!err) return;
    if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' || res.headersSent) return; // client stopped a range request
    next(new AppError(err.status === 416 ? 416 : 404, err.status === 416 ? 'RANGE_NOT_SATISFIABLE' : 'FILE_UNREADABLE', err.status === 416 ? 'Requested byte range is outside the file.' : `The file exists in the render record but could not be read from disk (${err.code || err.message}).`));
  });
}

export function createApiRouter({ cfg, store, jobs, capabilities, logger }) {
  const r = express.Router();

  // ── health ──────────────────────────────────────────────────────────────
  r.get('/health', (req, res) => ok(res, { status: 'ok', service: 'stackreel-api', version: '2.0.0', uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() }));

  r.get('/ready', async (req, res, next) => {
    try {
      const caps = await capabilities.get();
      let storage = true;
      try { await store.checkWritable(); } catch { storage = false; }
      const checks = {
        storage: { ok: storage },
        ffmpeg: { ok: caps.media.ffmpeg.available && caps.media.ffprobe.available, detail: caps.media.ffmpeg.version || caps.media.ffmpeg.error },
        browser: { ok: caps.browser.available, detail: caps.browser.reason, optional: true },
        tts: { ok: Boolean(caps.tts.default), detail: caps.tts.default ? `default provider: ${caps.tts.default}` : `configured provider "${caps.tts.configured}" is unavailable` },
      };
      const ready = checks.storage.ok && checks.ffmpeg.ok && checks.tts.ok;
      res.status(ready ? 200 : 503).json({ ok: ready, data: { ready, checks } });
    } catch (err) { next(err); }
  });

  r.get('/capabilities', async (req, res, next) => {
    try { ok(res, await capabilities.get(req.query.refresh === '1')); } catch (err) { next(err); }
  });

  // ── analyses ────────────────────────────────────────────────────────────
  r.post('/analyses', rateLimit({ ...cfg.rateLimit, max: cfg.rateLimit.maxAnalyses, name: 'analysis' }), validateBody(analyzeSchema), (req, res, next) => {
    try {
      const input = req.valid;
      const url = normalizeTargetUrl(input.url); // fast, synchronous rejection of bad input
      checkHostAndPort(url, cfg.analysis);
      const key = `${url.href}|${input.browser}`;
      const { job, deduplicated } = jobs.enqueue('analysis', { ...input, url: url.href }, { key, meta: { url: url.href, host: url.hostname } });
      ok(res, { job, deduplicated }, deduplicated ? 200 : 202);
    } catch (err) { next(err); }
  });

  // ── jobs ────────────────────────────────────────────────────────────────
  r.get('/jobs', (req, res) => ok(res, jobs.list({ type: req.query.type, active: req.query.active === '1' })));
  r.get('/jobs/:id', (req, res, next) => {
    if (!isValidId('job', req.params.id)) return next(notFound('Job not found.'));
    const job = jobs.get(req.params.id);
    if (!job) return next(notFound('Job not found. Jobs are kept in memory and are cleared when the server restarts.'));
    ok(res, job);
  });
  r.post('/jobs/:id/cancel', (req, res, next) => {
    const job = isValidId('job', req.params.id) && jobs.cancel(req.params.id);
    if (!job) return next(notFound('Job not found.'));
    ok(res, job);
  });
  r.post('/jobs/:id/retry', (req, res, next) => {
    const out = isValidId('job', req.params.id) && jobs.retry(req.params.id);
    if (!out) return next(new AppError(409, 'NOT_RETRYABLE', 'Only failed or cancelled jobs can be retried.'));
    ok(res, out, 202);
  });

  // ── projects ────────────────────────────────────────────────────────────
  r.get('/projects', async (req, res, next) => {
    try { ok(res, await store.listProjects()); } catch (err) { next(err); }
  });
  r.get('/projects/:id', async (req, res, next) => {
    try {
      const p = await store.getProject(req.params.id);
      if (!p) throw notFound('Project not found.');
      ok(res, p);
    } catch (err) { next(err); }
  });
  r.delete('/projects/:id', async (req, res, next) => {
    try {
      if (!(await store.deleteProject(req.params.id))) throw notFound('Project not found.');
      ok(res, { deleted: req.params.id });
    } catch (err) { next(err); }
  });
  r.get('/projects/:id/screenshot', (req, res, next) => {
    if (!isValidId('project', req.params.id)) return next(notFound());
    const file = store.screenshotPath(req.params.id);
    if (!file) return next(notFound('No screenshot for this project.'));
    serveFile(res, next, file, { cache: 'private, max-age=86400' });
  });

  // ── renders ─────────────────────────────────────────────────────────────
  r.post('/projects/:id/renders', rateLimit({ ...cfg.rateLimit, max: cfg.rateLimit.maxRenders, name: 'render' }), validateBody(renderOptionsSchema), async (req, res, next) => {
    try {
      const project = await store.getProject(req.params.id);
      if (!project) throw notFound('Project not found.');
      const caps = await capabilities.get();
      if (!caps.media.ffmpeg.available) throw unavailable('FFMPEG_UNAVAILABLE', `FFmpeg is not available (${caps.media.ffmpeg.error}). Run "npm install" again or set FFMPEG_PATH.`);
      const provider = caps.tts.providers.find(p => p.id === (req.valid.ttsProvider === 'auto' ? caps.tts.default : req.valid.ttsProvider));
      if (!provider?.available) throw unavailable('TTS_UNAVAILABLE', `Narration provider "${req.valid.ttsProvider}" is not available${provider?.reason ? `: ${provider.reason}` : ''}.`);
      const key = `${project.id}|${JSON.stringify(req.valid)}`;
      const { job, deduplicated } = jobs.enqueue('render', { projectId: project.id, options: req.valid }, { key, meta: { projectId: project.id, host: project.site.host } });
      ok(res, { job, deduplicated }, deduplicated ? 200 : 202);
    } catch (err) { next(err); }
  });
  r.get('/renders', async (req, res, next) => {
    try {
      const projectId = req.query.projectId;
      if (projectId && !isValidId('project', projectId)) throw notFound('Project not found.');
      ok(res, (await store.listRenders({ projectId })).map(renderSummary));
    } catch (err) { next(err); }
  });
  r.get('/renders/:id', async (req, res, next) => {
    try {
      const rec = await store.getRender(req.params.id);
      if (!rec) throw notFound('Render not found.');
      ok(res, rec);
    } catch (err) { next(err); }
  });
  r.delete('/renders/:id', async (req, res, next) => {
    try {
      if (!(await store.getRender(req.params.id))) throw notFound('Render not found.');
      await store.deleteRender(req.params.id);
      ok(res, { deleted: req.params.id });
    } catch (err) { next(err); }
  });
  r.get('/renders/:id/files/:file', async (req, res, next) => {
    try {
      // Only completed (verified) renders are downloadable; names are allow-listed.
      const rec = await store.getRender(req.params.id);
      if (!rec) throw notFound('Render not found. It may have been deleted.');
      const file = store.renderFilePath(req.params.id, req.params.file);
      if (!file) throw notFound(`"${String(req.params.file).slice(0, 40)}" is not available for this render.`);
      if (req.query.download === '1') {
        const ext = req.params.file.split('.').pop();
        const safeHost = rec.host.replace(/[^a-z0-9.-]/gi, '_');
        res.attachment(req.params.file === 'video.mp4' ? `stackreel-${safeHost}.mp4` : `stackreel-${safeHost}-${req.params.file.replace(/\.[a-z0-9]+$/, '')}.${ext}`);
      }
      serveFile(res, next, file);
    } catch (err) { next(err); }
  });

  // ── stats (real counts only) ────────────────────────────────────────────
  r.get('/stats', async (req, res, next) => {
    try {
      const projects = await store.listProjects();
      const renders = await store.listRenders();
      const techCounts = new Map();
      for (const p of projects) for (const t of p.topTechnologies) techCounts.set(t, (techCounts.get(t) || 0) + 1);
      ok(res, {
        analyses: projects.length,
        videos: renders.length,
        videoSeconds: Math.round(renders.reduce((a, r) => a + (r.durationSec || 0), 0)),
        componentsMapped: projects.reduce((a, p) => a + p.counts.observed + p.counts.inferred + p.counts.unknown, 0),
        topTechnologies: [...techCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count })),
        activeJobs: jobs.activeCount(),
      });
    } catch (err) { next(err); }
  });

  return r;
}

export { projectSummary };
