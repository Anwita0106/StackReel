// FFmpeg / FFprobe helpers and minimal WAV (PCM s16le) utilities.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export function resolveMediaTools(cfg = {}) {
  let ffmpeg = cfg.ffmpegPath || '';
  let ffprobe = cfg.ffprobePath || '';
  // Bundled binaries come from platform-specific optional packages (no install
  // scripts or downloads needed). Falls back to an ffmpeg/ffprobe on PATH.
  if (!ffmpeg) { try { ffmpeg = require('@ffmpeg-installer/ffmpeg').path; } catch { ffmpeg = 'ffmpeg'; } }
  if (!ffprobe) { try { ffprobe = require('@ffprobe-installer/ffprobe').path; } catch { ffprobe = 'ffprobe'; } }
  return { ffmpeg, ffprobe };
}

export async function checkMediaTools(cfg) {
  const { ffmpeg, ffprobe } = resolveMediaTools(cfg);
  const out = { ffmpeg: { path: ffmpeg, available: false }, ffprobe: { path: ffprobe, available: false } };
  try {
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-version'], { timeout: 10000, windowsHide: true });
    out.ffmpeg.available = true;
    out.ffmpeg.version = stdout.split('\n')[0].slice(0, 80);
    out.ffmpeg.libx264 = /enable-libx264/.test(stdout);
  } catch (err) { out.ffmpeg.error = err.code || err.message; }
  try {
    await run(ffprobe, ['-version'], { timeout: 10000, windowsHide: true });
    out.ffprobe.available = true;
  } catch (err) { out.ffprobe.error = err.code || err.message; }
  return out;
}

export async function ffmpegRun(tools, args, { timeoutMs = 120000, signal } = {}) {
  try {
    await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: timeoutMs, windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`FFmpeg failed: ${(err.stderr || err.message).toString().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400)}`);
  }
}

/** Converts any audio file to 48 kHz mono PCM WAV. */
export const toPcmWav = (tools, input, output) => ffmpegRun(tools, ['-i', input, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', output]);

export function readWavPcm(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let off = 12;
  let fmt = null;
  while (off + 8 <= buffer.length) {
    const id = buffer.toString('ascii', off, off + 4);
    const size = buffer.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buffer.readUInt16LE(off + 10), sampleRate: buffer.readUInt32LE(off + 12), bits: buffer.readUInt16LE(off + 22) };
    if (id === 'data') {
      const end = Math.min(buffer.length, off + 8 + (size === 0xffffffff || size === 0 ? buffer.length : size));
      if (!fmt || fmt.bits !== 16) throw new Error('Expected 16-bit PCM WAV');
      return { ...fmt, samples: new Int16Array(buffer.buffer.slice(buffer.byteOffset + off + 8, buffer.byteOffset + end - ((end - off - 8) % 2))) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export function writeWavPcm(samples, sampleRate = 48000) {
  const header = Buffer.alloc(44);
  const dataBytes = samples.length * 2;
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, dataBytes)]);
}

export function computePeaks(samples, buckets = 800) {
  const size = Math.max(1, Math.floor(samples.length / buckets));
  const peaks = [];
  for (let b = 0; b < buckets; b += 1) {
    let max = 0;
    const start = b * size;
    for (let i = start; i < Math.min(samples.length, start + size); i += 4) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks.push(Math.round((max / 32768) * 1000) / 1000);
  }
  return peaks;
}

/** Independent verification of the produced MP4 with ffprobe. */
export async function probeMedia(tools, file) {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30000, windowsHide: true });
  const info = JSON.parse(stdout);
  const video = info.streams.find(s => s.codec_type === 'video');
  const audio = info.streams.find(s => s.codec_type === 'audio');
  return {
    durationSec: Number(info.format?.duration || 0),
    sizeBytes: Number(info.format?.size || fss.statSync(file).size),
    formatName: info.format?.format_name,
    video: video ? { codec: video.codec_name, width: video.width, height: video.height, fps: video.avg_frame_rate, pixFmt: video.pix_fmt } : null,
    audio: audio ? { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels } : null,
  };
}

export function verifyProbe(probe, { expectedDurationSec, width, height }) {
  const problems = [];
  if (!probe.video) problems.push('no video stream');
  if (!probe.audio) problems.push('no audio stream');
  if (probe.video && probe.video.codec !== 'h264') problems.push(`unexpected video codec ${probe.video.codec}`);
  if (probe.video && (probe.video.width !== width || probe.video.height !== height)) problems.push(`unexpected size ${probe.video.width}x${probe.video.height}`);
  if (!(probe.sizeBytes > 1000)) problems.push('file is empty');
  if (Math.abs(probe.durationSec - expectedDurationSec) > 1.5) problems.push(`duration ${probe.durationSec.toFixed(2)}s differs from expected ${expectedDurationSec.toFixed(2)}s`);
  return problems;
}

// 'superfast' is ~1.5× faster than 'veryfast' and looks the same on flat motion graphics.
export function spawnEncoder(tools, { fps, width, height, audioFile, output, crf = 24, preset = 'superfast' }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    // Raw RGBA frames straight from the canvas (no per-frame JPEG encode).
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
    '-i', audioFile,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart', output,
  ];
  return spawn(tools.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
}

export async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Peak, RMS (0..1) and share of 50 ms windows that contain sound. */
export function audioLevels(samples, sampleRate) {
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i]) / 32768;
    if (v > peak) peak = v;
    sumSq += v * v;
  }
  const win = Math.max(1, Math.round(sampleRate * 0.05));
  let voiced = 0;
  let windows = 0;
  for (let i = 0; i + win <= samples.length; i += win) {
    let s2 = 0;
    for (let j = i; j < i + win; j += 2) { const v = samples[j] / 32768; s2 += v * v; }
    if (Math.sqrt(s2 / (win / 2)) > 0.02) voiced += 1;
    windows += 1;
  }
  const rms = samples.length ? Math.sqrt(sumSq / samples.length) : 0;
  const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -Infinity);
  return { peak, rms, peakDb: db(peak), rmsDb: db(rms), voicedRatio: windows ? voiced / windows : 0, seconds: samples.length / sampleRate };
}

/** Throws if a speech clip is silent or near-silent. */
export function assertAudible(levels, label) {
  if (levels.peak < 0.02 || levels.rms < 0.003 || levels.voicedRatio < 0.15) {
    const err = new Error(`${label}: the voice engine returned audio with no usable speech (peak ${levels.peakDb} dB, RMS ${levels.rmsDb} dB). Try another narration voice or provider.`);
    err.code = 'TTS_SILENT';
    throw err;
  }
}

/** Scales a clip so its peak sits near -1 dBFS (never amplifies more than 8x, never clips). */
export function normalizePeak(samples, target = 0.89) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  if (!peak) return samples;
  const gain = Math.min(8, (target * 32767) / peak);
  if (Math.abs(gain - 1) < 0.05) return samples;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * gain)));
  return out;
}

/** Decodes the audio track of a finished media file and measures it (proves the AAC stream carries speech). */
export function measureMediaAudio(tools, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Could not decode the audio track: ${err.slice(-300)}`));
      const buf = Buffer.concat(chunks);
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
      resolve(audioLevels(samples, 16000));
    });
  });
}
