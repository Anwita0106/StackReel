// Render worker — runs in a child process so CPU-heavy rendering never blocks
// the API server. Receives one job over IPC, reports progress, exits.
//
//   1. narration → speech audio per scene (TTS provider)
//   2. timeline from the REAL audio durations; captions; final audio track
//   3. frames drawn with the shared renderer → FFmpeg (H.264 + AAC MP4)
//   4. thumbnails, captions (VTT/SRT), waveform, ffprobe verification
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { synthesize } from '../tts/index.js';
import { resolveMediaTools, toPcmWav, readWavPcm, writeWavPcm, computePeaks, spawnEncoder, probeMedia, verifyProbe, audioLevels, assertAudible, normalizePeak, measureMediaAudio } from './media.js';
import { buildTimeline, toVtt, toSrt } from '../../../shared/scene/timeline.js';
import { createVideoModel, drawFrame } from '../../../shared/scene/renderer.js';

const require = createRequire(import.meta.url);
let cancelled = false;
let encoder = null;

const send = (msg) => { if (process.send) process.send(msg); };
const progress = (stage, value, log) => send({ type: 'progress', stage, progress: Math.round(value * 10) / 10, log });

function registerFonts() {
  const fams = [
    ['Space Grotesk', '@fontsource/space-grotesk', 'space-grotesk', [500, 600, 700]],
    ['Plus Jakarta Sans', '@fontsource/plus-jakarta-sans', 'plus-jakarta-sans', [400, 500, 600, 700]],
    ['JetBrains Mono', '@fontsource/jetbrains-mono', 'jetbrains-mono', [400, 500, 600]],
  ];
  let ok = 0;
  for (const [family, pkg, slug, weights] of fams) {
    for (const w of weights) {
      try {
        const file = require.resolve(`${pkg}/files/${slug}-latin-${w}-normal.woff2`);
        if (GlobalFonts.registerFromPath(file, family)) ok += 1;
      } catch { /* fall back to system fonts */ }
    }
  }
  return ok;
}

