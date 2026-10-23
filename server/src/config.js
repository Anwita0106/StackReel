// Centralized configuration. Every tunable value comes from environment
// variables (loaded from the repository-root .env file when present).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// Root .env first, then server/.env (server-specific overrides). Real env vars always win.
for (const file of [path.join(REPO_ROOT, '.env'), path.join(SERVER_ROOT, '.env')]) {
  if (fs.existsSync(file)) dotenv.config({ path: file, quiet: true });
}

const env = process.env;

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid value for ${name}: "${raw}" (expected an integer between ${min} and ${max}).`);
  }
  return n;
}
function bool(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}
function list(name, fallback = []) {
  const raw = env[name];
  if (!raw) return fallback;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadConfig(overrides = {}) {
  const nodeEnv = env.NODE_ENV || 'development';
  const clientPort = int('CLIENT_PORT', 5173, { min: 1, max: 65535 });
  const isTest = nodeEnv === 'test';

  const cfg = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isTest,
    host: env.HOST || '127.0.0.1',
    port: int('PORT', 5001, { min: 0, max: 65535 }),
    clientPort,
    // Origins allowed to call the API from a browser. Dev defaults cover the Vite dev server.
    corsOrigins: [
      ...(nodeEnv === 'production' ? [] : [`http://localhost:${clientPort}`, `http://127.0.0.1:${clientPort}`]),
      ...list('CORS_ORIGINS'),
    ],
    logLevel: env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
    dataDir: path.resolve(REPO_ROOT, env.DATA_DIR || 'server/.data'),
    serveClient: bool('SERVE_CLIENT', nodeEnv === 'production'),
    clientDist: path.join(REPO_ROOT, 'client', 'dist'),
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 30_000, { min: 1000 }),
    maxProjects: int('MAX_PROJECTS', 50, { min: 1 }),

    analysis: {
      allowedPorts: list('ALLOWED_TARGET_PORTS', ['80', '443', '8080', '8443']).map(Number),
      maxRedirects: int('MAX_REDIRECTS', 5, { min: 0, max: 10 }),
      httpTimeoutMs: int('HTTP_TIMEOUT_MS', 12_000, { min: 1000 }),
      maxHtmlBytes: int('MAX_HTML_BYTES', 2_000_000, { min: 10_000 }),
      browserEnabled: bool('BROWSER_ANALYSIS', true),
      browserExecutablePath: env.BROWSER_EXECUTABLE_PATH || '',
      browserTimeoutMs: int('BROWSER_TIMEOUT_MS', 25_000, { min: 3000 }),
      browserSettleMs: int('BROWSER_SETTLE_MS', 2500, { min: 0 }),
      maxBrowserRequests: int('MAX_BROWSER_REQUESTS', 300, { min: 10 }),
      maxConcurrent: int('MAX_CONCURRENT_ANALYSES', 2, { min: 1 }),
      // Test-only escape hatch so automated tests can scan a local fixture server.
      // Exact "host:port" pairs; ignored unless NODE_ENV=test.
      testAllowedTargets: isTest ? list('TEST_ALLOWED_TARGETS') : [],
      // Test-only static DNS ("fixture-shop.test=127.0.0.1"); ignored unless NODE_ENV=test.
      testHostMap: isTest ? Object.fromEntries(list('TEST_HOST_MAP').map(p => p.split('=').map(s => s.trim()))) : {},
      userAgent: env.SCANNER_USER_AGENT ||
        'Mozilla/5.0 (compatible; StackReelInspector/2.0; passive architecture analysis)',
    },

    llm: {
      provider: (env.LLM_PROVIDER || 'none').toLowerCase(), // none | anthropic | openai
      anthropicKey: env.ANTHROPIC_API_KEY || '',
      anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      openaiKey: env.OPENAI_API_KEY || '',
      openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
      timeoutMs: int('LLM_TIMEOUT_MS', 45_000, { min: 1000 }),
    },

    tts: {
      provider: (env.TTS_PROVIDER || 'auto').toLowerCase(), // auto | openai | elevenlabs | system | mespeak
      openaiKey: env.OPENAI_API_KEY || '',
      openaiModel: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      openaiVoice: env.OPENAI_TTS_VOICE || 'alloy',
      elevenlabsKey: env.ELEVENLABS_API_KEY || '',
      elevenlabsVoice: env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
      elevenlabsModel: env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
      timeoutMs: int('TTS_TIMEOUT_MS', 60_000, { min: 1000 }),
      // Test-only: make the 'auto' provider fail so the offline fallback can be exercised.
      testFailAuto: isTest && bool('TEST_TTS_FAIL_AUTO', false),
    },

    render: {
      maxConcurrent: int('MAX_CONCURRENT_RENDERS', 1, { min: 1 }),
      maxDurationSec: int('MAX_VIDEO_SECONDS', 420, { min: 10 }),
      timeoutMs: int('RENDER_TIMEOUT_MS', 20 * 60_000, { min: 10_000 }),
      ffmpegPath: env.FFMPEG_PATH || '',
      ffprobePath: env.FFPROBE_PATH || '',
    },

    rateLimit: {
      windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000, { min: 1000 }),
      maxAnalyses: int('RATE_LIMIT_ANALYSES', 10, { min: 1 }),
      maxRenders: int('RATE_LIMIT_RENDERS', 6, { min: 1 }),
    },
  };

  return deepMerge(cfg, overrides);
}

function deepMerge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      base[k] = deepMerge({ ...base[k] }, v);
    } else {
      base[k] = v;
    }
  }
  return base;
}
