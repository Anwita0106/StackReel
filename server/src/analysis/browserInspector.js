// Headless-browser inspection. Chromium runs as a separate OS process and
// ALL of its traffic is forced through the per-analysis egress proxy, which
// validates every destination. Downloads, service workers, non-HTTP schemes
// and plain WebSocket upgrades are blocked. Nothing from the page is executed
// inside the Node.js process: only JSON-serializable summaries come back.
import { startEgressProxy } from '../security/egressProxy.js';

let chromiumModule = null;
async function loadChromium() {
  if (!chromiumModule) {
    try {
      chromiumModule = (await import('playwright')).chromium;
    } catch {
      chromiumModule = (await import('playwright-core')).chromium;
    }
  }
  return chromiumModule;
}

// Safety flags kept in EVERY launch mode (all traffic still goes through the egress proxy).
const SAFETY_ARGS = ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--no-first-run', '--disable-extensions'];
const HARDENED_ARGS = [
  ...SAFETY_ARGS,
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
  '--disable-client-side-phishing-detection', '--disable-domain-reliability', '--disable-component-extensions-with-background-pages', '--no-pings',
  '--disable-features=PrivateNetworkAccessSendPreflights,MediaRouter,OptimizationHints,OptimizationGuideModelDownloading,AutofillServerCommunication,Translate,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater',
];
// Conservative mode for machines where the hardened profile crashes (seen on some Windows PCs / GPU drivers / antivirus).
const COMPAT_ARGS = [...SAFETY_ARGS, '--disable-gpu', '--disable-dev-shm-usage'];

function systemBrowserPaths() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return [
      ...roots.map(r => `${r}\\Google\\Chrome\\Application\\chrome.exe`),
      ...roots.map(r => `${r}\\Microsoft\\Edge\\Application\\msedge.exe`),
    ];
  }
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}

/** Every browser executable StackReel may use, in order of preference. */
export async function browserCandidates(cfg) {
  const fs = await import('node:fs');
  const out = [];
  const add = (path, label) => { if (path && fs.existsSync(path) && !out.some(c => c.path === path)) out.push({ path, label }); };
  if (cfg.browserExecutablePath) add(cfg.browserExecutablePath, 'BROWSER_EXECUTABLE_PATH');
  try { const chromium = await loadChromium(); add(chromium.executablePath(), 'Playwright Chromium'); } catch { /* not installed */ }
  for (const p of systemBrowserPaths()) add(p, /edge/i.test(p) ? 'Microsoft Edge (installed)' : /chrome/i.test(p) ? 'Google Chrome (installed)' : 'Chromium (installed)');
  return out;
}

/** Returns { available, reason, executable } without launching a full analysis. */
export async function checkBrowserAvailability(cfg) {
  if (!cfg.browserEnabled) return { available: false, reason: 'Browser analysis is disabled (BROWSER_ANALYSIS=false).' };
  try {
    await loadChromium();
  } catch (err) {
    return { available: false, reason: `Playwright is not available: ${err.message}` };
  }
  const candidates = await browserCandidates(cfg);
  if (!candidates.length) return { available: false, reason: 'No Chromium, Chrome or Edge found. Run "npm run setup:browser" (npx playwright install chromium).' };
  return { available: true, executable: candidates[0].path, candidates: candidates.map(c => c.label) };
}

/**
 * Launches a browser and proves it can open a page. Tries the hardened
 * profile first, then a compatibility profile, then installed Chrome/Edge.
 * Chromium's own stderr is captured so a crash is explained, not hidden.
 * Returns { browser, context, page, mode } or throws with every attempt's reason.
 */
