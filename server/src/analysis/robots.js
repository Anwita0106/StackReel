// Minimal robots.txt evaluation (RFC 9309 longest-match semantics) so the
// inspector honours sites that disallow automated access.
import { Agent, fetch } from 'undici';
import { createSafeLookup, effectivePort } from '../security/targetPolicy.js';

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function ruleMatches(rulePath, path) {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith('$');
  const pattern = rulePath.replace(/\$$/, '').split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + pattern + (anchored ? '$' : '')).test(path);
}

export function isAllowed(groups, userAgentToken, path) {
  const token = userAgentToken.toLowerCase();
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && token.includes(a)));
  const applicable = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  let best = null;
  for (const g of applicable) {
    for (const r of g.rules) {
      if (r.path === '' && !r.allow) continue; // "Disallow:" (empty) means allow all
      if (ruleMatches(r.path, path)) {
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
      }
    }
  }
  return best ? best.allow : true;
}

export async function checkRobots(url, policy, { token = 'StackReelInspector' } = {}) {
  const port = effectivePort(url);
  const dispatcher = new Agent({ connect: { lookup: createSafeLookup(policy, { port }), timeout: 5000 } });
  try {
    const res = await fetch(new URL('/robots.txt', url).href, {
      redirect: 'manual', dispatcher, signal: AbortSignal.timeout(6000),
      headers: { 'user-agent': policy.userAgent },
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { fetched: true, status: res.status, allowed: true, note: 'No robots.txt restrictions found.' };
    }
    const text = (await res.text()).slice(0, 500_000);
    const groups = parseRobots(text);
    const allowed = isAllowed(groups, token, url.pathname || '/');
    return { fetched: true, status: 200, allowed, note: allowed ? 'robots.txt permits this path.' : 'robots.txt disallows automated access to this path.' };
  } catch (err) {
    return { fetched: false, allowed: true, note: `robots.txt could not be fetched (${(err.cause || err).code || err.message}).` };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
