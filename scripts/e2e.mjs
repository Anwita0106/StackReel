#!/usr/bin/env node
// End-to-end test: real server + built UI + local fixture website, driven by
// Chromium. Verifies the whole product path and saves screenshots.
//
//   npm run build && npm run test:e2e
//
// Env: BROWSER_EXECUTABLE_PATH (optional), E2E_HEADFUL=1, E2E_RESOLUTION=480p
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'server', 'package.json'));
const { chromium } = require('playwright');
const { startFixtures } = await import(path.join(root, 'server/test/fixtures/site.js'));
const out = path.join(root, 'e2e-artifacts');
fs.mkdirSync(out, { recursive: true });

if (!fs.existsSync(path.join(root, 'client/dist/index.html'))) {
  console.error('client/dist is missing — run "npm run build" first.');
  process.exit(1);
}

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const results = [];
const check = (name, cond, extra = '') => { results.push({ name, ok: Boolean(cond), extra }); console.log(`${cond ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); if (!cond) throw new Error(`Check failed: ${name}`); };

const fx = await startFixtures();
const port = await freePort();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stackreel-e2e-'));
// Same shape as the real default (server/.data) — a dot-folder once broke all media serving.
const dataDir = path.join(tmpRoot, 'server', '.data');
const host = 'fixture-shop.test';
const server = spawn(process.execPath, [path.join(root, 'server/src/index.js')], {
  env: {
    ...process.env, NODE_ENV: 'test', PORT: String(port), SERVE_CLIENT: 'true', LOG_LEVEL: 'warn', DATA_DIR: dataDir,
    TEST_ALLOWED_TARGETS: `${host}:${fx.sitePort},127.0.0.1:${fx.thirdPartyPort}`,
    TEST_HOST_MAP: `${host}=127.0.0.1`,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const base = `http://127.0.0.1:${port}`;
let browser;
try {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  browser = await chromium.launch({ headless: !process.env.E2E_HEADFUL, executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(base);
  await page.getByTestId('backend-status').getByText('API online').waitFor({ timeout: 30000 });
  check('dashboard loads and reports API online', true);
  check('no fabricated stats on an empty install', (await page.getByTestId('stats').count()) === 0);
  await page.screenshot({ path: path.join(out, '01-dashboard-dark.png') });

  // Validation
  await page.getByTestId('url-input').fill('localhost:3000');
  await page.getByTestId('analyze-button').click();
  check('client rejects local addresses', await page.getByTestId('url-error').isVisible());

  // Analysis
  await page.getByTestId('duration-select').selectOption('90');
  await page.getByTestId('url-input').fill(`http://${host}:${fx.sitePort}/`);
  await page.getByTestId('analyze-button').click();
  await page.getByTestId('job-analysis').waitFor({ timeout: 10000 });
  await page.screenshot({ path: path.join(out, '02-analysis-running.png') });
  await page.waitForURL(/#\/explorer\/prj_/, { timeout: 90000 });
  await page.getByTestId('flow-canvas').waitFor();
  await page.waitForTimeout(900);
  check('navigates to the explorer after analysis', true);
  check('graph shows Next.js node from evidence', await page.getByTestId('node-fe-nextjs').isVisible());
  check('internal service was never contacted', fx.hits.internal === 0, `internal hits: ${fx.hits.internal}`);
  await page.screenshot({ path: path.join(out, '03-explorer-dark.png') });

  // Wide screens: the map must be fitted/centred, not pushed to one side.
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.waitForTimeout(900);
  const fit = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="flow-canvas"]').getBoundingClientRect();
    const ns = [...document.querySelectorAll('.react-flow__node-arch')].map(n => n.getBoundingClientRect());
    const left = Math.min(...ns.map(r => r.left)) - c.left, right = c.right - Math.max(...ns.map(r => r.right));
    return { left: Math.round(left), right: Math.round(right) };
  });
  check('graph is centred and fully visible on a wide screen', fit.left >= 0 && fit.right >= 0 && Math.abs(fit.left - fit.right) < 120, JSON.stringify(fit));
  await page.screenshot({ path: path.join(out, '03b-explorer-wide.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(600);

  await page.getByTestId('node-be-express').click();
  await page.getByTestId('node-panel').waitFor();
  const evidenceText = await page.getByTestId('node-evidence').innerText();
  check('node panel shows evidence for Express', /x-powered-by/i.test(evidenceText), evidenceText.split('\n').slice(0, 3).join(' | '));
  await page.screenshot({ path: path.join(out, '04-explorer-node-panel.png') });

  await page.getByTestId('graph-search').fill('nginx');
  await page.waitForTimeout(300);
  await page.getByTestId('graph-search').fill('');

  await page.getByTestId('nav-security').click();
  await page.getByTestId('finding').first().waitFor();
  check('security view lists passive findings', (await page.getByTestId('finding').count()) >= 3);
  await page.screenshot({ path: path.join(out, '05-security-dark.png'), fullPage: true });

  await page.getByTestId('nav-evidence').click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, '06-evidence-dark.png') });

  // Studio + auto render (started automatically by the analysis)
  await page.getByTestId('nav-studio').click();
  await page.getByTestId('render-panel').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, '07-studio-preview-dark.png') });
  const renderJob = page.getByTestId('render-panel').getByTestId('job-render');
  await renderJob.waitFor({ timeout: 20000 });
  console.log('  waiting for the render to finish…');
  await page.getByTestId('video-player').waitFor({ timeout: 15 * 60_000 });
  await page.waitForFunction(() => { const v = document.querySelector('[data-testid="video-player"]'); return v && v.readyState >= 1 && v.duration > 10; }, null, { timeout: 30000 });
  const dur = await page.evaluate(() => document.querySelector('[data-testid="video-player"]').duration);
  check('studio plays the rendered MP4', dur > 30, `duration ${dur.toFixed(1)}s`);
  // Every thumbnail and poster must really load (not a broken-image icon).
  await page.waitForTimeout(1500);
  const imgs = await page.evaluate(() => [...document.querySelectorAll('[data-testid="timeline"] img, [data-testid="render-list"] img')].map(i => ({ ok: i.complete && i.naturalWidth > 0, src: i.getAttribute('src') })));
  check('scene thumbnails and poster load', imgs.length >= 7 && imgs.every(i => i.ok), `${imgs.filter(i => i.ok).length}/${imgs.length} loaded`);
  check('no "Video unavailable" error for a valid render', (await page.getByText('Video unavailable').count()) === 0);

  const sample = () => page.evaluate(() => { const v = document.querySelector('[data-testid="video-player"]'); return { t: v.currentTime, muted: v.muted, volume: v.volume, audioBytes: v.webkitAudioDecodedByteCount ?? -1 }; });
  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(3000);
  const intro = await sample(); // title sequence: no narration yet
  check('playback advances', intro.t > 0.5, `currentTime ${intro.t.toFixed(2)}s`);
  await page.getByTestId('play-toggle').click();
  // Jump into scene 1's narration and play 3 s of speech.
  const speechStart = await page.evaluate(async () => (await (await fetch(document.querySelector('[data-testid="video-player"]').src.replace(/\/files\/video\.mp4.*$/, ''))).json()).data.timeline.scenes[0].speechStart);
  await page.evaluate((t) => { document.querySelector('[data-testid="video-player"]').currentTime = t + 0.5; }, speechStart);
  await page.waitForTimeout(500);
  const before = await sample();
  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(3000);
  const after = await sample();
  await page.getByTestId('play-toggle').click();
  const speechBytes = after.audioBytes - before.audioBytes;
  check('narration audio is decoded during speech (unmuted, volume up)', !after.muted && after.volume > 0 && speechBytes > 5 * Math.max(200, intro.audioBytes / 3), `speech: ${speechBytes} bytes in 3 s vs intro ${intro.audioBytes} bytes in 3 s`);
  // Seek and resume
  await page.evaluate(() => { document.querySelector('[data-testid="video-player"]').currentTime = 40; });
  await page.waitForTimeout(600);
  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(1200);
  const afterSeek = await page.evaluate(() => document.querySelector('[data-testid="video-player"]').currentTime);
  check('seek and resume work', afterSeek > 40.3 && afterSeek < 44, `currentTime ${afterSeek.toFixed(2)}s`);
  await page.getByTestId('play-toggle').click();
  const audioCheck = await page.getByTestId('audio-check').innerText();
  check('studio shows audio measured from the MP4', /speech in \d+% of the video/.test(audioCheck), audioCheck.replace(/\n/g, ' '));
  await page.getByTestId('timeline').click({ position: { x: 400, y: 30 } });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, '08-studio-video-dark.png') });

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-mp4').click()]);
  const file = path.join(out, 'downloaded.mp4');
  await download.saveAs(file);
  const head = fs.readFileSync(file).subarray(4, 8).toString('ascii');
  check('downloaded file is an MP4', head === 'ftyp' && fs.statSync(file).size > 100_000, `${(fs.statSync(file).size / 1048576).toFixed(1)} MB, suggested name ${download.suggestedFilename()}`);

  for (const f of ['captions.srt', 'captions.vtt']) {
    const href = await page.locator(`[data-testid="render-list"] a[href*="${f}"]`).first().getAttribute('href');
    const res = await fetch(new URL(href, base));
    const text = await res.text();
    check(`${f} downloads with real captions`, res.ok && /-->/.test(text) && text.length > 200, `${text.length} bytes`);
  }

  // Theme switching + persistence
  await page.getByTestId('theme-toggle').click();
  await page.waitForTimeout(500);
  check('theme toggles to light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await page.reload();
  await page.getByTestId('render-panel').waitFor();
  check('theme persists across reload', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, '09-studio-light.png') });
  await page.getByTestId('nav-explorer').click();
  await page.getByTestId('flow-canvas').waitFor();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, '10-explorer-light.png') });
  await page.getByTestId('nav-security').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, '11-security-light.png') });
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId('recent-projects').waitFor();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, '12-dashboard-light.png'), fullPage: true });
  check('dashboard shows real stats after work exists', await page.getByTestId('stats').isVisible());
  check('video gallery lists the render', await page.getByTestId('video-gallery').isVisible());

  // Mobile layout
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal overflow on mobile', overflow <= 1, `overflow ${overflow}px`);
  await page.screenshot({ path: path.join(out, '13-dashboard-mobile-light.png'), fullPage: true });

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  console.log(`\nE2E passed: ${results.length} checks. Screenshots in ${path.relative(process.cwd(), out)}/`);
} catch (err) {
  console.error(`\nE2E FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
  await fx.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
