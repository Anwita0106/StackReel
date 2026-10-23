// Text-to-speech behind one interface.
//   system     — the OS voice: Windows SAPI (PowerShell), macOS `say`, Linux espeak-ng
//   mespeak    — pure-JavaScript eSpeak port; works offline everywhere (robotic but real)
//   openai     — OpenAI /v1/audio/speech (needs OPENAI_API_KEY)
//   elevenlabs — ElevenLabs TTS (needs ELEVENLABS_API_KEY)
//   auto       — system if available, otherwise mespeak. Cloud providers are never
//                chosen automatically so nobody is billed by surprise.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export class TtsError extends Error {
  constructor(message, { transient = false, code = 'TTS_FAILED' } = {}) {
    super(message);
    this.code = code;
    this.transient = transient;
  }
}

// ── System voice detection ───────────────────────────────────────────────
let systemCache = null;
async function which(cmd) {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeout: 4000 });
    return true;
  } catch { return false; }
}

const SAPI_LIST = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }';
const SAPI_SPEAK = `param([string]$TextFile, [string]$OutFile, [string]$Voice = '', [int]$Rate = 0)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice -ne '') { $s.SelectVoice($Voice) }
$s.Rate = $Rate
$s.SetOutputToWaveFile($OutFile)
$s.Speak([System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8))
$s.Dispose()`;

export async function detectSystemVoice() {
  if (systemCache) return systemCache;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SAPI_LIST], { timeout: 15000, windowsHide: true });
      const voices = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      systemCache = voices.length ? { available: true, engine: 'Windows SAPI', voices } : { available: false, reason: 'No Windows SAPI voices are installed.' };
    } else if (process.platform === 'darwin') {
      if (!(await which('say'))) systemCache = { available: false, reason: 'macOS `say` not found.' };
      else {
        const { stdout } = await run('say', ['-v', '?'], { timeout: 8000 });
        const voices = stdout.split('\n').filter(l => /\ben[_-][A-Z]{2}\b/.test(l)).map(l => l.split(/\s{2,}/)[0].trim()).filter(Boolean).slice(0, 30);
        systemCache = { available: true, engine: 'macOS say', voices };
      }
    } else {
      const bin = (await which('espeak-ng')) ? 'espeak-ng' : (await which('espeak')) ? 'espeak' : null;
      systemCache = bin ? { available: true, engine: bin, bin, voices: ['en-us', 'en', 'en-gb-scotland', 'en-gb-x-rp'] } : { available: false, reason: 'espeak-ng is not installed (sudo apt install espeak-ng).' };
    }
  } catch (err) {
    systemCache = { available: false, reason: `System voice unavailable: ${err.message.split('\n')[0]}` };
  }
  return systemCache;
}

const MESPEAK_VOICES = [
  { id: 'en-us', label: 'US English (male)', voice: 'en/en-us', variant: '' },
  { id: 'en-us-f', label: 'US English (female)', voice: 'en/en-us', variant: 'f2' },
  { id: 'en-rp', label: 'British English (RP)', voice: 'en/en-rp', variant: '' },
  { id: 'en-sc', label: 'Scottish English', voice: 'en/en-sc', variant: '' },
];

export async function ttsStatus(cfg) {
  const system = await detectSystemVoice();
  const providers = [
    { id: 'system', label: system.engine ? `System voice (${system.engine})` : 'System voice', available: system.available, reason: system.reason, voices: (system.voices || []).map(v => ({ id: v, label: v })), cost: 'free, offline' },
    { id: 'mespeak', label: 'meSpeak (built-in, offline)', available: true, voices: MESPEAK_VOICES.map(({ id, label }) => ({ id, label })), cost: 'free, offline' },
    { id: 'openai', label: 'OpenAI TTS', available: Boolean(cfg.openaiKey), reason: cfg.openaiKey ? undefined : 'Set OPENAI_API_KEY', voices: ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map(v => ({ id: v, label: v })), cost: 'paid API' },
    { id: 'elevenlabs', label: 'ElevenLabs', available: Boolean(cfg.elevenlabsKey), reason: cfg.elevenlabsKey ? undefined : 'Set ELEVENLABS_API_KEY', voices: [{ id: cfg.elevenlabsVoice, label: `Voice ${cfg.elevenlabsVoice.slice(0, 8)}…` }], cost: 'paid API' },
  ];
  const resolved = resolveProvider(cfg.provider, providers);
  return { configured: cfg.provider, default: resolved, providers };
}

function resolveProvider(requested, providers) {
  const avail = (id) => providers.find(p => p.id === id)?.available;
  if (requested && requested !== 'auto') return avail(requested) ? requested : null;
  return avail('system') ? 'system' : 'mespeak';
}

async function withRetries(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (!err.transient || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 800 * 2 ** i));
    }
  }
  throw lastErr;
}

