import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed } from '../src/analysis/robots.js';
import { createEvidenceStore } from '../src/analysis/evidence.js';
import { buildFacts, detectTechnologies, detectIntegrations, summarizeTraffic, registrableDomain } from '../src/analysis/detector.js';
import { analyzeSecurity } from '../src/analysis/securityFindings.js';
import { buildGraph } from '../src/analysis/graphBuilder.js';
import { parseSetCookies } from '../src/analysis/httpInspector.js';
import { generateScript, speakable } from '../src/narration/scriptGenerator.js';
import { graphSchema, scriptSchema } from '../src/narration/schema.js';
import { refineScriptWithLlm, findUnsupportedMentions } from '../src/narration/llm.js';
import { buildTimeline, chunkCaptions, toVtt, toSrt } from '../../shared/scene/timeline.js';
import { verifyProbe, computePeaks, writeWavPcm, readWavPcm } from '../src/render/media.js';

test('robots.txt: longest match wins, agent-specific groups override *', () => {
  const g = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: StackReelInspector\nDisallow: /no-bots\n');
  assert.equal(isAllowed(g, 'StackReelInspector', '/private'), true); // specific group applies instead of *
  assert.equal(isAllowed(g, 'StackReelInspector', '/no-bots/x'), false);
  assert.equal(isAllowed(g, 'other', '/private/x'), false);
  assert.equal(isAllowed(g, 'other', '/private/ok/1'), true);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:\n'), 'x', '/'), true);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /*.pdf$\n'), 'x', '/a.pdf'), false);
});

test('Set-Cookie parsing keeps names and flags but never values', () => {
  const [c] = parseSetCookies(['sid=SECRET123; Path=/; Secure; HttpOnly; SameSite=strict']);
  assert.deepEqual({ name: c.name, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite }, { name: 'sid', secure: true, httpOnly: true, sameSite: 'Strict' });
  assert.equal(JSON.stringify(c).includes('SECRET123'), false);
});

test('registrable domain handles multi-part TLDs', () => {
  assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('api.stripe.com'), 'stripe.com');
});

function synthetic({ headers = {}, html = '', requests = [], fingerprints = {}, cookies = [] } = {}) {
  const http = { finalUrl: 'https://shop.example.com/', status: 200, statusText: 'OK', headers, html, cookies, redirects: [], timingMs: { total: 120 } };
  const browser = { ok: true, finalUrl: http.finalUrl, requests, cookies: [], websockets: [], timingMs: { domContentLoaded: 300 }, dom: { title: 'Shop', counts: { elements: 100, scripts: 2, stylesheets: 1, iframes: 0, forms: 0 }, scriptSrcs: [], fingerprints } };
  const ev = createEvidenceStore();
  const facts = buildFacts({ http, browser, dns: { cname: [], a: [], aaaa: [], ns: [] }, tls: null });
  const technologies = detectTechnologies(facts, ev);
  const integrations = detectIntegrations(facts, ev);
  const traffic = summarizeTraffic(facts, integrations, ev);
  const security = analyzeSecurity({ http, browser, tls: null, upgrade: null, facts, ev });
  const graph = buildGraph({ technologies, integrations, traffic, security, http, browser, tls: null, ev, browserRan: true });
  return { http, browser, ev, technologies, integrations, traffic, security, graph, finalUrl: http.finalUrl, site: { host: 'shop.example.com' }, evidence: ev.list() };
}

test('detects technologies only with evidence and links every one to evidence items', () => {
  const a = synthetic({
    headers: { server: 'cloudflare', 'cf-ray': '8abc-IAD', 'x-powered-by': 'Next.js' },
    html: '<script src="/_next/static/chunks/main.js"></script>',
    fingerprints: { nextData: true, nextVersion: '14.2.0', reactRoot: true },
    requests: [{ href: 'https://www.googletagmanager.com/gtag/js', host: 'www.googletagmanager.com', type: 'script', method: 'GET', path: '/gtag/js' }],
  });
  const names = a.technologies.map(t => t.name);
  for (const n of ['Cloudflare', 'Next.js', 'React', 'Next.js server runtime']) assert.ok(names.includes(n), `missing ${n}`);
  assert.equal(a.technologies.find(t => t.id === 'nextjs').version, '14.2.0');
  const ids = new Set(a.evidence.map(e => e.id));
  for (const t of a.technologies) for (const id of t.evidenceIds) assert.ok(ids.has(id), `dangling evidence ${id}`);
  assert.ok(a.integrations.some(i => i.name === 'Google Analytics'));
});

test('a bare page produces UNKNOWN backend and data nodes rather than invented ones', () => {
  const a = synthetic({ headers: { 'content-type': 'text/html' }, html: '<html><body>hi</body></html>' });
  assert.equal(a.technologies.length, 0);
  const be = a.graph.nodes.find(n => n.layer === 'backend');
  assert.equal(be.status, 'unknown');
  assert.ok(!a.graph.nodes.some(n => n.layer === 'data' && n.status === 'observed'));
  assert.ok(a.graph.nodes.some(n => n.id === 'api-unknown'));
  assert.ok(graphSchema.safeParse(a.graph).success);
});

test('API traffic yields an INFERRED backend and never names a database engine', () => {
  const a = synthetic({ requests: [{ href: 'https://api.example.com/v1/cart', host: 'api.example.com', type: 'fetch', method: 'POST', path: '/v1/cart', status: 200, contentType: 'application/json' }] });
  assert.equal(a.graph.nodes.find(n => n.id === 'be-app').status, 'inferred');
  const data = a.graph.nodes.find(n => n.id === 'data-store');
  assert.equal(data.status, 'inferred');
  assert.doesNotMatch(JSON.stringify(a.graph), /postgres|mysql|mongo|redis|dynamo/i);
});

