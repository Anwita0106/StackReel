// Integration tests: the real Express app + real pipeline against local
// fixture websites. Includes an actual MP4 render verified with ffprobe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { startFixtures } from './fixtures/site.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { resolveMediaTools, probeMedia, measureMediaAudio } from '../src/render/media.js';

let fx; let app; let jobs; let dataDir; let cfg;
const ORIGIN = 'http://localhost:5173';

async function waitForJob(id, { timeoutMs = 120_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const res = await request(app).get(`/api/jobs/${id}`);
    const job = res.body.data;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} timed out at ${job.stage}`);
    await new Promise(r => setTimeout(r, 250));
  }
}
const analyze = (url, extra = {}) => request(app).post('/api/analyses').set('content-type', 'application/json').send({ url, ...extra });

before(async () => {
  fx = await startFixtures();
  // Mirror the real default location (server/.data): a dot-folder in the path broke all media serving once.
  dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stackreel-test-')), 'server', '.data');
  process.env.TEST_ALLOWED_TARGETS = fx.allowedTargets.join(',');
  process.env.DATA_DIR = dataDir;
  cfg = loadConfig({ rateLimit: { maxAnalyses: 100, maxRenders: 100 } });
  ({ app, jobs } = await createApp(cfg, { logger: createLogger({ level: 'silent' }) }));
});
after(async () => {
  await jobs.shutdown();
  await fx.close();
  fs.rmSync(path.dirname(path.dirname(dataDir)), { recursive: true, force: true });
});

test('health and readiness endpoints', async () => {
  const h = await request(app).get('/api/health').expect(200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.data.status, 'ok');
  const r = await request(app).get('/api/ready');
  assert.ok([200, 503].includes(r.status));
  assert.ok(r.body.data.checks.storage.ok);
  assert.ok(r.body.data.checks.ffmpeg.ok, 'bundled FFmpeg should be available');
});

test('unknown API routes return a JSON 404', async () => {
  const r = await request(app).get('/api/nope').expect(404);
  assert.equal(r.body.error.code, 'ROUTE_NOT_FOUND');
});

test('CORS: allowed origin gets headers, preflight works, other origins get a clear 403', async () => {
  const ok = await request(app).get('/api/health').set('Origin', ORIGIN).expect(200);
  assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
  const pre = await request(app).options('/api/analyses').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST').expect(204);
  assert.match(pre.headers['access-control-allow-methods'], /POST/);
  const bad = await request(app).get('/api/health').set('Origin', 'https://evil.example').expect(403);
  assert.equal(bad.body.error.code, 'CORS_ORIGIN_NOT_ALLOWED');
  assert.match(bad.body.error.message, /CORS_ORIGINS/);
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
  await request(app).get('/api/health').expect(200); // no Origin (curl) is fine
});

test('request validation: missing url, bad JSON, unknown fields', async () => {
  assert.equal((await analyze(undefined).expect(400)).body.error.code, 'VALIDATION_ERROR');
  const badJson = await request(app).post('/api/analyses').set('content-type', 'application/json').send('{"url":').expect(400);
  assert.equal(badJson.body.error.code, 'INVALID_JSON');
  assert.equal((await analyze('example.com', { evil: true }).expect(400)).body.error.code, 'VALIDATION_ERROR');
});

test('SSRF: internal, metadata and disallowed-port targets are rejected before any job is created', async () => {
  for (const url of ['http://localhost:5001', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://metadata.google.internal/', `http://127.0.0.1:${fx.internalPort}/`, 'example.com:22']) {
    const r = await analyze(url).expect(422);
    assert.equal(r.body.error.code, 'TARGET_NOT_ALLOWED', url);
  }
  assert.equal(fx.hits.internal, 0);
});

test('redirects: followed and re-validated; redirect to internal or metadata address is blocked; loops are capped', async () => {
  const internal = await waitForJob((await analyze(`${fx.siteUrl}/redirect-internal`, { browser: false }).expect(202)).body.data.job.id);
  assert.equal(internal.status, 'failed');
  assert.equal(internal.error.code, 'TARGET_NOT_ALLOWED');
  const meta = await waitForJob((await analyze(`${fx.siteUrl}/redirect-metadata`, { browser: false }).expect(202)).body.data.job.id);
  assert.equal(meta.error.code, 'TARGET_NOT_ALLOWED');
  const loop = await waitForJob((await analyze(`${fx.siteUrl}/loop`, { browser: false }).expect(202)).body.data.job.id);
  assert.equal(loop.error.code, 'TOO_MANY_REDIRECTS');
  assert.equal(fx.hits.internal, 0);
});

