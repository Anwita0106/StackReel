// Minimal structured logger: JSON lines in production, readable lines in development.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger({ level = 'info', pretty = process.env.NODE_ENV !== 'production', base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < threshold) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg, ...base, ...fields };
    if (fields.err instanceof Error) {
      entry.err = { message: fields.err.message, code: fields.err.code, stack: lvl === 'error' ? fields.err.stack : undefined };
    }
    const stream = LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout;
    if (pretty) {
      const { time, level: _l, msg: _m, ...rest } = entry;
      const extras = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      stream.write(`${time.slice(11, 19)} ${lvl.toUpperCase().padEnd(5)} ${msg}${extras}\n`);
    } else {
      stream.write(JSON.stringify(entry) + '\n');
    }
  }

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (extra) => createLogger({ level, pretty, base: { ...base, ...extra } }),
  };
}
