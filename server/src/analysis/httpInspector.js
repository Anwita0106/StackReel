// Passive HTTP inspection: fetches the target document like a browser would,
// following a bounded number of redirects, re-validating every hop, pinning
// each connection to a validated public IP and capping the bytes read.
import tls from 'node:tls';
import dns from 'node:dns';
import { Agent, fetch } from 'undici';
import { validateTarget, createSafeLookup, effectivePort, checkHostAndPort } from '../security/targetPolicy.js';
import { AppError } from '../lib/errors.js';

function agentFor(policy, port, timeoutMs) {
  return new Agent({
    connect: { lookup: createSafeLookup(policy, { port }), timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
}

async function readBounded(body, maxBytes) {
  if (!body) return { buffer: Buffer.alloc(0), truncated: false, bytes: 0 };
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of body) {
    const remaining = maxBytes - total;
    if (chunk.byteLength > remaining) {
      chunks.push(Buffer.from(chunk).subarray(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }
    chunks.push(Buffer.from(chunk));
    total += chunk.byteLength;
  }
  if (truncated) {
    try { await body.cancel?.(); } catch { /* ignore */ }
  }
  return { buffer: Buffer.concat(chunks), truncated, bytes: total };
}

function headersToObject(headers) {
  const out = {};
  const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') out[key.toLowerCase()] = value;
  });
  return { headers: out, setCookies };
}

/**
 * Parses Set-Cookie headers into attribute summaries. Cookie VALUES are
 * deliberately discarded — only names and security attributes are kept.
 */
export function parseSetCookies(list) {
  return list.map((line) => {
    const [pair, ...attrs] = line.split(';').map(s => s.trim());
    const name = pair.split('=')[0];
    const lowerAttrs = attrs.map(a => a.toLowerCase());
    const find = (prefix) => attrs.find(a => a.toLowerCase().startsWith(prefix));
    const sameSite = find('samesite=')?.split('=')[1] || null;
    return {
      name,
      secure: lowerAttrs.includes('secure'),
      httpOnly: lowerAttrs.includes('httponly'),
      sameSite: sameSite ? sameSite[0].toUpperCase() + sameSite.slice(1).toLowerCase() : null,
      domain: find('domain=')?.split('=')[1] || null,
      path: find('path=')?.split('=')[1] || null,
      persistent: Boolean(find('expires=') || find('max-age=')),
      source: 'http',
    };
  });
}

export async function inspectHttp(input, policy, { logger, signal } = {}) {
  const started = Date.now();
  let current = (await validateTarget(input, policy)).url;
  const redirects = [];
  let response;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const port = effectivePort(current);
    checkHostAndPort(current, policy);
    const dispatcher = agentFor(policy, port, policy.httpTimeoutMs);
    const t0 = Date.now();
    try {
      response = await fetch(current.href, {
        method: 'GET',
        redirect: 'manual',
        dispatcher,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(policy.httpTimeoutMs)]) : AbortSignal.timeout(policy.httpTimeoutMs),
        headers: {
          'user-agent': policy.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.8',
        },
      });
    } catch (err) {
      await dispatcher.close().catch(() => {});
      const cause = err.cause || err;
      if (cause?.name === 'TargetPolicyError') throw cause;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new AppError(504, 'TARGET_TIMEOUT', `The website did not respond within ${Math.round(policy.httpTimeoutMs / 1000)} seconds.`);
      }
      throw new AppError(502, 'TARGET_UNREACHABLE', `Could not connect to ${current.host}: ${cause?.code || cause?.message || err.message}.`);
    }
    const elapsed = Date.now() - t0;

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      await dispatcher.close().catch(() => {});
      redirects.push({ from: current.href, status: response.status, location, elapsedMs: elapsed });
      if (redirects.length > policy.maxRedirects) {
        throw new AppError(422, 'TOO_MANY_REDIRECTS', `The site redirected more than ${policy.maxRedirects} times.`);
      }
      let next;
      try { next = new URL(location, current); } catch {
        throw new AppError(422, 'BAD_REDIRECT', `The site sent an invalid redirect location: ${location.slice(0, 200)}`);
      }
      // Re-validate every hop: scheme, hostname, port and resolved addresses.
      current = (await validateTarget(next, policy)).url;
      continue;
    }

    const { headers, setCookies } = headersToObject(response.headers);
    const contentType = headers['content-type'] || '';
    const isHtml = /html|xml/i.test(contentType) || !contentType;
    let body = { buffer: Buffer.alloc(0), truncated: false, bytes: 0 };
    if (isHtml) body = await readBounded(response.body, policy.maxHtmlBytes);
    else await response.body?.cancel().catch(() => {});
    await dispatcher.close().catch(() => {});

    logger?.debug?.('http inspection complete', { url: current.href, status: response.status, attempts });
    return {
      requestedUrl: typeof input === 'string' ? input : input.href,
      finalUrl: current.href,
      status: response.status,
      statusText: response.statusText,
      headers,
      cookies: parseSetCookies(setCookies),
      redirects,
      contentType,
      html: isHtml ? body.buffer.toString('utf8') : '',
      htmlBytes: body.bytes,
      htmlTruncated: body.truncated,
      timingMs: { total: Date.now() - started, finalResponse: elapsed },
    };
  }
}