export async function launchBrowser(policy, proxy, { logger, compat = false } = {}) {
  const chromium = await loadChromium();
  const candidates = await browserCandidates(policy);
  if (!candidates.length) throw new Error('No browser executable found. Run "npm run setup:browser".');
  const attempts = [];
  for (const [i, c] of candidates.entries()) {
    if (!compat) attempts.push({ ...c, args: HARDENED_ARGS, profile: 'hardened' });
    if (i === 0 || compat) attempts.push({ ...c, args: COMPAT_ARGS, profile: 'compatibility' });
  }
  const failures = [];
  for (const a of attempts.slice(0, 5)) {
    const stderr = [];
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: a.path,
        proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: '<-loopback>' },
        args: a.args,
        timeout: 30_000,
        logger: { isEnabled: (name) => name === 'browser', log: (name, sev, msg) => { if (/err|crash|fatal|error/i.test(String(msg)) && stderr.length < 8) stderr.push(String(msg).slice(0, 200)); } },
      });
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US', permissions: [] });
      const page = await context.newPage();
      await page.goto('about:blank', { timeout: 10_000 });
      const mode = `${a.label}, ${a.profile} profile`;
      if (failures.length) logger?.warn?.('browser started after fallback', { mode, failures });
      return { browser, context, page, mode, failures };
    } catch (err) {
      await browser?.close().catch(() => {});
      failures.push(`${a.label} (${a.profile}): ${err.message.split('\n')[0].slice(0, 160)}${stderr.length ? ` — chromium said: ${stderr.join(' | ')}` : ''}`);
    }
  }
  throw new Error(`The headless browser could not open a page. Attempts: ${failures.join(' ;; ')}`);
}

