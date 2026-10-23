import crypto from 'node:crypto';
import { AppError, tooMany } from '../lib/errors.js';

export function requestContext(logger) {
  return (req, res, next) => {
    req.id = req.get('x-request-id')?.slice(0, 64).replace(/[^\w-]/g, '') || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const quiet = req.path.startsWith('/api/jobs/') || req.path === '/api/health';
      (quiet && res.statusCode < 400 ? logger.debug : logger.info)('request', { reqId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) });
    });
    next();
  };
}

/**
 * CORS with an explicit allow-list. Requests without an Origin header
 * (curl, server-to-server, same-origin GETs) are unaffected. A disallowed
 * Origin receives a clear 403 JSON error instead of an opaque failure.
 */
export function corsPolicy(allowedOrigins, logger) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.get('origin');
    res.setHeader('Vary', 'Origin');
    if (!origin) return next();
    if (!allowed.has(origin)) {
      // Same-origin requests (e.g. the production build served by this server) carry Origin = our own host.
      const self = `${req.protocol}://${req.get('host')}`;
      if (origin === self) return next();
      logger.warn('CORS origin rejected', { origin, path: req.path });
      return res.status(403).json({
        ok: false,
        error: {
          code: 'CORS_ORIGIN_NOT_ALLOWED',
          message: `Origin ${origin} is not allowed to call this API. Add it to CORS_ORIGINS in .env (comma-separated) and restart the server.`,
        },
      });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Content-Range, Accept-Ranges, Content-Length');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id, Range');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  };
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

export function requestTimeout(ms) {
  return (req, res, next) => {
    res.setTimeout(ms, () => {
      if (!res.headersSent) res.status(503).json({ ok: false, error: { code: 'REQUEST_TIMEOUT', message: 'The server took too long to respond.' } });
    });
    next();
  };
}

/** Fixed-window per-IP rate limiter for expensive endpoints. */
export function rateLimit({ windowMs, max, name }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.start + windowMs - now) / 1000));
      return next(tooMany(`Too many ${name} requests. Please wait a minute and try again.`));
    }
    next();
  };
}

export function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return next(new AppError(400, 'VALIDATION_ERROR', 'The request body is invalid.', parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))));
    }
    req.valid = parsed.data;
    next();
  };
}

export function notFoundHandler(req, res) {
  res.status(404).json({ ok: false, error: { code: 'ROUTE_NOT_FOUND', message: `No API route for ${req.method} ${req.path}.` }, requestId: req.id });
}

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
    if (err.type === 'entity.too.large') err = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) logger.error('unhandled error', { reqId: req.id, err });
    if (res.headersSent) return;
    res.status(status).json({
      ok: false,
      error: {
        code: err.code || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR'),
        message: status === 500 && !(err instanceof AppError) ? 'Unexpected server error. Check the server logs for details.' : err.message,
        ...(err.details ? { details: err.details } : {}),
      },
      requestId: req.id,
    });
  };
}
