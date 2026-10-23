// Builds the Express application from injected dependencies (used by the
// server entry point and by the tests).
import express from 'express';
import fss from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import { createFileStore } from './store/fileStore.js';
import { createJobManager } from './jobs/jobManager.js';
import { runAnalysis, ANALYSIS_STAGES } from './analysis/pipeline.js';
import { createRenderRunner, RENDER_STAGES } from './render/renderService.js';
import { checkBrowserAvailability } from './analysis/browserInspector.js';
import { checkMediaTools } from './render/media.js';
import { ttsStatus } from './tts/index.js';
import { llmStatus } from './narration/llm.js';
import { createApiRouter } from './routes/api.js';
import { requestContext, corsPolicy, securityHeaders, requestTimeout, notFoundHandler, errorHandler } from './middleware/index.js';

function createCapabilities(cfg) {
  let cache = null;
  let at = 0;
  return {
    async get(refresh = false) {
      if (!refresh && cache && Date.now() - at < 60_000) return cache;
      const [browser, media, tts] = await Promise.all([checkBrowserAvailability(cfg.analysis), checkMediaTools(cfg.render), ttsStatus(cfg.tts)]);
      cache = { browser, media, tts, llm: llmStatus(cfg.llm), limits: { maxVideoSeconds: cfg.render.maxDurationSec, allowedPorts: cfg.analysis.allowedPorts } };
      at = Date.now();
      return cache;
    },
  };
}

export async function createApp(cfg, { logger = createLogger({ level: cfg.logLevel }) } = {}) {
  const store = createFileStore(cfg.dataDir);
  const init = await store.init();
  if (init.removedIncompleteRenders) logger.info('removed incomplete renders from a previous run', init);

  const jobs = createJobManager({ logger, limits: { analysis: cfg.analysis.maxConcurrent, render: cfg.render.maxConcurrent } });
  const runRender = createRenderRunner({ store, cfg, logger });

  jobs.register('analysis', {
    stages: ANALYSIS_STAGES,
    maxAttempts: 2,
    async run(payload, ctx) {
      let out;
      try {
        out = await runAnalysis(payload, ctx, cfg, { logger });
      } catch (err) {
        // A connection reset/timeout is worth one automatic retry; policy errors are not.
        if (['TARGET_TIMEOUT', 'TARGET_UNREACHABLE'].includes(err.code)) err.transient = true;
        throw err;
      }
      await store.saveProject(out.analysis, { screenshot: out.screenshot });
      await store.pruneProjects(cfg.maxProjects);
      const result = { projectId: out.analysis.id, host: out.analysis.site.host };
      if (payload.autoRender) {
        const opts = (await import('./routes/api.js')).renderOptionsSchema.parse(payload.render || {});
        const { job } = jobs.enqueue('render', { projectId: out.analysis.id, options: opts }, { key: `${out.analysis.id}|${JSON.stringify(opts)}`, meta: { projectId: out.analysis.id, host: out.analysis.site.host } });
        result.renderJobId = job.id;
        ctx.log(`Queued video render ${job.id}`);
      }
      return result;
    },
  });
  jobs.register('render', { stages: RENDER_STAGES, maxAttempts: 2, run: runRender });

  const capabilities = createCapabilities(cfg);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(requestContext(logger));
  app.use(securityHeaders);
  app.use('/api', corsPolicy(cfg.corsOrigins, logger));
  app.use('/api', requestTimeout(cfg.requestTimeoutMs));
  app.use('/api', express.json({ limit: '64kb' }));
  app.use('/api', createApiRouter({ cfg, store, jobs, capabilities, logger }));
  app.use('/api', notFoundHandler);

  if (cfg.serveClient && fss.existsSync(path.join(cfg.clientDist, 'index.html'))) {
    app.use(express.static(cfg.clientDist, { index: false, maxAge: '1h', dotfiles: 'ignore' }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile('index.html', { root: cfg.clientDist }));
  }
  app.use(errorHandler(logger));

  return { app, store, jobs, capabilities, logger };
}
