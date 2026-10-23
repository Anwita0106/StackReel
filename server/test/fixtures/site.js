// Local fixture websites for deterministic tests (no internet needed).
//  - "site" (served on localhost:<port>) imitates a Next.js app behind nginx
//    with an Express backend, a JSON API, GraphQL and a third-party script.
//  - "thirdParty" (served on 127.0.0.1:<port>) plays an external script host.
//  - "internal" plays an internal service that must NEVER be reachable.
import http from 'node:http';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

export async function startFixtures() {
  const hits = { internal: 0, thirdParty: 0 };

  const internal = http.createServer((req, res) => { hits.internal += 1; res.end('internal secret'); });
  const internalPort = await listen(internal);

  const thirdParty = http.createServer((req, res) => {
    hits.thirdParty += 1;
    if (req.url.startsWith('/widget.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end('window.__widgetLoaded = true;');
    }
    res.writeHead(404); res.end();
  });
  const thirdPartyPort = await listen(thirdParty);

  let sitePort;
  const page = () => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Fixture Shop — StackReel test</title>
<meta name="description" content="A local fixture used by StackReel tests.">
<link rel="stylesheet" href="/_next/static/css/app.css">
<script src="/_next/static/chunks/main.js" defer></script>
<script src="http://127.0.0.1:${thirdPartyPort}/widget.js" async></script>
</head><body><div id="__next"><h1>Fixture Shop</h1><form method="post" action="/login"><input type="password" name="p"></form></div>
<script id="__NEXT_DATA__" type="application/json">{"props":{},"page":"/"}</script>
</body></html>`;

  const site = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const base = { server: 'nginx/1.25.3', 'x-powered-by': 'Express', 'x-frame-options': 'SAMEORIGIN' };
    switch (url.pathname) {
      case '/':
        res.writeHead(200, { ...base, 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['session_id=SECRETVALUE123; Path=/', 'pref=dark; Path=/; SameSite=Lax'] });
        return res.end(page());
      case '/_next/static/chunks/main.js':
        res.writeHead(200, { ...base, 'content-type': 'application/javascript' });
        return res.end(`window.next = { version: '14.2.3' };
fetch('/api/products?category=shoes&token=abc').then(r => r.json()).catch(() => {});
fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"{ products { id } }"}' }).catch(() => {});
fetch('http://127.0.0.1:${internalPort}/secret').catch(() => {});
fetch('http://169.254.169.254/latest/meta-data/').catch(() => {});`);
      case '/_next/static/css/app.css':
        res.writeHead(200, { ...base, 'content-type': 'text/css' });
        return res.end('h1{font-family:sans-serif}');
      case '/api/products':
        res.writeHead(200, { ...base, 'content-type': 'application/json' });
        return res.end(JSON.stringify([{ id: 1, name: 'Shoe' }]));
      case '/graphql':
        res.writeHead(200, { ...base, 'content-type': 'application/json' });
        return res.end('{"data":{"products":[]}}');
      case '/robots.txt':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('User-agent: *\nDisallow: /private\n');
      case '/private':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>private</html>');
      case '/redirect':
        res.writeHead(302, { location: '/' });
        return res.end();
      case '/redirect-internal':
        res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/` });
        return res.end();
      case '/redirect-metadata':
        res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        return res.end();
      case '/big': {
        res.writeHead(200, { 'content-type': 'text/html' });
        const chunk = '<p>' + 'x'.repeat(1000) + '</p>';
        let sent = 0;
        const write = () => {
          while (sent < 5000) {
            sent += 1;
            if (!res.write(chunk)) return res.once('drain', write);
          }
          res.end();
        };
        return write();
      }
      case '/static':
        res.writeHead(200, { 'content-type': 'text/html', server: 'Apache/2.4.58' });
        return res.end('<!doctype html><html><head><title>Static page</title><meta name="generator" content="Hugo 0.121.0"></head><body><p>Hello</p></body></html>');
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
    }
  });
  sitePort = await listen(site);
  // A port with nothing listening (connection refused).
  const tmp = http.createServer();
  const deadPort = await listen(tmp);
  await new Promise(r => tmp.close(r));

  return {
    sitePort,
    thirdPartyPort,
    internalPort,
    deadPort,
    hits,
    siteUrl: `http://localhost:${sitePort}`,
    // Exact host:port pairs the test policy allows. The internal server is NOT included.
    allowedTargets: [`localhost:${sitePort}`, `127.0.0.1:${thirdPartyPort}`, `localhost:${deadPort}`],
    async close() {
      await Promise.all([site, thirdParty, internal].map(s => new Promise(r => { s.closeAllConnections?.(); s.close(() => r()); })));
    },
  };
}
