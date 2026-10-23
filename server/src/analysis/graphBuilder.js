// Converts detections into an architecture graph. The graph only contains
// what the evidence supports. Where a layer cannot be observed, an explicit
// UNKNOWN node explains the gap instead of inventing infrastructure.

export const LAYERS = [
  { id: 'client', label: 'Browser & client' },
  { id: 'edge', label: 'CDN & edge' },
  { id: 'origin', label: 'Origin & hosting' },
  { id: 'frontend', label: 'Frontend' },
  { id: 'api', label: 'Public API layer' },
  { id: 'backend', label: 'Backend services' },
  { id: 'data', label: 'Data & storage' },
  { id: 'integrations', label: 'External integrations' },
  { id: 'security', label: 'Security boundaries' },
];

const FRONTEND_PRIMARY = ['nextjs', 'nuxt', 'gatsby', 'remix', 'react-router', 'sveltekit', 'astro', 'angular', 'angularjs', 'ember', 'qwik', 'wordpress', 'drupal', 'ghost', 'hugo', 'jekyll', 'docusaurus', 'react', 'vue', 'svelte', 'solid'];
const BAAS_OR_CMS = new Set(['Backend-as-a-service', 'Headless CMS']);

export function buildGraph({ technologies, integrations, traffic, security, http, browser, tls, ev, browserRan }) {
  const nodes = [];
  const edges = [];
  const byLayer = (layer) => technologies.filter(t => t.layer === layer);
  const addNode = (n) => { nodes.push({ limitations: [], technologies: [], details: {}, ...n }); return n.id; };
  const addEdge = (source, target, label, explanation, status = 'observed', evidenceIds = []) => {
    if (!nodes.some(n => n.id === source) || !nodes.some(n => n.id === target)) return;
    edges.push({ id: `e_${source}__${target}`, source, target, label, explanation, status, evidenceIds });
  };
  const host = new URL(http.finalUrl).hostname;
  const docEv = ev.add({ kind: 'redirect', source: 'http', label: 'Final document', value: `HTTP ${http.status} ${http.finalUrl}` });

  // ── Client ─────────────────────────────────────────────────────────────
  addNode({
    id: 'client', label: 'Visitor browser', layer: 'client', type: 'client', status: 'observed', confidence: 1,
    description: browserRan
      ? `StackReel loaded ${host} in a sandboxed headless Chromium and recorded ${traffic.totals.requests} network requests.`
      : `StackReel fetched ${host} with an HTTP client. Browser rendering was not available, so client-side behaviour was not observed.`,
    evidenceIds: [docEv],
    details: browserRan ? { 'Requests observed': traffic.totals.requests, 'DOM elements': browser.dom?.counts?.elements ?? '—', 'Load (DOMContentLoaded)': `${browser.timingMs.domContentLoaded} ms` } : {},
    limitations: browserRan ? ['One page load from one location; other pages and logged-in areas were not visited.'] : ['JavaScript was not executed.'],
  });

  // ── Edge chain ─────────────────────────────────────────────────────────
  const edgeTechs = byLayer('edge');
  let previous = 'client';
  for (const t of edgeTechs) {
    const id = `edge-${t.id}`;
    addNode({ id, label: t.name, layer: 'edge', type: 'edge', status: t.status, confidence: t.confidence, technologies: [t.id], evidenceIds: t.evidenceIds,
      description: `${t.category}. Identified from: ${t.rationale}.`,
      limitations: ['Cache rules, WAF configuration and POP selection are not visible from a single request.'] });
    addEdge(previous, id, previous === 'client' ? 'HTTPS request' : 'forwards', previous === 'client' ? 'The browser connects to this edge network first; response headers identify it.' : 'Response headers show both layers handled the request.', 'observed', t.evidenceIds.slice(0, 2));
    previous = id;
  }

  // ── Origin / hosting ───────────────────────────────────────────────────
  const originTechs = [...byLayer('origin'), ...byLayer('hosting')];
  const behindEdge = edgeTechs.length > 0;
  if (originTechs.length) {
    for (const t of originTechs) {
      const id = `origin-${t.id}`;
      addNode({ id, label: t.version ? `${t.name} ${t.version}` : t.name, layer: 'origin', type: t.layer === 'hosting' ? 'hosting' : 'server', status: t.status, confidence: t.confidence, technologies: [t.id], evidenceIds: t.evidenceIds,
        description: `${t.category}. Identified from: ${t.rationale}.`,
        limitations: behindEdge ? ['Behind an edge network, this header may come from an intermediate proxy rather than the application origin.'] : [] });
      addEdge(previous, id, behindEdge ? 'to origin' : 'HTTPS request', behindEdge ? 'Requests not served from cache travel from the edge to the origin.' : 'The browser connects directly to this server.', behindEdge ? 'inferred' : 'observed', t.evidenceIds.slice(0, 1));
    }
    previous = `origin-${originTechs[0].id}`;
  } else {
    addNode({ id: 'origin', label: behindEdge ? 'Origin server' : 'Web server', layer: 'origin', type: 'server', status: behindEdge ? 'inferred' : 'observed', confidence: behindEdge ? 0.7 : 0.9,
      description: behindEdge ? 'An edge network normally forwards cache misses to an origin. Its software and location were not disclosed.' : `A server answered with HTTP ${http.status}; it did not disclose its software.`,
      evidenceIds: [docEv], limitations: ['Server software, operating system and hosting provider are not identified by the available headers.'] });
    addEdge(previous, 'origin', behindEdge ? 'to origin' : 'HTTPS request', behindEdge ? 'Cache misses are typically forwarded to an origin server (inferred).' : 'The browser connected directly to this server.', behindEdge ? 'inferred' : 'observed', [docEv]);
    previous = 'origin';
  }
  const originId = previous;

  // ── Frontend ───────────────────────────────────────────────────────────
  const fe = byLayer('frontend');
  const primary = FRONTEND_PRIMARY.map(id => fe.find(t => t.id === id)).filter(Boolean).slice(0, 2);
  const supporting = fe.filter(t => !primary.includes(t));
  const feIds = [];
  for (const t of primary) {
    const id = `fe-${t.id}`;
    feIds.push(id);
    addNode({ id, label: t.version ? `${t.name} ${t.version}` : t.name, layer: 'frontend', type: 'frontend', status: t.status, confidence: t.confidence, technologies: [t.id], evidenceIds: t.evidenceIds,
      description: `${t.category}. ${t.rationale}.`, limitations: t.status === 'inferred' ? ['Implied by a related framework rather than seen directly.'] : [] });
  }
  if (!primary.length) {
    feIds.push('fe-document');
    addNode({ id: 'fe-document', label: 'HTML document', layer: 'frontend', type: 'frontend', status: 'observed', confidence: 0.9, evidenceIds: [docEv],
      description: browserRan ? `The page rendered ${browser.dom?.counts?.elements ?? 'an unknown number of'} DOM elements and ${browser.dom?.counts?.scripts ?? 0} external scripts. No known framework fingerprint matched.` : 'The HTML document was received; no framework fingerprint matched the static markup.',
      limitations: ['Frameworks that leave no global, attribute or asset-path fingerprint cannot be identified.'] });
  }
  if (supporting.length) {
    feIds.push('fe-libs');
    addNode({ id: 'fe-libs', label: 'UI libraries & tooling', layer: 'frontend', type: 'frontend', status: supporting.some(t => t.status === 'observed') ? 'observed' : 'inferred', confidence: Math.max(...supporting.map(t => t.confidence)),
      technologies: supporting.map(t => t.id), evidenceIds: supporting.flatMap(t => t.evidenceIds).slice(0, 8),
      description: supporting.map(t => `${t.name}${t.version ? ` ${t.version}` : ''} (${t.category})`).join(', ') + '.' });
  }
  for (const id of feIds) addEdge(originId, id, 'delivers', 'The server delivered the HTML/JavaScript that runs this frontend in the browser.', 'observed', [docEv]);
  const feMain = feIds[0];
  for (const a of traffic.firstPartyAssetHosts.slice(0, 2)) {
    const id = `assets-${a.host}`;
    addNode({ id, label: `Static assets · ${a.host}`, layer: 'edge', type: 'edge', status: 'observed', confidence: 0.95, evidenceIds: [a.evidenceId],
      description: `${a.count} request(s) for ${a.types.join(', ')} went to this first-party host.` });
    addEdge('client', id, 'asset fetch', 'The browser downloaded assets from this host.', 'observed', [a.evidenceId]);
  }

  // ── Public API ─────────────────────────────────────────────────────────
  const apiIds = [];
  for (const a of traffic.apiHosts.slice(0, 4)) {
    const id = `api-${a.host}`;
    apiIds.push({ id, firstParty: a.firstParty });
    const isGql = traffic.graphql?.host === a.host;
    addNode({ id, label: `${isGql ? 'GraphQL' : 'API'} · ${a.host}`, layer: 'api', type: 'api', status: 'observed', confidence: 0.95, evidenceIds: a.evidenceIds,
      description: `${a.count} ${a.methods.join('/')} call(s) observed${a.statuses.length ? ` (status ${a.statuses.slice(0, 4).join(', ')})` : ''}. Sample paths: ${a.samplePaths.join(', ')}.`,
      details: { 'First-party': a.firstParty ? 'yes' : 'no (third-party host)' },
      limitations: ['Only calls made during the initial page load are visible. Request/response bodies were not stored.'] });
    addEdge(feMain, id, 'fetch / XHR', 'The page issued these requests from JavaScript while loading.', 'observed', a.evidenceIds.slice(0, 2));
  }
  for (const t of byLayer('api')) {
    const id = `api-${t.id}`;
    apiIds.push({ id, firstParty: true });
    addNode({ id, label: t.name, layer: 'api', type: 'api', status: t.status, confidence: t.confidence, technologies: [t.id], evidenceIds: t.evidenceIds, description: `${t.category}. ${t.rationale}.` });
    addEdge(originId, id, 'routes via', 'Headers indicate this API gateway handled the response.', 'observed', t.evidenceIds);
  }
  if (browser?.websockets?.length) {
    const wsEv = browser.websockets.slice(0, 2).map(w => ev.add({ kind: 'network', source: 'browser', label: 'WebSocket connection', value: w.href }));
    addNode({ id: 'api-websocket', label: 'WebSocket channel', layer: 'api', type: 'api', status: 'observed', confidence: 0.95, evidenceIds: wsEv,
      description: `Real-time connection(s) opened to ${[...new Set(browser.websockets.map(w => w.host))].join(', ')}.` });
    apiIds.push({ id: 'api-websocket', firstParty: true });
    addEdge(feMain, 'api-websocket', 'WebSocket', 'The page opened a persistent bidirectional connection.', 'observed', wsEv);
  }
  if (!apiIds.length) {
    addNode({ id: 'api-unknown', label: browserRan ? 'No API calls observed' : 'API traffic not inspected', layer: 'api', type: 'unknown', status: 'unknown', confidence: 0,
      description: browserRan ? 'The page made no fetch/XHR calls during load. It may be static, server-rendered, or call APIs only after user interaction.' : 'Browser rendering was unavailable, so JavaScript-initiated requests could not be recorded.',
      evidenceIds: [], limitations: ['Absence of evidence during one page load is not evidence that no API exists.'] });
  }

  // ── Backend ────────────────────────────────────────────────────────────
  const backendTechs = byLayer('backend');
  const backendIds = [];
  for (const t of backendTechs) {
    const id = `be-${t.id}`;
    backendIds.push(id);
    addNode({ id, label: t.version ? `${t.name} ${t.version}` : t.name, layer: 'backend', type: 'backend', status: t.status, confidence: t.confidence, technologies: [t.id], evidenceIds: t.evidenceIds,
      description: `${t.category}. Identified from: ${t.rationale}.`, limitations: ['Headers and cookies can be set by proxies or left over from defaults; treat as strong hints, not proof of the whole backend.'] });
    addEdge(originId, id, 'serves via', 'A response header or cookie exposed this server-side technology.', 'observed', t.evidenceIds.slice(0, 1));
  }
  const firstPartyApis = apiIds.filter(a => a.firstParty);
  if (!backendIds.length && firstPartyApis.length) {
    backendIds.push('be-app');
    addNode({ id: 'be-app', label: 'Application backend', layer: 'backend', type: 'backend', status: 'inferred', confidence: 0.75,
      description: 'First-party API calls were answered, so some server-side application handles them. Its language, framework and topology are not visible.',
      evidenceIds: firstPartyApis.flatMap(a => nodes.find(n => n.id === a.id)?.evidenceIds || []).slice(0, 3),
      limitations: ['Implementation, number of services and internal routing are unknown.'] });
  }
  for (const a of firstPartyApis) for (const b of backendIds) addEdge(a.id, b, 'handled by', 'API responses imply server-side processing (inferred).', 'inferred', []);
  if (!backendIds.length) {
    backendIds.push('be-unknown');
    addNode({ id: 'be-unknown', label: 'Backend services', layer: 'backend', type: 'unknown', status: 'unknown', confidence: 0,
      description: 'No header, cookie or API traffic revealed server-side application technology. The site could be static or deliberately opaque.',
      evidenceIds: [], limitations: ['Backends behind a CDN are usually invisible to passive inspection.'] });
    addEdge(originId, 'be-unknown', '?', 'Whether a dynamic backend exists behind the origin is not established.', 'unknown', []);
  }

  // ── Data & storage ─────────────────────────────────────────────────────
  const dataIntegrations = integrations.filter(i => BAAS_OR_CMS.has(i.category));
  for (const i of dataIntegrations) {
    const id = `data-${i.id}`;
    addNode({ id, label: i.name, layer: 'data', type: 'data', status: 'observed', confidence: 0.9, evidenceIds: i.evidenceIds,
      description: `${i.category} contacted directly from the browser (${i.hosts.join(', ')}). This is a data/content service the site depends on.`,
      limitations: ['Schemas, access rules and stored data are not visible.'] });
    addEdge(feMain, id, 'reads/writes', 'The browser called this service directly.', 'observed', i.evidenceIds.slice(0, 1));
  }
  const sessionCookies = (browser?.cookies || []).concat(http.cookies).filter(c => /sess|auth|token|sid|jwt/i.test(c.name));
  if (backendIds[0] !== 'be-unknown') {
    addNode({ id: 'data-store', label: 'Persistent data store', layer: 'data', type: 'unknown', status: 'inferred', confidence: sessionCookies.length || firstPartyApis.length ? 0.45 : 0.3,
      description: 'Dynamic applications usually persist state somewhere. The engine (SQL, NoSQL, cache), location and schema cannot be determined from public traffic.',
      evidenceIds: [], limitations: ['Type of database: unknown.', 'Number of stores: unknown.', 'Hosting/provider: unknown.'] });
    for (const b of backendIds) addEdge(b, 'data-store', 'reads/writes?', 'Typical for dynamic backends; not observed.', 'inferred', []);
  } else if (!dataIntegrations.length) {
    addNode({ id: 'data-unknown', label: 'Data storage', layer: 'data', type: 'unknown', status: 'unknown', confidence: 0,
      description: 'Nothing observed indicates where or whether this site stores data.', evidenceIds: [], limitations: ['Not observable from a public page load.'] });
  }

  // ── Integrations (grouped by category) ─────────────────────────────────
  const groups = new Map();
  for (const i of integrations.filter(i => !BAAS_OR_CMS.has(i.category))) {
    const g = groups.get(i.category) || [];
    g.push(i);
    groups.set(i.category, g);
  }
  for (const [category, list] of [...groups.entries()].slice(0, 7)) {
    const id = `int-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    addNode({ id, label: list.length === 1 ? list[0].name : `${category} (${list.length})`, layer: 'integrations', type: 'integration', status: 'observed', confidence: 0.95,
      evidenceIds: list.flatMap(i => i.evidenceIds).slice(0, 6), technologies: list.map(i => i.id),
      description: `${category}: ${list.map(i => `${i.name} (${i.hosts.join(', ')})`).join('; ')}.`,
      limitations: ['What data is shared with the provider is not visible from network metadata alone.'] });
    addEdge(feMain, id, 'loads / beacons', 'The page loaded scripts from or sent requests to this provider.', 'observed', list[0].evidenceIds.slice(0, 1));
  }
  if (traffic.unattributedThirdParty.length) {
    const top = traffic.unattributedThirdParty.slice(0, 6);
    const otherEv = top.slice(0, 3).map(t => ev.add({ kind: 'request', source: 'browser', label: 'Unattributed third-party host', value: `${t.host} (${t.count} request(s): ${t.types.join(', ')})` }));
    addNode({ id: 'int-other', label: `Other third-party hosts (${traffic.unattributedThirdParty.length})`, layer: 'integrations', type: 'integration', status: 'observed', confidence: 0.9, evidenceIds: otherEv,
      description: `Requests went to hosts StackReel does not have a signature for: ${top.map(t => t.host).join(', ')}${traffic.unattributedThirdParty.length > 6 ? ', …' : ''}.` });
    addEdge(feMain, 'int-other', 'requests', 'Observed network requests to these hosts.', 'observed', otherEv);
  }

  // ── Security boundaries ────────────────────────────────────────────────
  if (tls && !tls.error) {
    const tlsEv = ev.add({ kind: 'tls', source: 'tls', label: 'Negotiated TLS session', value: `${tls.protocol} · ${tls.cipher}${tls.alpn ? ` · ALPN ${tls.alpn}` : ''}` });
    addNode({ id: 'sec-tls', label: `TLS termination (${tls.protocol})`, layer: 'security', type: 'security', status: 'observed', confidence: 0.95, evidenceIds: [tlsEv],
      description: `Encrypted connection negotiated with ${tls.cipher}${tls.certificate ? `; certificate for ${tls.certificate.subject} issued by ${tls.certificate.issuer}` : ''}. TLS terminates at ${behindEdge ? 'the edge network' : 'the responding server'}.`,
      details: tls.certificate ? { 'Valid until': tls.certificate.validTo, 'HTTP/2 (ALPN)': tls.alpn === 'h2' ? 'yes' : 'no' } : {} });
    addEdge('client', 'sec-tls', 'encrypts', 'All traffic between the browser and the first hop is encrypted.', 'observed', [tlsEv]);
  }
  const concerns = security.findings.filter(f => f.status === 'concern' && f.category === 'Headers');
  const passes = security.findings.filter(f => f.status === 'pass' && f.category === 'Headers');
  addNode({ id: 'sec-headers', label: 'Browser security policy', layer: 'security', type: 'security', status: 'observed', confidence: 0.95,
    evidenceIds: security.findings.filter(f => f.category === 'Headers').flatMap(f => f.evidenceIds).slice(0, 8),
    description: `Security headers on the document: ${passes.length} in place, ${concerns.length} hardening observation(s). See the Security tab for each item.`,
    details: { HSTS: http.headers['strict-transport-security'] ? 'present' : 'absent', CSP: http.headers['content-security-policy'] ? 'present' : 'absent' } });
  addEdge(originId, 'sec-headers', 'sets policy', 'Response headers instruct the browser how to restrict the page.', 'observed', []);

  return { layers: LAYERS.filter(l => nodes.some(n => n.layer === l.id)), nodes, edges };
}
