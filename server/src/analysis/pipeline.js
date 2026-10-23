// End-to-end analysis pipeline. Each stage reports real progress; nothing is
// simulated, and every unavailable piece of evidence is recorded explicitly.
import { validateTarget } from '../security/targetPolicy.js';
import { inspectHttp, probeTls, probeHttpsUpgrade, collectDns } from './httpInspector.js';
import { inspectWithBrowser, checkBrowserAvailability } from './browserInspector.js';
import { checkRobots } from './robots.js';
import { createEvidenceStore } from './evidence.js';
import { buildFacts, detectTechnologies, detectIntegrations, summarizeTraffic, registrableDomain } from './detector.js';
import { analyzeSecurity } from './securityFindings.js';
import { buildGraph } from './graphBuilder.js';
import { generateScript } from '../narration/scriptGenerator.js';
import { refineScriptWithLlm } from '../narration/llm.js';
import { graphSchema, scriptSchema } from '../narration/schema.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

export const ANALYSIS_STAGES = [
  'Validating URL & destination',
  'Checking robots.txt',
  'Fetching document & headers',
  'Probing TLS & DNS',
  'Rendering in sandboxed browser',
  'Detecting technologies',
  'Assessing security posture',
  'Building architecture graph',
  'Writing narration script',
];

export async function runAnalysis({ url, targetDurationSec = 180, browser: useBrowser = true }, ctx, cfg, { logger } = {}) {
  const policy = cfg.analysis;
  const step = (i, p, line) => ctx.progress(i, p, line);
  const throwIfAborted = () => { if (ctx.signal?.aborted) throw new AppError(499, 'CANCELLED', 'Analysis cancelled'); };
  const unavailable = [];

  step(0, 3, `Normalizing and validating ${url}`);
  const target = await validateTarget(url, policy);
  step(0, 6, `Resolved ${target.host} → ${target.addresses.map(a => a.address).slice(0, 3).join(', ')} (all public)`);
  throwIfAborted();

  step(1, 8, 'Fetching /robots.txt');
  const robots = await checkRobots(target.url, policy);
  step(1, 10, robots.note);
  if (!robots.allowed) {
    throw new AppError(422, 'ROBOTS_DISALLOWED', 'This site\'s robots.txt disallows automated access to that page, so StackReel will not inspect it.');
  }
  throwIfAborted();

  step(2, 12, `GET ${target.url.href}`);
  const http = await inspectHttp(target.url, policy, { logger, signal: ctx.signal });
  for (const r of http.redirects) ctx.log(`Redirect ${r.status} → ${r.location}`);
  step(2, 25, `HTTP ${http.status} · ${Object.keys(http.headers).length} headers · ${(http.htmlBytes / 1024).toFixed(1)} KB HTML${http.htmlTruncated ? ' (truncated at limit)' : ''}`);
  if (http.htmlTruncated) unavailable.push(`HTML larger than ${Math.round(policy.maxHtmlBytes / 1024)} KB was truncated.`);
  if (http.status >= 400) unavailable.push(`The document returned HTTP ${http.status}; the site may block automated clients or require authentication, so evidence is limited.`);
  throwIfAborted();

  const finalUrl = new URL(http.finalUrl);
  step(3, 28, `TLS handshake with ${finalUrl.host}, DNS lookups, http→https probe`);
  const [tls, dns, upgrade] = await Promise.all([
    probeTls(finalUrl, policy),
    collectDns(finalUrl.hostname),
    probeHttpsUpgrade(finalUrl, policy),
  ]);
  if (tls?.error) unavailable.push(`TLS details unavailable: ${tls.error}.`);
  step(3, 34, tls && !tls.error ? `${tls.protocol} · ${tls.cipher} · ALPN ${tls.alpn || 'none'}` : 'TLS probe skipped or failed');
  throwIfAborted();

  let browser = null;
  if (useBrowser) {
    const availability = await checkBrowserAvailability(policy);
    if (availability.available) {
      step(4, 36, 'Launching isolated Chromium (all traffic through validating egress proxy)');
      try {
        try {
          browser = await inspectWithBrowser(http.finalUrl, policy, { logger, signal: ctx.signal });
        } catch (err) {
          // Some PCs (GPU drivers, antivirus hooks) crash the hardened profile mid-navigation: retry once in compatibility mode.
          if (ctx.signal?.aborted || !/closed|crash|disconnected|Target/i.test(err.message)) throw err;
          ctx.log(`Browser crashed (${err.message.split('\n')[0].slice(0, 120)}) — retrying in compatibility mode`);
          browser = await inspectWithBrowser(http.finalUrl, policy, { logger, signal: ctx.signal, compat: true });
        }
        if (browser.launchMode) ctx.log(`Browser: ${browser.launchMode}`);
        if (!browser.ok) unavailable.push(`The browser could not load the page: ${browser.error}`);
        step(4, 64, browser.ok
          ? `Rendered page · ${browser.requests.length} requests · ${browser.cookies.length} cookies · ${browser.websockets.length} websockets`
          : `Browser navigation failed: ${browser.error}`);
        if (browser.limits.blockedByPolicy.length) ctx.log(`Blocked ${browser.limits.blockedByPolicy.length} subrequest(s) to non-public destinations`);
        if (browser.limits.requestLimitHit) unavailable.push(`Request limit (${policy.maxBrowserRequests}) reached; later requests were not recorded.`);
      } catch (err) {
        if (ctx.signal?.aborted) throw new AppError(499, 'CANCELLED', 'Analysis cancelled');
        logger?.warn?.('browser inspection failed', { err });
        unavailable.push(`Browser inspection failed: ${err.message.split('\n')[0].slice(0, 300)} — run "npm run doctor" to see why, or set BROWSER_EXECUTABLE_PATH to your Chrome/Edge.`);
        step(4, 64, 'Browser inspection failed — continuing with HTTP evidence only');
      }
    } else {
      unavailable.push(`Browser rendering unavailable: ${availability.reason}`);
      step(4, 64, `Skipping browser: ${availability.reason}`);
    }
  } else {
    unavailable.push('Browser rendering was disabled for this analysis.');
    step(4, 64, 'Browser rendering disabled by request');
  }
  const browserRan = Boolean(browser?.ok);
  throwIfAborted();

  step(5, 68, 'Matching deterministic signatures against headers, cookies, DOM and network');
  const ev = createEvidenceStore();
  const facts = buildFacts({ http, browser: browserRan ? browser : null, dns, tls });
  const technologies = detectTechnologies(facts, ev);
  const integrations = detectIntegrations(facts, ev);
  const traffic = summarizeTraffic(facts, integrations, ev);
  if (browserRan) traffic.websockets = browser.websockets;
  step(5, 74, `${technologies.length} technologies, ${integrations.length} third-party services, ${traffic.apiHosts.length} API host(s)`);

  step(6, 78, 'Evaluating transport, headers, cookies and content (passive)');
  const security = analyzeSecurity({ http, browser: browserRan ? browser : null, tls, upgrade, facts, ev });
  step(6, 80, `${security.summary.passes} passing checks · ${security.summary.concerns} observations`);

  step(7, 84, 'Synthesizing evidence-linked architecture graph');
  const graph = buildGraph({ technologies, integrations, traffic, security, http, browser: browserRan ? browser : { requests: [], cookies: [], websockets: [] }, tls, ev, browserRan });
  const graphCheck = graphSchema.safeParse(graph);
  if (!graphCheck.success) throw new AppError(500, 'GRAPH_INVALID', `Internal error: generated graph failed validation (${graphCheck.error.issues[0]?.message}).`);
  step(7, 88, `${graph.nodes.length} nodes · ${graph.edges.length} relationships`);

  const projectId = newId('prj');
  const analysis = {
    id: projectId,
    createdAt: new Date().toISOString(),
    url,
    finalUrl: http.finalUrl,
    site: { host: finalUrl.hostname, domain: registrableDomain(finalUrl.hostname), requestedHost: target.host },
    http: { status: http.status, statusText: http.statusText, headers: http.headers, cookies: http.cookies, redirects: http.redirects, contentType: http.contentType, htmlBytes: http.htmlBytes, htmlTruncated: http.htmlTruncated, timingMs: http.timingMs, htmlSample: http.html.slice(0, 4000) },
    tls, dns, upgrade, robots,
    browser: browser ? { ok: browser.ok, error: browser.error, launchMode: browser.launchMode, finalUrl: browser.finalUrl, timingMs: browser.timingMs, dom: browser.dom, requests: browser.requests, websockets: browser.websockets, cookies: browser.cookies, consoleErrorCount: browser.consoleErrorCount, limits: browser.limits } : null,
    technologies, integrations, traffic, security, graph,
    evidence: ev.list(),
    unavailable,
    limits: { maxBrowserRequests: policy.maxBrowserRequests, maxHtmlBytes: policy.maxHtmlBytes, maxRedirects: policy.maxRedirects },
  };

  step(8, 92, 'Generating six-scene narration from the validated graph');
  const draft = generateScript(analysis, { targetDurationSec });
  const { script, llm } = await refineScriptWithLlm(analysis, draft, cfg.llm, { logger });
  const scriptCheck = scriptSchema.safeParse(script);
  if (!scriptCheck.success) throw new AppError(500, 'SCRIPT_INVALID', `Internal error: narration script failed validation (${scriptCheck.error.issues[0]?.path?.join('.')}: ${scriptCheck.error.issues[0]?.message}).`);
  analysis.script = script;
  analysis.llm = llm;
  step(8, 98, llm.used ? `Narration polished by ${llm.provider} and validated` : `Deterministic narration (${llm.error ? `LLM failed: ${llm.error}` : llm.reason})`);

  return { analysis, screenshot: browserRan ? browser.screenshot : null };
}
