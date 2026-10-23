// Runs deterministic signatures over the collected facts and returns
// technologies, observed API traffic and third-party integrations — each
// linked to the exact evidence items that justify it.
import { SIGNATURES, INTEGRATIONS } from './signatures.js';

const MULTI_PART_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'net.in', 'org.in', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.mx', 'co.nz', 'co.za', 'com.sg', 'com.cn', 'com.tr', 'co.kr', 'com.hk', 'com.tw']);

export function registrableDomain(host = '') {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_PART_TLDS.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/** Normalizes raw inspection output into the shape signatures expect. */
export function buildFacts({ http, browser, dns, tls }) {
  const dom = browser?.dom && !browser.dom.error ? browser.dom : null;
  // Requests StackReel's own policy refused are not evidence about the site's architecture.
  const requests = (browser?.requests || []).filter(r => !r.blocked);
  const scriptSrcs = [
    ...(dom?.scriptSrcs || []).map(s => s.src),
    ...[...(http?.html || '').matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]),
  ].slice(0, 200);
  const cookieMap = new Map();
  for (const c of [...(http?.cookies || []), ...(browser?.cookies || [])]) {
    if (!cookieMap.has(c.name)) cookieMap.set(c.name, c);
  }
  return {
    headers: http?.headers || {},
    html: http?.html || '',
    cookies: [...cookieMap.values()],
    fp: dom?.fingerprints || {},
    generator: dom?.generator || (http?.html?.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i) || [])[1] || null,
    scriptSrcs,
    domSource: dom ? 'browser' : 'http',
    requests,
    blockedRequests: (browser?.requests || []).filter(r => r.blocked),
    dns: dns || {},
    tls,
    siteHost: new URL(http?.finalUrl || browser?.finalUrl).hostname,
  };
}

function combine(weights) {
  return 1 - weights.reduce((acc, w) => acc * (1 - w), 1);
}

export function detectTechnologies(facts, ev) {
  const technologies = [];
  for (const sig of SIGNATURES) {
    const hits = [];
    for (const matcher of sig.match) {
      let hit = null;
      try { hit = matcher(facts); } catch { hit = null; }
      if (hit) hits.push(hit);
    }
    if (!hits.length) continue;
    const evidenceIds = hits.map(h => ev.add(h));
    const maxWeight = Math.max(...hits.map(h => h.weight));
    const version = hits.find(h => h.version)?.version || (sig.version ? sig.version(facts) : undefined) || null;
    technologies.push({
      id: sig.id,
      name: sig.name,
      category: sig.category,
      layer: sig.layer,
      version,
      status: maxWeight >= 0.8 ? 'observed' : 'inferred',
      confidence: Math.round(combine(hits.map(h => h.weight)) * 100) / 100,
      evidenceIds,
      rationale: hits.map(h => `${h.label}: ${h.value}`).join(' · ').slice(0, 400),
      signals: hits.slice(0, 4).map(h => ({ kind: h.kind, label: h.label, value: String(h.value).slice(0, 160) })),
    });
  }
  // A framework implies its UI library (Next.js → React) — mark as inferred when not directly seen.
  const has = (id) => technologies.some(t => t.id === id);
  const implies = [['nextjs', 'react', 'React', 'UI library'], ['gatsby', 'react', 'React', 'UI library'], ['remix', 'react', 'React', 'UI library'], ['nuxt', 'vue', 'Vue.js', 'UI framework'], ['sveltekit', 'svelte', 'Svelte', 'UI framework']];
  for (const [parent, child, name, category] of implies) {
    if (has(parent) && !has(child)) {
      const p = technologies.find(t => t.id === parent);
      technologies.push({ id: child, name, category, layer: 'frontend', version: null, status: 'inferred', confidence: 0.85, evidenceIds: p.evidenceIds, rationale: `${p.name} is built on ${name}`, signals: [{ kind: 'implied', label: `${p.name} is built on ${name}`, value: '' }] });
    }
  }
  return technologies;
}