test('robots.txt disallow is honoured', async () => {
  const job = await waitForJob((await analyze(`${fx.siteUrl}/private`, { browser: false }).expect(202)).body.data.job.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'ROBOTS_DISALLOWED');
});

test('response-size limit truncates large documents and records the limitation', async () => {
  const job = await waitForJob((await analyze(`${fx.siteUrl}/big`, { browser: false }).expect(202)).body.data.job.id);
  assert.equal(job.status, 'completed');
  const p = (await request(app).get(`/api/projects/${job.result.projectId}`).expect(200)).body.data;
  assert.equal(p.http.htmlTruncated, true);
  assert.ok(p.http.htmlBytes <= cfg.analysis.maxHtmlBytes);
  assert.ok(p.unavailable.some(u => /truncated/.test(u)));
});

test('unreachable targets fail honestly (after one automatic retry) and create no project', async () => {
  const before = (await request(app).get('/api/projects')).body.data.length;
  const job = await waitForJob((await analyze(`http://localhost:${fx.deadPort}/`, { browser: false }).expect(202)).body.data.job.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'TARGET_UNREACHABLE');
  assert.equal(job.attempts, 2, 'transient network errors are retried once');
  assert.equal((await request(app).get('/api/projects')).body.data.length, before);
});

test('HTTP error pages are analyzed but the limitation is recorded', async () => {
  const job = await waitForJob((await analyze(`${fx.siteUrl}/missing-page`, { browser: false }).expect(202)).body.data.job.id);
  assert.equal(job.status, 'completed');
  const p = (await request(app).get(`/api/projects/${job.result.projectId}`)).body.data;
  assert.equal(p.http.status, 404);
  assert.ok(p.unavailable.some(u => /HTTP 404/.test(u)));
});

test('duplicate submissions while running return the same job', async () => {
  const a = await analyze(`${fx.siteUrl}/static`, { browser: false }).expect(202);
  const b = await analyze(`${fx.siteUrl}/static`, { browser: false }).expect(200);
  assert.equal(b.body.data.deduplicated, true);
  assert.equal(a.body.data.job.id, b.body.data.job.id);
  await waitForJob(a.body.data.job.id);
});

let projectId;
test('full analysis of the fixture site produces evidence-backed architecture and script', async () => {
  const start = await analyze(fx.siteUrl, { targetDurationSec: 90 }).expect(202);
  const job = await waitForJob(start.body.data.job.id);
  assert.equal(job.status, 'completed', job.error?.message);
  assert.ok(job.logs.length > 5);
  projectId = job.result.projectId;
  const p = (await request(app).get(`/api/projects/${projectId}`).expect(200)).body.data;

  const tech = Object.fromEntries(p.technologies.map(t => [t.id, t]));
  assert.equal(tech.nginx.version, '1.25.3');
  assert.equal(tech.express.status, 'observed');
  assert.equal(tech.nextjs.status, 'observed');
  const evidenceIds = new Set(p.evidence.map(e => e.id));
  for (const n of p.graph.nodes) for (const id of n.evidenceIds) assert.ok(evidenceIds.has(id), `node ${n.id} references missing evidence`);
  assert.ok(p.graph.nodes.some(n => n.status === 'inferred'));
  assert.equal(p.script.scenes.length, 6);
  assert.match(p.script.scenes[0].narration, /observed/i);

  // Privacy: cookie values and query-string values are never stored.
  const raw = JSON.stringify(p);
  assert.equal(raw.includes('SECRETVALUE123'), false);
  assert.equal(raw.includes('token=abc'), false);

  if (p.browser?.ok) {
    assert.ok(p.traffic.apiHosts.some(a => a.samplePaths.includes('/api/products')), 'API call observed in browser');
    assert.ok(p.traffic.graphql, 'GraphQL detected');
    assert.ok(p.browser.requests.some(r => r.blocked), 'internal subrequests were blocked by the egress proxy');
    assert.ok(!p.graph.nodes.some(n => n.label.includes('169.254')), 'blocked destinations are not architecture');
    assert.ok(p.security.findings.some(f => f.id === 'internal-requests'));
  } else {
    assert.ok(p.unavailable.some(u => /Browser/.test(u)), 'missing browser evidence is reported');
  }
  assert.equal(fx.hits.internal, 0, 'the internal service must never be contacted');
});

