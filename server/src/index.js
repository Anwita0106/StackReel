// Server entry point: configuration, startup diagnostics, port-conflict
// handling and graceful shutdown.
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`\n✖ Configuration error: ${err.message}\n  Check your .env file (see .env.example).\n`);
  process.exit(1);
}
const logger = createLogger({ level: cfg.logLevel });

const { app, jobs, capabilities } = await createApp(cfg, { logger });
const server = app.listen(cfg.port, cfg.host);

server.on('listening', async () => {
  const { port } = server.address();
  logger.info(`StackReel API listening on http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${port}`);
  logger.info(`Allowed browser origins: ${cfg.corsOrigins.join(', ') || '(none — same-origin only)'}`);
  const caps = await capabilities.get().catch(() => null);
  if (caps) {
    logger.info(`FFmpeg: ${caps.media.ffmpeg.available ? 'ok' : `MISSING (${caps.media.ffmpeg.error})`} · Browser analysis: ${caps.browser.available ? 'ok' : `unavailable — ${caps.browser.reason}`}`);
    logger.info(`Narration: ${caps.tts.default ? `TTS provider "${caps.tts.default}"` : `TTS provider "${caps.tts.configured}" unavailable`} · LLM: ${caps.llm.ready ? caps.llm.provider : 'off (deterministic script)'}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✖ Port ${cfg.port} is already in use, so the StackReel API cannot start.\n
  Another program (often an older StackReel server) is listening on ${cfg.port}.
  Find and stop it:
    Windows (PowerShell):  Get-NetTCPConnection -LocalPort ${cfg.port} | Select-Object OwningProcess
                           Stop-Process -Id <PID>
    Windows (cmd):         netstat -ano | findstr :${cfg.port}   then   taskkill /PID <PID> /F
    macOS / Linux:         lsof -i :${cfg.port}   then   kill <PID>
  Or choose another port by setting PORT=5002 in .env — the frontend dev proxy reads the
  same .env, so both sides stay in sync automatically.\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n✖ Permission denied binding to port ${cfg.port}. Use a port above 1024.\n`);
  } else {
    console.error('\n✖ Server failed to start:', err.message);
  }
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down gracefully`);
  const force = setTimeout(() => { logger.warn('forced exit after timeout'); process.exit(1); }, 10_000);
  force.unref();
  await jobs.shutdown();
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error('unhandled promise rejection', { err }));