function sanitizeUrl(raw) {
  // Keep scheme/host/path and query parameter NAMES only (values can contain tokens).
  try {
    const u = new URL(raw);
    const keys = [...new Set([...u.searchParams.keys()])].slice(0, 12);
    return { href: `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300), host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), protocol: u.protocol, path: u.pathname.slice(0, 200), queryKeys: keys };
  } catch {
    return { href: String(raw).slice(0, 120), host: '', protocol: '', path: '', queryKeys: [] };
  }
}

// Runs inside the page. Must be self-contained and return plain data.
/* c8 ignore start */
function collectDomFacts() {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const meta = (name) => (q(`meta[name="${name}"]`) || q(`meta[property="${name}"]`))?.getAttribute('content') || null;
  const w = window;
  const fp = {};
  const safe = (fn) => { try { return fn(); } catch { return undefined; } };

  fp.nextData = !!q('script#__NEXT_DATA__') || !!w.__NEXT_DATA__;
  fp.nextVersion = safe(() => w.next && w.next.version) || null;
  fp.nextAppRouter = !!w.__next_f;
  const roots = [q('#root'), q('#__next'), q('#app'), document.body && document.body.firstElementChild].filter(Boolean);
  fp.reactRoot = !!q('[data-reactroot]') || roots.some(el => Object.keys(el).some(k => k.startsWith('__reactContainer$') || k.startsWith('_reactRootContainer') || k.startsWith('__reactFiber$')));
  fp.reactVersion = safe(() => w.React && w.React.version) || null;
  const vueEl = q('[data-v-app]') || roots.find(el => el.__vue_app__ || el.__vue__);
  fp.vue = !!vueEl || !!w.Vue || !!q('[data-v-]');
  fp.vueVersion = safe(() => (vueEl && vueEl.__vue_app__ && vueEl.__vue_app__.version) || (w.Vue && w.Vue.version)) || null;
  fp.nuxt = !!w.__NUXT__ || !!w.$nuxt || !!q('#__nuxt') || !!w.useNuxtApp;
  fp.angularVersion = q('[ng-version]')?.getAttribute('ng-version') || null;
  fp.angularJs = safe(() => w.angular && w.angular.version && w.angular.version.full) || null;
  fp.svelteKit = !!q('[data-sveltekit-preload-data]') || !!q('[data-sveltekit-hydrate]') || Object.keys(w).some(k => k.startsWith('__sveltekit'));
  fp.svelte = fp.svelteKit || !!q('[class*="svelte-"]');
  fp.gatsby = !!q('#___gatsby') || !!w.___gatsby;
  fp.remix = !!w.__remixContext;
  fp.reactRouter = !!w.__reactRouterContext;
  fp.astro = !!q('astro-island') || !!q('[data-astro-cid]') || Array.from(document.documentElement.attributes).some(a => a.name.startsWith('data-astro'));
  fp.ember = safe(() => w.Ember && w.Ember.VERSION) || null;
  fp.jquery = safe(() => w.jQuery && w.jQuery.fn && w.jQuery.fn.jquery) || null;
  fp.solid = !!w._$HY;
  fp.qwik = !!q('[q\\:container]');
  fp.alpine = !!w.Alpine || !!q('[x-data]');
  fp.htmx = !!w.htmx || !!q('[hx-get],[hx-post]');
  fp.shopify = !!w.Shopify;
  fp.webflow = !!document.documentElement.getAttribute('data-wf-site');
  fp.wix = !!w.wixBiSession;
  fp.squarespace = !!(w.Static && w.Static.SQUARESPACE_CONTEXT);
  fp.drupal = !!w.Drupal;
  fp.wordpress = !!q('link[href*="/wp-content/"],script[src*="/wp-content/"],script[src*="/wp-includes/"]');
  fp.webpack = Object.keys(w).some(k => k.startsWith('webpackChunk'));
  fp.gtm = !!w.google_tag_manager;
  fp.dataLayer = Array.isArray(w.dataLayer);
  fp.bootstrap = safe(() => (w.bootstrap && w.bootstrap.Tooltip && w.bootstrap.Tooltip.VERSION)) ||
    (getComputedStyle(document.documentElement).getPropertyValue('--bs-blue').trim() ? 'css' : null);
  const sample = [document.body, ...qa('body *').slice(0, 60)].filter(Boolean);
  fp.tailwind = sample.some(el => {
    const cs = getComputedStyle(el);
    return cs.getPropertyValue('--tw-ring-offset-width').trim() !== '' || cs.getPropertyValue('--tw-border-spacing-x').trim() !== '' || cs.getPropertyValue('--tw-shadow').trim() !== '';
  });

  const forms = qa('form');
  return {
    title: document.title.slice(0, 200),
    lang: document.documentElement.lang || null,
    description: meta('description')?.slice(0, 300) || null,
    generator: meta('generator')?.slice(0, 120) || null,
    ogSiteName: meta('og:site_name')?.slice(0, 120) || null,
    ogType: meta('og:type') || null,
    themeColor: meta('theme-color') || null,
    manifest: !!q('link[rel="manifest"]'),
    canonical: q('link[rel="canonical"]')?.getAttribute('href')?.slice(0, 300) || null,
    counts: {
      elements: document.getElementsByTagName('*').length,
      scripts: qa('script[src]').length,
      inlineScripts: qa('script:not([src])').length,
      stylesheets: qa('link[rel="stylesheet"]').length,
      iframes: qa('iframe').length,
      images: qa('img').length,
      forms: forms.length,
      passwordInputs: qa('input[type="password"]').length,
      links: qa('a[href]').length,
    },
    scriptSrcs: qa('script[src]').map(s => ({ src: s.src.slice(0, 300), integrity: !!s.integrity, async: s.async, defer: s.defer, module: s.type === 'module' })).slice(0, 120),
    stylesheetHrefs: qa('link[rel="stylesheet"]').map(l => l.href.slice(0, 300)).slice(0, 60),
    formActions: forms.map(f => ({ method: (f.method || 'get').toUpperCase(), action: (f.getAttribute('action') || '').slice(0, 200) })).slice(0, 20),
    fingerprints: fp,
  };
}
/* c8 ignore stop */

export async function inspectWithBrowser(targetUrl, policy, { logger, signal, compat = false } = {}) {
  let launchMode = null;
  let launchFailures = [];
  const proxy = await startEgressProxy(policy, { maxRequests: policy.maxBrowserRequests, logger });
  let browser;
  const killTimer = setTimeout(() => { browser?.close().catch(() => {}); }, policy.browserTimeoutMs + 15_000);
  const onAbort = () => browser?.close().catch(() => {});
  signal?.addEventListener('abort', onAbort);

  const requests = [];
  const websockets = [];
  const consoleErrors = [];
  let blockedByRoute = 0;
  let mainDocument = null;

  try {
    const launched = await launchBrowser(policy, proxy, { logger, compat });
    browser = launched.browser;
    const { context, page } = launched;
    launchMode = launched.mode;
    launchFailures = launched.failures;
    page.setDefaultTimeout(policy.browserTimeoutMs);

    await page.route('**/*', (route) => {
      const req = route.request();
      const url = req.url();
      if (!/^(https?|data|blob):/i.test(url)) { blockedByRoute += 1; return route.abort('blockedbyclient'); }
      if (requests.length >= policy.maxBrowserRequests) { blockedByRoute += 1; return route.abort('blockedbyclient'); }
      if (req.resourceType() === 'media') { // never stream audio/video bodies
        recordRequest(req, { aborted: 'media-not-downloaded' });
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });

    const byRequest = new Map();
    function recordRequest(req, extra = {}) {
      if (!/^https?:/i.test(req.url())) return null;
      if (requests.length >= policy.maxBrowserRequests) return null;
      const entry = { ...sanitizeUrl(req.url()), method: req.method(), type: req.resourceType(), status: null, contentType: null, failed: null, ...extra };
      requests.push(entry);
      byRequest.set(req, entry);
      return entry;
    }
    page.on('request', (req) => { if (!byRequest.has(req)) recordRequest(req); });
    page.on('response', async (res) => {
      const entry = byRequest.get(res.request());
      if (!entry) return;
      entry.status = res.status();
      const headers = res.headers();
      entry.contentType = (headers['content-type'] || '').split(';')[0].slice(0, 80) || null;
      entry.server = headers.server?.slice(0, 80) || null;
      if (headers['x-stackreel-blocked'] === '1') { entry.blocked = true; entry.status = null; }
      if (!mainDocument && res.request().isNavigationRequest() && res.request().frame() === page.mainFrame()) {
        mainDocument = { url: res.url(), status: res.status() };
      }
    });
    page.on('requestfailed', (req) => {
      const entry = byRequest.get(req);
      if (entry && !entry.aborted) {
        entry.failed = req.failure()?.errorText?.slice(0, 120) || 'failed';
        if (/TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|BLOCKED_BY_CLIENT/i.test(entry.failed)) entry.blocked = true;
      }
    });
    page.on('websocket', (ws) => { if (websockets.length < 20) websockets.push(sanitizeUrl(ws.url())); });
    page.on('console', (msg) => { if (msg.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(msg.text().slice(0, 200)); });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('popup', (p) => p.close().catch(() => {}));

    const t0 = Date.now();
    let navError = null;
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: policy.browserTimeoutMs });
    } catch (err) {
      navError = err.message.split('\n')[0].slice(0, 200);
    }
    const domContentLoadedMs = Date.now() - t0;
    if (!navError) {
      await page.waitForLoadState('networkidle', { timeout: policy.browserSettleMs + 4000 }).catch(() => {});
      await page.waitForTimeout(Math.min(policy.browserSettleMs, 1500));
    }

    let dom = null;
    let screenshot = null;
    if (!navError) {
      dom = await page.evaluate(collectDomFacts).catch((err) => ({ error: err.message.slice(0, 200) }));
      screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false, timeout: 8000 }).catch(() => null);
    }
    const cookies = (await context.cookies().catch(() => [])).slice(0, 60).map(c => ({
      name: c.name.slice(0, 80), domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
      sameSite: c.sameSite, persistent: c.expires > 0, source: 'browser',
    }));
    const finalUrl = page.url();
    // Mark requests that failed because StackReel's egress policy refused them.
    const blockedTargets = new Set(proxy.stats.blocked.map(b => (/:\d+$/.test(b.target) ? b.target : `${b.target}:80`).toLowerCase()));
    for (const r of requests) {
      if (!r.blocked && r.failed && blockedTargets.has(`${r.host}:${r.port}`.toLowerCase())) r.blocked = true;
    }
    return {
      ok: !navError,
      error: navError,
      finalUrl,
      mainDocument,
      timingMs: { domContentLoaded: domContentLoadedMs, total: Date.now() - t0 },
      dom,
      requests,
      websockets,
      cookies,
      launchMode,
      launchFailures,
      consoleErrorCount: consoleErrors.length,
      consoleErrors: consoleErrors.slice(0, 5),
      screenshot,
      limits: {
        requestLimitHit: proxy.stats.limitHit || requests.length >= policy.maxBrowserRequests,
        blockedByPolicy: proxy.stats.blocked,
        blockedByRoute,
      },
    };
  } finally {
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => {});
    await proxy.close().catch(() => {});
  }
}