async function renderJob({ project, options, outDir, ttsConfig, mediaConfig }) {
  const tools = resolveMediaTools(mediaConfig);
  const work = path.join(outDir, 'work');
  await fs.mkdir(work, { recursive: true });
  const { width, height, fps } = options;
  const scenes = project.script.scenes;

  // 1 ─ narration audio (with automatic offline fallback when the provider is "auto")
  async function synthesizeAll(provider, voice) {
    const speech = [];
    const speechLevels = [];
    let ttsInfo = null;
    for (let i = 0; i < scenes.length; i += 1) {
      if (cancelled) throw new Error('cancelled');
      progress('Synthesizing narration', 3 + (i / scenes.length) * 30, `Scene ${i + 1}/6: synthesizing ${scenes[i].narration.split(/\s+/).length} words`);
      const base = path.join(work, `scene-${i + 1}`);
      const res = await synthesize(scenes[i].narration, { provider, voice, rate: options.rate }, ttsConfig, base);
      ttsInfo = { provider: res.provider, voice: res.voice };
      const wav = `${base}.norm.wav`;
      await toPcmWav(tools, res.file, wav);
      const pcm = readWavPcm(await fs.readFile(wav));
      if (pcm.sampleRate !== 48000 || pcm.channels !== 1) throw new Error('Audio normalization produced an unexpected format');
      const seconds = pcm.samples.length / 48000;
      if (seconds < 0.3) throw Object.assign(new Error(`The voice engine produced almost no audio for scene ${i + 1} (${seconds.toFixed(2)} s).`), { code: 'TTS_SILENT' });
      // Real speech check — a file that merely exists or has a header is not narration.
      const levels = audioLevels(pcm.samples, 48000);
      assertAudible(levels, `Scene ${i + 1}`);
      const samples = normalizePeak(pcm.samples);
      speechLevels.push({ scene: i + 1, seconds: Math.round(seconds * 100) / 100, peakDb: levels.peakDb, rmsDb: levels.rmsDb, voiced: Math.round(levels.voicedRatio * 100) / 100 });
      progress('Synthesizing narration', 3 + ((i + 1) / scenes.length) * 30, `Scene ${i + 1}/6: ${seconds.toFixed(1)} s of speech via ${res.provider} (${res.voice}), peak ${levels.peakDb} dB`);
      speech.push({ samples, seconds });
    }
    return { speech, speechLevels, ttsInfo };
  }
  let narration;
  try {
    narration = await synthesizeAll(options.ttsProvider, options.voice);
  } catch (err) {
    if (cancelled || options.ttsProvider !== 'auto' || !/TTS|voice|speech|audio/i.test(`${err.code} ${err.message}`)) throw err;
    progress('Synthesizing narration', 3, `Default voice failed (${err.message.slice(0, 160)}) — retrying all scenes with the built-in offline voice`);
    narration = await synthesizeAll('mespeak', undefined);
    narration.ttsInfo = { ...narration.ttsInfo, fallbackFrom: err.message.slice(0, 200) };
  }
  const { speech, speechLevels, ttsInfo } = narration;

  // 2 ─ timeline, captions, audio track
  progress('Building timeline', 34, 'Aligning scenes and captions to measured narration durations');
  const timeline = buildTimeline(scenes, speech.map(s => s.seconds));
  if (timeline.duration > options.maxDurationSec) throw new Error(`Video would be ${Math.round(timeline.duration)}s, above the ${options.maxDurationSec}s limit`);
  const total = new Int16Array(Math.ceil(timeline.duration * 48000));
  timeline.scenes.forEach((s, i) => total.set(speech[i].samples.subarray(0, Math.max(0, total.length - Math.floor(s.speechStart * 48000))), Math.floor(s.speechStart * 48000)));
  const audioFile = path.join(outDir, 'narration.wav');
  await fs.writeFile(audioFile, writeWavPcm(total));
  const waveform = computePeaks(total, 900);
  await fs.writeFile(path.join(outDir, 'captions.vtt'), toVtt(timeline.captions));
  await fs.writeFile(path.join(outDir, 'captions.srt'), toSrt(timeline.captions));

  // 3 ─ frames → encoder
  const fontsLoaded = registerFonts();
  let screenshot = null;
  if (project.screenshotPath) screenshot = await loadImage(await fs.readFile(project.screenshotPath)).catch(() => null);
  if (screenshot) {
    // Downscale once instead of resampling a full-size screenshot on every frame.
    const w = Math.min(screenshot.width, Math.round(620 * (width / 1280)));
    const h = Math.round((screenshot.height * w) / screenshot.width);
    const small = createCanvas(w, h);
    small.getContext('2d').drawImage(screenshot, 0, 0, w, h);
    screenshot = small;
  }
  const model = createVideoModel({ project, script: project.script, timeline, width, height, assets: { screenshot } });
  model.burnCaptions = options.burnCaptions;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const output = path.join(outDir, 'video.mp4');
  encoder = spawnEncoder(tools, { fps, width, height, audioFile, output });
  let stderr = '';
  encoder.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
  const exited = new Promise((resolve) => encoder.on('close', (code, sig) => resolve({ code, sig })));
  encoder.stdin.on('error', () => {});
  const frames = Math.round(timeline.duration * fps);
  const t0 = Date.now();
  progress('Rendering frames', 36, `Rendering ${frames} frames at ${width}x${height}, ${fps} fps (${fontsLoaded} font faces loaded)`);
  let drawMs = 0;
  let waitMs = 0;
  for (let f = 0; f < frames; f += 1) {
    if (cancelled) { encoder.kill('SIGKILL'); throw new Error('cancelled'); }
    const d0 = performance.now();
    drawFrame(ctx, model, f / fps);
    // Copy: the canvas reuses its pixel memory for the next frame.
    const pixels = Buffer.from(canvas.data());
    const d1 = performance.now();
    drawMs += d1 - d0;
    if (!encoder.stdin.write(pixels)) await new Promise((r) => encoder.stdin.once('drain', r));
    waitMs += performance.now() - d1;
    if (f % Math.max(1, Math.round(fps * 4)) === 0) {
      const done = f / frames;
      const eta = done > 0.02 ? Math.round(((Date.now() - t0) / done) * (1 - done) / 1000) : null;
      const rate = f ? (f / ((Date.now() - t0) / 1000)).toFixed(1) : '…';
      progress('Rendering frames', 36 + done * 56, eta != null ? `Frame ${f}/${frames} · ${rate} fps · ~${eta}s left (draw ${(drawMs / (f + 1)).toFixed(1)} ms, encoder ${(waitMs / (f + 1)).toFixed(1)} ms per frame)` : undefined);
    }
  }
  encoder.stdin.end();
  const { code } = await exited;
  if (code !== 0) throw new Error(`FFmpeg encoder exited with code ${code}: ${stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}`);

  // 4 ─ thumbnails & verification
  progress('Verifying output', 94, 'Generating thumbnails and verifying the MP4 with ffprobe');
  const thumbs = [];
  const thumbCanvas = createCanvas(480, 270);
  const tctx = thumbCanvas.getContext('2d');
  const thumbModel = createVideoModel({ project, script: project.script, timeline, width: 480, height: 270, assets: { screenshot } });
  thumbModel.burnCaptions = false;
  for (const s of timeline.scenes) {
    drawFrame(tctx, thumbModel, Math.min(s.end - 0.2, s.start + 3.2));
    const name = `thumb-${s.index + 1}.jpg`;
    await fs.writeFile(path.join(outDir, name), await thumbCanvas.encode('jpeg', 82));
    thumbs.push(name);
  }
  drawFrame(tctx, thumbModel, 3.6);
  await fs.writeFile(path.join(outDir, 'poster.jpg'), await thumbCanvas.encode('jpeg', 85));
  const probe = await probeMedia(tools, output);
  const problems = verifyProbe(probe, { expectedDurationSec: timeline.duration, width, height });
  if (problems.length) throw new Error(`Output verification failed: ${problems.join('; ')}`);
  // Decode the AAC track back out of the MP4 and confirm it carries speech, not silence.
  const finalAudio = await measureMediaAudio(tools, output);
  const expectedVoiced = speech.reduce((a, s) => a + s.seconds, 0) / timeline.duration;
  if (finalAudio.peak < 0.05 || finalAudio.voicedRatio < Math.min(0.25, expectedVoiced * 0.5)) {
    throw Object.assign(new Error(`The finished MP4's audio track is silent or nearly silent (peak ${finalAudio.peakDb} dB, speech in ${Math.round(finalAudio.voicedRatio * 100)}% of the video).`), { code: 'AUDIO_SILENT' });
  }
  await fs.rm(work, { recursive: true, force: true });

  return {
    durationSec: Math.round(probe.durationSec * 100) / 100,
    width, height, fps,
    sizeBytes: probe.sizeBytes,
    probe,
    tts: ttsInfo,
    audio: { speech: speechLevels, final: { peakDb: finalAudio.peakDb, rmsDb: finalAudio.rmsDb, speechCoverage: Math.round(finalAudio.voicedRatio * 100) / 100 } },
    burnCaptions: options.burnCaptions,
    renderSeconds: Math.round((Date.now() - t0) / 100) / 10,
    timeline: { ...timeline, scenes: timeline.scenes.map((s, i) => ({ ...s, thumbnail: thumbs[i] })) },
    waveform,
    files: { video: 'video.mp4', poster: 'poster.jpg', vtt: 'captions.vtt', srt: 'captions.srt', audio: 'narration.wav' },
  };
}

process.on('message', async (msg) => {
  if (msg?.type === 'cancel') {
    cancelled = true;
    encoder?.kill('SIGKILL');
    return;
  }
  if (msg?.type !== 'start') return;
  try {
    const result = await renderJob(msg.job);
    send({ type: 'done', result });
  } catch (err) {
    send({ type: 'error', message: cancelled ? 'Render cancelled' : err.message, code: cancelled ? 'CANCELLED' : (err.code || 'RENDER_FAILED'), transient: Boolean(err.transient) });
  } finally {
    setTimeout(() => process.exit(0), 50);
  }
});
process.on('SIGTERM', () => { cancelled = true; encoder?.kill('SIGKILL'); setTimeout(() => process.exit(1), 200); });
send({ type: 'ready' });