async function cloudFetch(url, init, label) {
  let res;
  try { res = await fetch(url, init); } catch (err) {
    throw new TtsError(`${label} request failed: ${err.cause?.code || err.message}`, { transient: true, code: 'TTS_NETWORK' });
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new TtsError(`${label} returned HTTP ${res.status}: ${text}`, { transient: res.status === 429 || res.status >= 500, code: res.status === 401 ? 'TTS_AUTH' : 'TTS_PROVIDER_ERROR' });
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Synthesizes `text` and writes an audio file. Returns { file, provider, voice }.
 * The caller normalizes the file to WAV with FFmpeg.
 */
export async function synthesize(text, { provider, voice, rate = 0 }, cfg, outBase) {
  if (cfg.testFailAuto && (!provider || provider === 'auto')) throw new TtsError('Simulated voice failure (TEST_TTS_FAIL_AUTO).', { code: 'TTS_FAILED' });
  const status = await ttsStatus(cfg);
  const chosen = provider && provider !== 'auto' ? provider : status.default;
  const p = status.providers.find(x => x.id === chosen);
  if (!p) throw new TtsError(`Unknown TTS provider "${provider}".`, { code: 'TTS_CONFIG' });
  if (!p.available) throw new TtsError(`TTS provider "${chosen}" is not available: ${p.reason}.`, { code: 'TTS_UNAVAILABLE' });
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new TtsError('Nothing to synthesize.', { code: 'TTS_EMPTY' });

  if (chosen === 'mespeak') {
    const meSpeak = require('mespeak');
    if (!meSpeak.isConfigLoaded()) meSpeak.loadConfig(require('mespeak/src/mespeak_config.json'));
    const v = MESPEAK_VOICES.find(x => x.id === voice) || MESPEAK_VOICES[0];
    if (!meSpeak.isVoiceLoaded(v.voice)) meSpeak.loadVoice(require(`mespeak/voices/${v.voice}.json`));
    const raw = meSpeak.speak(clean, { rawdata: 'buffer', voice: v.voice, variant: v.variant || undefined, speed: 150 + rate * 10, pitch: 45, wordgap: 1 });
    if (!raw) throw new TtsError('meSpeak produced no audio.');
    const file = `${outBase}.wav`;
    await fs.writeFile(file, Buffer.from(raw));
    return { file, provider: chosen, voice: v.id };
  }

  if (chosen === 'system') {
    const tmpText = `${outBase}.txt`;
    await fs.writeFile(tmpText, clean, 'utf8');
    const sys = await detectSystemVoice();
    const selected = voice && sys.voices?.includes(voice) ? voice : '';
    try {
      if (process.platform === 'win32') {
        const script = path.join(os.tmpdir(), 'stackreel-sapi.ps1');
        if (!fss.existsSync(script) || fss.readFileSync(script, 'utf8') !== SAPI_SPEAK) await fs.writeFile(script, SAPI_SPEAK, 'utf8');
        const file = `${outBase}.wav`;
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-TextFile', tmpText, '-OutFile', file, '-Voice', selected, '-Rate', String(Math.max(-10, Math.min(10, rate)))], { timeout: cfg.timeoutMs, windowsHide: true });
        return { file, provider: chosen, voice: selected || 'default' };
      }
      if (process.platform === 'darwin') {
        const file = `${outBase}.aiff`;
        await run('say', ['-o', file, '-f', tmpText, ...(selected ? ['-v', selected] : []), '-r', String(175 + rate * 10)], { timeout: cfg.timeoutMs });
        return { file, provider: chosen, voice: selected || 'default' };
      }
      const file = `${outBase}.wav`;
      await run(sys.bin, ['-w', file, '-f', tmpText, '-v', selected || 'en-us', '-s', String(160 + rate * 10)], { timeout: cfg.timeoutMs });
      return { file, provider: chosen, voice: selected || 'en-us' };
    } catch (err) {
      throw new TtsError(`System TTS failed: ${err.message.split('\n')[0]}`);
    }
  }

  if (chosen === 'openai') {
    const buf = await withRetries(() => cloudFetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', signal: AbortSignal.timeout(cfg.timeoutMs),
      headers: { authorization: `Bearer ${cfg.openaiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.openaiModel, voice: voice || cfg.openaiVoice, input: clean.slice(0, 4000), response_format: 'wav' }),
    }, 'OpenAI TTS'));
    const file = `${outBase}.wav`;
    await fs.writeFile(file, buf);
    return { file, provider: chosen, voice: voice || cfg.openaiVoice };
  }

  if (chosen === 'elevenlabs') {
    const voiceId = voice || cfg.elevenlabsVoice;
    if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId)) throw new TtsError('Invalid ElevenLabs voice id.', { code: 'TTS_CONFIG' });
    const buf = await withRetries(() => cloudFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST', signal: AbortSignal.timeout(cfg.timeoutMs),
      headers: { 'xi-api-key': cfg.elevenlabsKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: clean, model_id: cfg.elevenlabsModel }),
    }, 'ElevenLabs'));
    const file = `${outBase}.mp3`;
    await fs.writeFile(file, buf);
    return { file, provider: chosen, voice: voiceId };
  }
  throw new TtsError(`Unsupported TTS provider "${chosen}".`, { code: 'TTS_CONFIG' });
}