test('missing security headers are low/info hardening observations, never "vulnerabilities"', () => {
  const a = synthetic({ headers: {} });
  const missing = a.security.findings.filter(f => /^(hsts-missing|csp-missing|framing-missing)$/.test(f.id));
  assert.equal(missing.length, 3);
  for (const f of missing) assert.ok(['low', 'info'].includes(f.severity));
  assert.doesNotMatch(JSON.stringify(a.security.findings), /\bvulnerable\b/i);
  assert.match(a.security.disclaimer, /Passive observation only/);
});

test('script: six valid scenes, word budget scales with target duration, identifiers made speakable', () => {
  const a = synthetic({ headers: { server: 'nginx/1.25.3', 'x-powered-by': 'Express' }, fingerprints: { nextData: true } });
  const short = generateScript(a, { targetDurationSec: 90 });
  const long = generateScript(a, { targetDurationSec: 240 });
  assert.ok(scriptSchema.safeParse(short).success);
  const words = (s) => s.scenes.reduce((n, sc) => n + sc.narration.split(/\s+/).length, 0);
  assert.ok(words(long) > words(short), `${words(long)} should exceed ${words(short)}`);
  assert.ok(words(short) <= 260, `short script has ${words(short)} words`);
  assert.equal(speakable('__NEXT_DATA__ hydration payload'), 'NEXT DATA hydration payload');
  assert.doesNotMatch(short.scenes.map(s => s.narration).join(' '), /__/);
});

test('LLM refinement: success is validated; malformed, failing or hallucinating output falls back', async () => {
  const a = synthetic({ headers: { 'x-powered-by': 'Express' } });
  const draft = generateScript(a, { targetDurationSec: 120 });
  const cfg = { provider: 'anthropic', anthropicKey: 'test-key', anthropicModel: 'm', timeoutMs: 1000 };
  const reply = (scenes) => async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({ scenes }) }] }) });
  const good = draft.scenes.map(s => ({ key: s.key, subtitle: s.subtitle, narration: `Rewritten: ${s.narration}` }));
  const ok = await refineScriptWithLlm(a, draft, cfg, { fetchImpl: reply(good) });
  assert.equal(ok.llm.used, true);
  assert.match(ok.script.scenes[0].narration, /^Rewritten/);

  const hallucinated = good.map((s, i) => (i === 3 ? { ...s, narration: 'The backend stores orders in PostgreSQL on Kubernetes.' } : s));
  const bad = await refineScriptWithLlm(a, draft, cfg, { fetchImpl: reply(hallucinated) });
  assert.equal(bad.llm.used, false);
  assert.match(bad.llm.error, /unsupported technologies/);
  assert.equal(bad.script, draft);

  const malformed = await refineScriptWithLlm(a, draft, cfg, { fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ text: 'not json' }] }) }) });
  assert.equal(malformed.llm.used, false);
  const httpErr = await refineScriptWithLlm(a, draft, cfg, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'overloaded' } }) }) });
  assert.match(httpErr.llm.error, /500/);
  const noKey = await refineScriptWithLlm(a, draft, { ...cfg, anthropicKey: '' });
  assert.match(noKey.llm.reason, /ANTHROPIC_API_KEY/);
  assert.deepEqual(findUnsupportedMentions('Served by Express behind nginx', { technologies: [{ name: 'Express (Node.js)' }], integrations: [], graph: { nodes: [] } }), ['nginx']);
});

test('timeline: captions keep "Next.js" intact and VTT/SRT are well-formed', () => {
  assert.deepEqual(chunkCaptions('It uses Next.js 14.2.3 for rendering. Then it calls an API.'), ['It uses Next.js 14.2.3 for rendering.', 'Then it calls an API.']);
  const scenes = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, key: 'overview', title: `S${i}`, narration: 'One sentence here. Another sentence there.' }));
  const tl = buildTimeline(scenes, [3, 3, 3, 3, 3, 3]);
  assert.equal(tl.scenes.length, 6);
  assert.ok(tl.duration > 18 + 4.5 + 5.5);
  for (let i = 1; i < tl.captions.length; i += 1) assert.ok(tl.captions[i].start >= tl.captions[i - 1].end - 1e-6);
  assert.match(toVtt(tl.captions), /^WEBVTT\n\n1\n00:00:05\.\d{3} --> /);
  assert.match(toSrt(tl.captions), /^1\n00:00:05,\d{3} --> /);
});

test('media helpers: WAV round trip, peaks, and probe verification catches bad output', () => {
  const samples = new Int16Array(48000).map((_, i) => Math.round(Math.sin(i / 10) * 10000));
  const back = readWavPcm(writeWavPcm(samples));
  assert.equal(back.sampleRate, 48000);
  assert.equal(back.samples.length, samples.length);
  assert.equal(computePeaks(samples, 10).length, 10);
  const good = { durationSec: 60, sizeBytes: 5e6, video: { codec: 'h264', width: 1280, height: 720 }, audio: { codec: 'aac' } };
  assert.deepEqual(verifyProbe(good, { expectedDurationSec: 60.4, width: 1280, height: 720 }), []);
  assert.ok(verifyProbe({ ...good, audio: null }, { expectedDurationSec: 60, width: 1280, height: 720 }).includes('no audio stream'));
  assert.ok(verifyProbe({ ...good, durationSec: 20 }, { expectedDurationSec: 60, width: 1280, height: 720 }).some(p => /duration/.test(p)));
});
