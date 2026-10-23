#!/usr/bin/env node
// Regenerates the README screenshots (docs/screenshots/*.jpg) from a real run:
// local fixture website → analysis → render → every view in dark and light.
//
//   npm run build && npm run screenshots
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'server', 'package.json'));
const { chromium } = require('playwright');
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
const { startFixtures } = await import(path.join(root, 'server/test/fixtures/site.js'));
const out = path.join(root, 'docs', 'screenshots');
const tmpPng = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-shots-'));
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(path.join(root, 'client/dist/index.html'))) { console.error('Run "npm run build" first.'); process.exit(1); }

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const fx = await startFixtures();
const port = await freePort();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-shots-data-'));
const host = 'demo-shop.test';
const server = spawn(process.execPath, [path.join(root, 'server/src/index.js')], {
  env: { ...process.env, NODE_ENV: 'test', PORT: String(port), SERVE_CLIENT: 'true', LOG_LEVEL: 'warn', DATA_DIR: path.join(tmpRoot, '.data'),
    TEST_ALLOWED_TARGETS: `${host}:${fx.sitePort},127.0.0.1:${fx.thirdPartyPort}`, TEST_HOST_MAP: `${host}=127.0.0.1` },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const base = `http://127.0.0.1:${port}`;
const shot = async (page, name, opts = {}) => {
  const png = path.join(tmpPng, `${name}.png`);
  await page.screenshot({ path: png, ...opts });
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-q:v', '3', path.join(out, `${name}.jpg`)]);
  console.log('  saved', `${name}.jpg`);
};
let browser;
try {
  for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
  // Analysis + 480p render through the API (fast), then screenshot the UI.
  const post = (p, body) => fetch(`${base}/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const waitJob = async (id) => { for (;;) { const j = (await (await fetch(`${base}/api/jobs/${id}`)).json()).data; if (['completed', 'failed'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 1000)); } };
  console.log('Analyzing fixture site…');
  const a = await waitJob((await post('/analyses', { url: `http://${host}:${fx.sitePort}/`, targetDurationSec: 90 })).data.job.id);
  if (a.status !== 'completed') throw new Error(a.error?.message);
  const projectId = a.result.projectId;
  console.log('Rendering video…');
  const r = await waitJob((await post(`/projects/${projectId}/renders`, { resolution: '720p', fps: 24, ttsProvider: 'mespeak' })).data.job.id);
  if (r.status !== 'completed') throw new Error(r.error?.message);
  const rec = (await (await fetch(`${base}/api/renders/${r.result.renderId}`)).json()).data;
  const video = path.join(tmpRoot, '.data', 'renders', r.result.renderId, 'video.mp4');
  const sc = rec.timeline.scenes;
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '3.5', '-i', video, '-frames:v', '1', '-q:v', '3', path.join(out, 'video-frame-title.jpg')]);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(sc[2].end - 0.5, sc[2].start + 7)), '-i', video, '-frames:v', '1', '-q:v', '3', path.join(out, 'video-frame-scene.jpg')]);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(sc[4].end - 0.5, sc[4].start + 7)), '-i', video, '-frames:v', '1', '-q:v', '3', path.join(out, 'video-frame-security.jpg')]);
  console.log('  saved video frames');

  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const settle = (ms = 2600) => page.waitForTimeout(ms);
    await page.goto(`${base}/#/dashboard`);
    await page.getByTestId('recent-projects').waitFor();
    await settle(3500);
    await shot(page, `dashboard-${theme}`);
    await page.goto(`${base}/#/explorer/${projectId}`);
    await page.getByTestId('flow-canvas').waitFor();
    await settle();
    await shot(page, `explorer-${theme}`);
    if (theme === 'dark') {
      await page.getByTestId('node-be-express').click();
      await settle(1200);
      await shot(page, 'explorer-evidence-panel');
      await page.goto(`${base}/#/security/${projectId}`);
      await page.getByTestId('finding').first().waitFor();
      await settle(1500);
      await shot(page, 'security');
      await page.goto(`${base}/#/evidence/${projectId}`);
      await settle(5000); // let the terminal finish typing
      await shot(page, 'evidence');
    }
    await page.goto(`${base}/#/studio/${projectId}`);
    await page.getByTestId('video-player').waitFor();
    await page.evaluate((t) => { const v = document.querySelector('[data-testid="video-player"]'); v.currentTime = t; }, sc[1].start + 7);
    await settle(2000);
    await shot(page, `studio-${theme}`);
    if (theme === 'light') {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/#/dashboard`);
      await settle(3000);
      await shot(page, 'mobile');
    }
    await ctx.close();
  }
  console.log(`Screenshots written to ${path.relative(process.cwd(), out)}/`);
} catch (err) {
  console.error('Screenshot run failed:', err.message);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
  await fx.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpPng, { recursive: true, force: true });
}
