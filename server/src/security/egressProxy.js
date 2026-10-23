// A local, per-analysis forward proxy that all headless-browser traffic is
// forced through. Every request (page, subresource, XHR, WebSocket over TLS)
// is validated against the outbound policy and connected to a pinned,
// validated IP address. This is what stops a scanned page from making the
// browser reach localhost, private networks or cloud metadata endpoints.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { checkHostAndPort, resolvePublicAddresses } from './targetPolicy.js';

export async function startEgressProxy(policy, { maxRequests = 300, logger } = {}) {
  const username = 'sr';
  const password = crypto.randomBytes(12).toString('hex');
  const expectedAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const stats = { allowed: 0, blocked: [], limitHit: false };
  const sockets = new Set();

  function authorize(req) {
    return req.headers['proxy-authorization'] === expectedAuth;
  }

  async function validate(host, port, protocol) {
    if (stats.allowed >= maxRequests) {
      stats.limitHit = true;
      throw Object.assign(new Error('request limit reached'), { reason: 'request-limit' });
    }
    const url = new URL(`${protocol}//${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`);
    checkHostAndPort(url, policy);
    const records = await resolvePublicAddresses(url.hostname.replace(/^\[|\]$/g, ''), policy, { port });
    stats.allowed += 1;
    return records.find(r => r.family === 4) || records[0];
  }

  function recordBlock(target, err) {
    if (stats.blocked.length < 100) {
      stats.blocked.push({ target, reason: err.details?.reason || err.reason || 'policy', message: err.message });
    }
    logger?.debug?.('egress blocked', { target, reason: err.message });
  }

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP proxying (absolute-form request URI).
    if (!authorize(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="stackreel"' });
      return res.end();
    }
    let target;
    try {
      target = new URL(req.url);
      if (target.protocol !== 'http:') throw new Error('unsupported scheme');
    } catch {
      res.writeHead(400); return res.end('bad request');
    }
    const port = Number(target.port || 80);
    let pinned;
    try {
      pinned = await validate(target.hostname.replace(/^\[|\]$/g, ''), port, 'http:');
    } catch (err) {
      recordBlock(target.host, err);
      res.writeHead(403, { 'content-type': 'text/plain', 'x-stackreel-blocked': '1' });
      return res.end('Blocked by StackReel egress policy');
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request({
      host: pinned.address,
      family: pinned.family,
      port,
      method: req.method,
      path: target.pathname + target.search,
      headers: { ...headers, host: target.host },
      timeout: 15_000,
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });

  // HTTPS / WSS tunnelling.
  server.on('connect', async (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    clientSocket.on('error', () => {});
    if (!authorize(req)) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="stackreel"\r\n\r\n');
      return;
    }
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || '');
    if (!m) { clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const [, host, portStr] = m;
    const port = Number(portStr);
    let pinned;
    try {
      pinned = await validate(host, port, 'https:');
    } catch (err) {
      recordBlock(`${host}:${port}`, err);
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect({ host: pinned.address, port, family: pinned.family, timeout: 15_000 });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => clientSocket.destroy());
    upstream.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  });

  // Plain ws:// upgrades are refused outright (wss:// goes through CONNECT).
  server.on('upgrade', (req, socket) => {
    recordBlock(req.url, { message: 'plain websocket upgrade refused', reason: 'ws-upgrade' });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    server: `http://127.0.0.1:${port}`,
    username,
    password,
    stats,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise(r => server.close(() => r()));
    },
  };
}