/** Opens a TLS connection to read negotiated protocol, cipher, ALPN and certificate metadata. */
export function probeTls(url, policy, { timeoutMs = 8000 } = {}) {
  if (url.protocol !== 'https:') return Promise.resolve(null);
  const port = effectivePort(url);
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: url.hostname,
      servername: url.hostname,
      port,
      lookup: createSafeLookup(policy, { port }),
      ALPNProtocols: ['h2', 'http/1.1'],
      rejectUnauthorized: false, // we report validity ourselves instead of failing the analysis
      timeout: timeoutMs,
    });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(false) || {};
      done({
        protocol: socket.getProtocol(),
        cipher: socket.getCipher()?.name || null,
        alpn: socket.alpnProtocol || null,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        certificate: cert && cert.subject ? {
          subject: cert.subject?.CN || null,
          issuer: [cert.issuer?.O, cert.issuer?.CN].filter(Boolean).join(' — ') || null,
          validFrom: cert.valid_from || null,
          validTo: cert.valid_to || null,
          altNameCount: cert.subjectaltname ? cert.subjectaltname.split(',').length : 0,
        } : null,
      });
    });
    socket.once('timeout', () => done({ error: 'TLS probe timed out' }));
    socket.once('error', (err) => done({ error: err.code || err.message }));
  });
}

/** Checks whether plain http:// on the same host redirects to https://. */
export async function probeHttpsUpgrade(url, policy) {
  if (url.protocol !== 'https:' || url.port || !policy.allowedPorts.includes(80)) return null;
  const httpUrl = new URL(url.href);
  httpUrl.protocol = 'http:';
  const dispatcher = agentFor(policy, 80, 6000);
  try {
    const res = await fetch(httpUrl.origin + '/', {
      redirect: 'manual', dispatcher, signal: AbortSignal.timeout(6000),
      headers: { 'user-agent': policy.userAgent },
    });
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get('location');
    return {
      status: res.status,
      location,
      upgradesToHttps: Boolean(location && /^https:/i.test(new URL(location, httpUrl).href)),
    };
  } catch (err) {
    return { error: (err.cause || err).code || err.message };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

/** Collects public DNS records for the final host (CNAME chain, A/AAAA, NS for the registrable domain). */
export async function collectDns(host, { timeoutMs = 4000 } = {}) {
  const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
  const out = { cname: [], a: [], aaaa: [], ns: [] };
  const apex = host.split('.').slice(-2).join('.');
  const [cname, a, aaaa, ns] = await Promise.allSettled([
    resolver.resolveCname(host), resolver.resolve4(host), resolver.resolve6(host), resolver.resolveNs(apex),
  ]);
  if (cname.status === 'fulfilled') out.cname = cname.value;
  if (a.status === 'fulfilled') out.a = a.value.slice(0, 8);
  if (aaaa.status === 'fulfilled') out.aaaa = aaaa.value.slice(0, 8);
  if (ns.status === 'fulfilled') out.ns = ns.value.slice(0, 8);
  return out;
}
