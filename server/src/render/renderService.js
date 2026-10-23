// Supervises render workers. Each render runs in its own child process with
// a hard timeout; the parent independently re-verifies the MP4 with ffprobe
// before a render is recorded as complete. Failed/cancelled renders leave no
// files behind.
import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { newId } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { resolveMediaTools, probeMedia, verifyProbe, removeDir } from './media.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'renderWorker.js');

export const RENDER_STAGES = ['Synthesizing narration', 'Building timeline', 'Rendering frames', 'Verifying output'];
export const RESOLUTIONS = { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080] };

export function createRenderRunner({ store, cfg, logger }) {
  return async function runRender({ projectId, options }, ctx) {
    const project = await store.getProject(projectId);
    if (!project) throw new AppError(404, 'NOT_FOUND', 'Project no longer exists.');
    const renderId = newId('rnd');
    const outDir = store.renderDir(renderId);
    await fs.mkdir(outDir, { recursive: true });
    const [width, height] = RESOLUTIONS[options.resolution];

    const job = {
      project: { ...project, screenshotPath: store.screenshotPath(projectId) },
      options: { ...options, width, height, maxDurationSec: cfg.render.maxDurationSec },
      outDir,
      ttsConfig: cfg.tts,
      mediaConfig: cfg.render,
    };

    let child;
    try {
      const result = await new Promise((resolve, reject) => {
        child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
        let settled = false;
        const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort); fn(v); } };
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(reject, new AppError(504, 'RENDER_TIMEOUT', `Rendering exceeded ${Math.round(cfg.render.timeoutMs / 60000)} minutes and was stopped.`));
        }, cfg.render.timeoutMs);
        const onAbort = () => { child.send?.({ type: 'cancel' }); setTimeout(() => child.kill('SIGKILL'), 1500).unref(); };
        ctx.signal.addEventListener('abort', onAbort);
        child.on('message', (msg) => {
          if (msg.type === 'ready') child.send({ type: 'start', job });
          else if (msg.type === 'progress') ctx.setStage(msg.stage, msg.progress, msg.log);
          else if (msg.type === 'done') finish(resolve, msg.result);
          else if (msg.type === 'error') finish(reject, Object.assign(new AppError(500, msg.code || 'RENDER_FAILED', msg.message), { transient: msg.transient }));
        });
        child.on('error', (err) => finish(reject, new AppError(500, 'RENDER_WORKER_ERROR', `Render worker failed to start: ${err.message}`)));
        child.on('exit', (code, signal) => finish(reject, new AppError(500, 'RENDER_WORKER_EXIT', ctx.signal.aborted ? 'Render cancelled' : `Render worker exited unexpectedly (${signal || code}).`)));
      });

      // Independent verification in the parent process.
      const tools = resolveMediaTools(cfg.render);
      const probe = await probeMedia(tools, path.join(outDir, result.files.video));
      const problems = verifyProbe(probe, { expectedDurationSec: result.timeline.duration, width, height });
      if (problems.length) throw new AppError(500, 'RENDER_VERIFY_FAILED', `Rendered file failed verification: ${problems.join('; ')}`);

      const record = {
        id: renderId,
        projectId,
        host: project.site.host,
        createdAt: new Date().toISOString(),
        options,
        ...result,
        probe,
        sizeBytes: probe.sizeBytes,
        durationSec: Math.round(probe.durationSec * 100) / 100,
        scriptProvider: project.script.provider,
      };
      await store.saveRender(record);
      ctx.log(`Verified MP4: ${probe.video.codec} ${probe.video.width}x${probe.video.height} + ${probe.audio.codec}, ${record.durationSec}s, ${(probe.sizeBytes / 1048576).toFixed(1)} MB`);
      return { renderId, projectId, durationSec: record.durationSec };
    } catch (err) {
      await removeDir(outDir);
      if (child && child.exitCode === null) child.kill('SIGKILL');
      logger?.warn?.('render failed', { projectId, err });
      throw err;
    }
  };
}