export function detectIntegrations(facts, ev) {
  const found = new Map();
  const sources = [
    ...facts.requests.map(r => ({ href: r.href, host: r.host, kind: 'request', label: `Browser ${r.type} request` })),
    ...facts.scriptSrcs.map(s => { try { return { href: s, host: new URL(s, `https://${facts.siteHost}`).hostname, kind: 'script', label: 'Script source' }; } catch { return null; } }).filter(Boolean),
  ];
  for (const src of sources) {
    for (const [id, name, category, re] of INTEGRATIONS) {
      if (!re.test(src.href)) continue;
      const entry = found.get(id) || { id, name, category, layer: 'integration', status: 'observed', confidence: 0.95, hosts: new Set(), evidenceIds: [], requestCount: 0 };
      entry.hosts.add(src.host);
      entry.requestCount += src.kind === 'request' ? 1 : 0;
      if (entry.evidenceIds.length < 3) entry.evidenceIds.push(ev.add({ kind: src.kind, source: src.kind === 'request' ? 'browser' : facts.domSource, label: src.label, value: src.href }));
      found.set(id, entry);
      break;
    }
  }
  return [...found.values()].map(e => ({ ...e, hosts: [...e.hosts].slice(0, 6) }));
}

/** Groups first-party and unattributed third-party traffic observed in the browser. */
export function summarizeTraffic(facts, integrations, ev) {
  const site = registrableDomain(facts.siteHost);
  const integrationHosts = new Set(integrations.flatMap(i => i.hosts));
  const apiTypes = new Set(['xhr', 'fetch', 'eventsource']);
  const apiHosts = new Map();
  const thirdParty = new Map();
  const assetHosts = new Map();
  let graphql = null;

  for (const r of facts.requests) {
    if (!r.host) continue;
    const firstParty = registrableDomain(r.host) === site;
    const isApi = apiTypes.has(r.type) || (r.contentType && /json|graphql/i.test(r.contentType) && r.type !== 'document');
    if (isApi && /\/graphql\b/i.test(r.path) && !graphql) {
      graphql = { host: r.host, path: r.path, evidenceId: ev.add({ kind: 'request', source: 'browser', label: 'GraphQL endpoint request', value: `${r.method} ${r.href}` }) };
    }
    if (isApi && !integrationHosts.has(r.host)) {
      const entry = apiHosts.get(r.host) || { host: r.host, firstParty, count: 0, methods: new Set(), samplePaths: [], statuses: new Set(), evidenceIds: [] };
      entry.count += 1;
      entry.methods.add(r.method);
      if (r.status) entry.statuses.add(r.status);
      if (entry.samplePaths.length < 4 && !entry.samplePaths.includes(r.path)) entry.samplePaths.push(r.path);
      if (entry.evidenceIds.length < 3) entry.evidenceIds.push(ev.add({ kind: 'request', source: 'browser', label: `Observed ${r.type} call`, value: `${r.method} ${r.href}${r.status ? ` → ${r.status}` : ''}`, detail: r.contentType ? `content-type: ${r.contentType}` : undefined }));
      apiHosts.set(r.host, entry);
    } else if (!firstParty && !integrationHosts.has(r.host)) {
      const e = thirdParty.get(r.host) || { host: r.host, count: 0, types: new Set() };
      e.count += 1; e.types.add(r.type);
      thirdParty.set(r.host, e);
    } else if (firstParty && r.host !== facts.siteHost && r.type !== 'document') {
      const e = assetHosts.get(r.host) || { host: r.host, count: 0, types: new Set(), evidenceId: ev.add({ kind: 'request', source: 'browser', label: 'First-party asset host', value: r.href }) };
      e.count += 1; e.types.add(r.type);
      assetHosts.set(r.host, e);
    }
  }
  const fin = (m) => [...m.values()].map(e => ({ ...e, ...(e.methods ? { methods: [...e.methods] } : {}), ...(e.statuses ? { statuses: [...e.statuses] } : {}), ...(e.types ? { types: [...e.types] } : {}) }));
  return {
    siteDomain: site,
    apiHosts: fin(apiHosts).sort((a, b) => b.count - a.count).slice(0, 8),
    unattributedThirdParty: fin(thirdParty).sort((a, b) => b.count - a.count).slice(0, 25),
    firstPartyAssetHosts: fin(assetHosts).slice(0, 8),
    graphql,
    websockets: [],
    totals: {
      requests: facts.requests.length,
      firstParty: facts.requests.filter(r => registrableDomain(r.host) === site).length,
      thirdParty: facts.requests.filter(r => r.host && registrableDomain(r.host) !== site).length,
      thirdPartyHosts: new Set(facts.requests.filter(r => r.host && registrableDomain(r.host) !== site).map(r => r.host)).size,
    },
  };
}
