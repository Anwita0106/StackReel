import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesize, ttsStatus } from '../src/tts/index.js';
import { resolveMediaTools, toPcmWav, readWavPcm, audioLevels, assertAudible, normalizePeak } from '../src/render/media.js';

const cfg = { provider: 'auto', openaiKey: '', elevenlabsKey: '', elevenlabsVoice: '21m00Tcm4TlvDq8ikWAM', timeoutMs: 30000 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sr-tts-'));

test('offline meSpeak produces real, audible English speech without any API key', async () => {
  const dir = tmp();
  const out = await synthesize('StackReel loaded the homepage in a sandboxed browser and found Next.js.', { provider: 'mespeak' }, cfg, path.join(dir, 's'));
  assert.equal(out.provider, 'mespeak');
  assert.ok(fs.statSync(out.file).size > 20_000);
  const wav = path.join(dir, 'n.wav');
  await toPcmWav(resolveMediaTools({}), out.file, wav);
  const pcm = readWavPcm(fs.readFileSync(wav));
  assert.equal(pcm.sampleRate, 48000);
  assert.equal(pcm.channels, 1);
  const levels = audioLevels(pcm.samples, 48000);
  assert.ok(levels.seconds > 2, `${levels.seconds}s of speech`);
  assert.ok(levels.peak > 0.05 && levels.voicedRatio > 0.3, JSON.stringify(levels));
  assert.doesNotThrow(() => assertAudible(levels, 'clip'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every meSpeak voice listed in the UI really speaks', async () => {
  const status = await ttsStatus(cfg);
  const voices = status.providers.find(p => p.id === 'mespeak').voices;
  const dir = tmp();
  for (const v of voices) {
    const out = await synthesize('Testing this voice.', { provider: 'mespeak', voice: v.id }, cfg, path.join(dir, v.id));
    const wav = path.join(dir, `${v.id}.norm.wav`);
    await toPcmWav(resolveMediaTools({}), out.file, wav);
    assert.doesNotThrow(() => assertAudible(audioLevels(readWavPcm(fs.readFileSync(wav)).samples, 48000), v.id));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('silence and near-silence are rejected as narration', () => {
  const silent = new Int16Array(48000 * 2);
  assert.throws(() => assertAudible(audioLevels(silent, 48000), 'scene'), (e) => e.code === 'TTS_SILENT');
  const hiss = new Int16Array(48000 * 2).map(() => Math.round((Math.random() - 0.5) * 60));
  assert.throws(() => assertAudible(audioLevels(hiss, 48000), 'scene'), (e) => e.code === 'TTS_SILENT');
});

test('quiet speech is normalized to a clear level without clipping', () => {
  const quiet = new Int16Array(48000).map((_, i) => Math.round(Math.sin(i / 8) * 4000));
  const out = normalizePeak(quiet);
  const peak = Math.max(...out.map(Math.abs));
  assert.ok(peak > 28000 && peak <= 32767, `peak ${peak}`);
  const loud = new Int16Array(100).fill(32767);
  assert.ok(Math.max(...normalizePeak(loud)) <= 32767);
});

test('unavailable or unknown providers fail with clear errors', async () => {
  await assert.rejects(synthesize('hi there', { provider: 'openai' }, cfg, path.join(os.tmpdir(), 'x')), (e) => e.code === 'TTS_UNAVAILABLE' && /OPENAI_API_KEY/.test(e.message));
  await assert.rejects(synthesize('hi there', { provider: 'elevenlabs' }, cfg, path.join(os.tmpdir(), 'x')), (e) => e.code === 'TTS_UNAVAILABLE' && /ELEVENLABS_API_KEY/.test(e.message));
  await assert.rejects(synthesize('hi', { provider: 'nope' }, cfg, path.join(os.tmpdir(), 'x')), (e) => e.code === 'TTS_CONFIG');
  await assert.rejects(synthesize('   ', { provider: 'mespeak' }, cfg, path.join(os.tmpdir(), 'x')), (e) => e.code === 'TTS_EMPTY');
});
