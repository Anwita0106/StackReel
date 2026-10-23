// `npm run doctor` — checks everything StackReel needs and explains how to fix what is missing.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, REPO_ROOT } from '../src/config.js';
import { checkMediaTools } from '../src/render/media.js';
import { checkBrowserAvailability, launchBrowser } from '../src/analysis/browserInspector.js';
import { startEgressProxy } from '../src/security/egressProxy.js';
import { ttsStatus } from '../src/tts/index.js';
import { llmStatus } from '../src/narration/llm.js';

const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✖\x1b[0m ${m}`);
let failures = 0;

console.log('\nStackReel doctor\n');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 20 || (major === 20 && minor >= 19)) ok(`Node.js ${process.versions.node}`);
else { bad(`Node.js ${process.versions.node} — install Node 20.19+ or 22 LTS (https://nodejs.org)`); failures += 1; }

for (const dep of ['express', 'zod', 'undici', 'playwright', '@napi-rs/canvas', 'mespeak']) {
  try { await import(dep); ok(`dependency ${dep}`); } catch { bad(`dependency ${dep} missing — run "npm install" in the project root`); failures += 1; }
}

let cfg;
try { cfg = loadConfig(); ok(`.env ${fs.existsSync(path.join(REPO_ROOT, '.env')) ? 'loaded' : 'not found (using defaults — copy .env.example to .env to customize)'}`); } catch (err) { bad(err.message); process.exit(1); }

const media = await checkMediaTools(cfg.render);
if (media.ffmpeg.available) ok(`FFmpeg ${media.ffmpeg.version}${media.ffmpeg.libx264 ? ' (libx264)' : ''}`);
else { bad(`FFmpeg not available (${media.ffmpeg.error}). Re-run "npm install" or set FFMPEG_PATH in .env`); failures += 1; }
if (media.ffprobe.available) ok('ffprobe'); else { bad('ffprobe not available — set FFPROBE_PATH'); failures += 1; }

const browser = await checkBrowserAvailability(cfg.analysis);
if (browser.available) {
  ok(`Browser found: ${browser.candidates.join(', ')}`);
  // Prove it can really start and open a page through StackReel's safety proxy.
  const proxy = await startEgressProxy(cfg.analysis, { maxRequests: 5 });
  try {
    const t0 = Date.now();
    const { browser: b, mode, failures } = await launchBrowser(cfg.analysis, proxy);
    await b.close();
    ok(`Browser test launch succeeded in ${Date.now() - t0} ms (${mode})`);
    for (const f of failures) warn(`  earlier attempt failed: ${f}`);
  } catch (err) {
    warn(`Browser is installed but could not open a page: ${err.message}`);
    warn('  Try: npm run setup:browser   — or set BROWSER_EXECUTABLE_PATH to your Chrome/Edge in .env');
  } finally { await proxy.close(); }
} else warn(`Browser analysis unavailable: ${browser.reason} (analysis still works with HTTP evidence only)`);

const tts = await ttsStatus(cfg.tts);
for (const p of tts.providers) (p.available ? ok : warn)(`TTS ${p.label}: ${p.available ? `available${p.voices.length ? ` (${p.voices.length} voice${p.voices.length === 1 ? '' : 's'})` : ''}` : p.reason}`);
if (tts.default) ok(`Narration will use "${tts.default}" (TTS_PROVIDER=${tts.configured})`); else { bad(`TTS_PROVIDER=${tts.configured} is not available`); failures += 1; }

const llm = llmStatus(cfg.llm);
(llm.ready ? ok : warn)(`LLM narration polish: ${llm.ready ? `${llm.provider} (${llm.model})` : llm.reason}`);

await new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => { bad(`Port ${cfg.port} is in use — stop the other process or set PORT in .env (see README → Troubleshooting)`); failures += 1; resolve(); });
  s.listen(cfg.port, cfg.host, () => { ok(`Port ${cfg.port} is free for the API`); s.close(resolve); });
});
await new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => { warn(`Port ${cfg.clientPort} (frontend) is in use — set CLIENT_PORT in .env`); resolve(); });
  s.listen(cfg.clientPort, '127.0.0.1', () => { ok(`Port ${cfg.clientPort} is free for the frontend`); s.close(resolve); });
});

console.log(failures ? `\n${failures} problem(s) found.\n` : '\nAll required components are ready. Start with: npm run dev\n');
process.exit(failures ? 1 : 0);