test('projects list returns summaries; unknown/invalid ids are 404', async () => {
  const list = (await request(app).get('/api/projects').expect(200)).body.data;
  assert.ok(list.some(p => p.id === projectId));
  assert.ok(list.every(p => p.counts && !p.evidence));
  await request(app).get('/api/projects/prj_0000000000000000').expect(404);
  await request(app).get('/api/projects/..%2F..%2Fetc').expect(404);
});

test('render is refused for an unavailable narration provider', async () => {
  const r = await request(app).post(`/api/projects/${projectId}/renders`).send({ ttsProvider: 'openai' }).expect(503);
  assert.equal(r.body.error.code, 'TTS_UNAVAILABLE');
  await request(app).post(`/api/projects/${projectId}/renders`).send({ resolution: '8k' }).expect(400);
});

let renderId;
test('renders a real MP4 with narration, verifies it, and serves it with range support', { timeout: 600_000 }, async () => {
  const start = await request(app).post(`/api/projects/${projectId}/renders`).send({ resolution: '480p', fps: 24, ttsProvider: 'mespeak' }).expect(202);
  const job = await waitForJob(start.body.data.job.id, { timeoutMs: 580_000 });
  assert.equal(job.status, 'completed', job.error?.message);
  assert.deepEqual(job.stages, ['Synthesizing narration', 'Building timeline', 'Rendering frames', 'Verifying output']);
  renderId = job.result.renderId;

  const rec = (await request(app).get(`/api/renders/${renderId}`).expect(200)).body.data;
  assert.equal(rec.probe.video.codec, 'h264');
  assert.equal(rec.probe.audio.codec, 'aac');
  assert.equal(rec.width, 854);
  assert.equal(rec.timeline.scenes.length, 6);
  assert.ok(rec.waveform.some(v => v > 0.05), 'narration audio is not silent');

  const file = path.join(dataDir, 'renders', renderId, 'video.mp4');
  const probe = await probeMedia(resolveMediaTools(cfg.render), file);
  assert.ok(Math.abs(probe.durationSec - rec.timeline.duration) < 1.5);

  const ranged = await request(app).get(`/api/renders/${renderId}/files/video.mp4`).set('Range', 'bytes=0-1023').expect(206);
  assert.equal(ranged.body.length, 1024);
  assert.equal(ranged.body.subarray(4, 8).toString('ascii'), 'ftyp');
  const dl = await request(app).get(`/api/renders/${renderId}/files/video.mp4?download=1`).set('Range', 'bytes=0-10').expect(206);
  assert.match(dl.headers['content-disposition'], /attachment; filename="?stackreel-localhost\.mp4/);
  const vtt = await request(app).get(`/api/renders/${renderId}/files/captions.vtt`).expect(200);
  assert.match(vtt.text, /^WEBVTT/);
  assert.match(vtt.headers['content-type'], /text\/vtt/);
  assert.ok(rec.timeline.captions.length >= 6 && rec.timeline.captions.every(c => c.text.length > 3 && c.end > c.start));
});

test('media is served with correct types, lengths and ranges from the default .data folder', async () => {
  const base = `/api/renders/${renderId}/files`;
  const full = await request(app).get(`${base}/video.mp4`).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(Number(full.headers['content-length']), full.body.length);
  const head = await request(app).head(`${base}/video.mp4`).expect(200);
  assert.equal(head.headers['content-type'], 'video/mp4');
  const mid = await request(app).get(`${base}/video.mp4`).set('Range', 'bytes=1000-1999').expect(206);
  assert.match(mid.headers['content-range'], new RegExp(`^bytes 1000-1999/${full.body.length}$`));
  await request(app).get(`${base}/video.mp4`).set('Range', `bytes=${full.body.length + 10}-`).expect(416);
  for (const f of ['poster.jpg', 'thumb-1.jpg', 'thumb-6.jpg']) {
    const r = await request(app).get(`${base}/${f}`).expect(200);
    assert.equal(r.headers['content-type'], 'image/jpeg', f);
    assert.ok(r.body.length > 1000, `${f} is a real image`);
  }
  const shot = await request(app).get(`/api/projects/${projectId}/screenshot`);
  if (shot.status === 200) assert.equal(shot.headers['content-type'], 'image/jpeg');
  const missingFile = await request(app).get(`${base}/thumb-9.jpg`).expect(404);
  assert.match(missingFile.body.error.message, /not available/);
});

test('narration is real speech: measured per scene and decoded back out of the finished MP4', async () => {
  const rec = (await request(app).get(`/api/renders/${renderId}`)).body.data;
  assert.equal(rec.audio.speech.length, 6);
  for (const s of rec.audio.speech) {
    assert.ok(s.seconds > 1, `scene ${s.scene} has ${s.seconds}s of speech`);
    assert.ok(s.peakDb > -30 && s.voiced > 0.15, `scene ${s.scene} is audible`);
  }
  // Independent check against the actual AAC stream in the MP4.
  const levels = await measureMediaAudio(resolveMediaTools(cfg.render), path.join(dataDir, 'renders', renderId, 'video.mp4'));
  assert.ok(levels.peak > 0.3, `final audio peak ${levels.peakDb} dB`);
  assert.ok(levels.peak <= 1.0);
  assert.ok(levels.voicedRatio > 0.3, `speech present in ${Math.round(levels.voicedRatio * 100)}% of the video`);
  // Captions sit inside their scene's speech window.
  for (const c of rec.timeline.captions) {
    const sc = rec.timeline.scenes[c.sceneIndex];
    assert.ok(c.start >= sc.speechStart - 0.01 && c.end <= sc.speechEnd + 0.01);
  }
  assert.ok(Math.abs(rec.durationSec - rec.timeline.duration) < 1.5);
});

test('when the default voice fails, narration falls back to the offline voice and says so', { timeout: 600_000 }, async () => {
  const { app: fbApp, jobs: fbJobs } = await createApp(loadConfig({ dataDir, tts: { testFailAuto: true }, rateLimit: { maxRenders: 100 } }), { logger: createLogger({ level: 'silent' }) });
  const start = await request(fbApp).post(`/api/projects/${projectId}/renders`).send({ resolution: '480p', fps: 24, ttsProvider: 'auto' }).expect(202);
  let job;
  for (;;) {
    job = (await request(fbApp).get(`/api/jobs/${start.body.data.job.id}`)).body.data;
    if (['completed', 'failed'].includes(job.status)) break;
    await new Promise(r => setTimeout(r, 300));
  }
  assert.equal(job.status, 'completed', job.error?.message);
  assert.ok(job.logs.some(l => /retrying all scenes with the built-in offline voice/.test(l.msg)));
  const rec = (await request(fbApp).get(`/api/renders/${job.result.renderId}`)).body.data;
  assert.equal(rec.tts.provider, 'mespeak');
  assert.match(rec.tts.fallbackFrom, /Simulated voice failure/);
  await request(fbApp).delete(`/api/renders/${job.result.renderId}`).expect(200);
  await fbJobs.shutdown();
});

test('download path safety: traversal, unknown files and malformed ids are refused', async () => {
  for (const p of [
    `/api/renders/${renderId}/files/..%2Frender.json`,
    `/api/renders/${renderId}/files/render.json`,
    `/api/renders/${renderId}/files/..%2F..%2Fprojects`,
    '/api/renders/rnd_zzzz/files/video.mp4',
    '/api/renders/../projects/files/video.mp4',
    `/api/renders/rnd_0000000000000000/files/video.mp4`,
  ]) {
    const r = await request(app).get(p);
    assert.equal(r.status, 404, p);
  }
});

test('render failures are reported honestly and leave no files or records behind', async () => {
  const { app: limitedApp, jobs: limitedJobs } = await createApp(loadConfig({ dataDir, render: { maxDurationSec: 10 }, rateLimit: { maxRenders: 100 } }), { logger: createLogger({ level: 'silent' }) });
  const rendersBefore = fs.readdirSync(path.join(dataDir, 'renders')).length;
  const start = await request(limitedApp).post(`/api/projects/${projectId}/renders`).send({ resolution: '480p', fps: 24, ttsProvider: 'mespeak' }).expect(202);
  let job;
  for (;;) {
    job = (await request(limitedApp).get(`/api/jobs/${start.body.data.job.id}`)).body.data;
    if (['completed', 'failed'].includes(job.status)) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(job.status, 'failed');
  assert.match(job.error.message, /above the 10s limit/);
  assert.equal(fs.readdirSync(path.join(dataDir, 'renders')).length, rendersBefore, 'failed render directory was removed');
  await limitedJobs.shutdown();
});

test('stats reflect only real stored work', async () => {
  const s = (await request(app).get('/api/stats').expect(200)).body.data;
  assert.ok(s.analyses >= 1);
  assert.equal(s.videos, 1);
  assert.ok(s.videoSeconds > 30);
});

test('cancelling a running analysis', async () => {
  const start = await analyze(fx.siteUrl, { browser: true }).expect(202);
  await request(app).post(`/api/jobs/${start.body.data.job.id}/cancel`).expect(200);
  const job = await waitForJob(start.body.data.job.id);
  assert.equal(job.status, 'cancelled');
});
