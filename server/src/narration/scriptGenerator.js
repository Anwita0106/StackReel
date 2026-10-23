// Deterministic six-scene script built only from the validated analysis.
// Sentences are prioritized; lower-priority explanatory sentences are only
// added while the scene is under its word budget (derived from the target
// video duration at ~150 spoken words per minute).

// Calibrated against real TTS output (pauses included), so videos land near the target length.
const WPM = 120;

function list(items, max = 4) {
  const arr = items.slice(0, max);
  if (arr.length <= 1) return arr.join('');
  return `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
}
const words = (s) => s.split(/\s+/).filter(Boolean).length;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const speakHost = (h) => h.replace(/^www\./, '');

/** Turns a technology's strongest signal into a phrase that reads well aloud. */
export function spokenEvidence(t) {
  const s = t.signals?.[0];
  if (!s) return 'the collected evidence';
  const value = String(s.value).slice(0, 60);
  switch (s.kind) {
    case 'header': return `the ${s.label.replace('Response header ', '')} response header, which reads "${value}"`;
    case 'cookie': return `a cookie named ${value}`;
    case 'dom': return `${s.label} in the rendered page`;
    case 'html': return `${s.label.charAt(0).toLowerCase() + s.label.slice(1)} in the HTML`;
    case 'request': case 'script': { try { return `requests to ${new URL(s.value).hostname}`; } catch { return 'observed network requests'; } }
    case 'dns': return `a ${s.label.replace('DNS ', 'DNS ')} pointing to ${value}`;
    case 'meta': return `the page's generator tag, "${value}"`;
    default: return s.label;
  }
}

/** Makes identifiers pronounceable: "__NEXT_DATA__" → "NEXT DATA", "window.Shopify" → "Shopify". */
export function speakable(text) {
  return text
    .replace(/window\./g, '')
    .replace(/_\$HY/g, 'hydration marker')
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/_+/g, ' ')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/\s{2,}/g, ' ');
}

/**
 * Picks sentences by priority until the word budget is spent (the first
 * sentence is always kept), then returns them in their original order.
 */
function fill(sentences, budget) {
  const items = sentences.map((s, i) => (Array.isArray(s) && s[0] ? { text: speakable(s[0]), priority: s[1], i } : null)).filter(Boolean);
  const ranked = [...items].sort((a, b) => a.priority - b.priority || a.i - b.i);
  const keep = new Set();
  let count = 0;
  for (const it of ranked) {
    const n = words(it.text);
    // Always keep the opener; a slightly long second sentence is allowed so short scenes stay meaningful.
    // Priority 0 = essential (always kept); the opener is always kept too.
    if (it.priority === 0 || keep.size === 0 || count + n <= budget || (keep.size === 1 && count + n <= budget * 1.4)) { keep.add(it.i); count += n; }
  }
  return items.filter(it => keep.has(it.i)).map(it => it.text).join(' ');
}

export function generateScript(analysis, { targetDurationSec = 180 } = {}) {
  const { site, technologies, integrations, traffic, security, graph, http, browser, tls } = analysis;
  const host = speakHost(site.host);
  // Speech time = target minus intro/outro and per-scene padding (see shared/scene/timeline.js).
  const speechSeconds = Math.max(40, targetDurationSec - 10 - 6 * 1.6);
  const budget = Math.max(22, Math.round((speechSeconds * WPM) / 60 / 6));
  const node = (id) => graph.nodes.find(n => n.id === id);
  const nodesIn = (layer) => graph.nodes.filter(n => n.layer === layer);
  const techName = (t) => (t.version ? `${t.name} ${t.version}` : t.name);
  const observed = technologies.filter(t => t.status === 'observed');
  const edge = technologies.filter(t => t.layer === 'edge');
  const fe = technologies.filter(t => t.layer === 'frontend');
  const be = technologies.filter(t => t.layer === 'backend');
  const browserRan = Boolean(browser?.ok);
  const counts = {
    observed: graph.nodes.filter(n => n.status === 'observed').length,
    inferred: graph.nodes.filter(n => n.status === 'inferred').length,
    unknown: graph.nodes.filter(n => n.status === 'unknown').length,
  };
  const headerLines = ['server', 'via', 'cf-ray', 'x-vercel-id', 'x-amz-cf-pop', 'x-served-by', 'x-powered-by', 'content-type', 'cache-control', 'strict-transport-security', 'content-security-policy', 'x-frame-options']
    .filter(h => http.headers[h]).slice(0, 8).map(h => `${h}: ${http.headers[h]}`.slice(0, 150));

  // ── Scene 1: overview ──────────────────────────────────────────────────
  const s1 = {
    id: 1, key: 'overview', title: `Inside ${host}`,
    subtitle: `${plural(observed.length, 'technology', 'technologies')} observed · ${plural(graph.nodes.length, 'component')} mapped`,
    narration: fill([
      [`This is a technical breakdown of ${host}, reconstructed from what its public website reveals.`, 1],
      [`StackReel ${browserRan ? 'loaded the homepage in a sandboxed browser' : 'requested the homepage over HTTP'} and received status ${http.status}${http.redirects.length ? ` after ${plural(http.redirects.length, 'redirect')}` : ''}.`, 2],
      [browser?.dom?.title ? `The page identifies itself as "${browser.dom.title.slice(0, 80)}".` : '', 2],
      [`From the response headers, the HTML${browserRan ? ', and every network request the page made' : ''}, we identified ${plural(observed.length, 'technology', 'technologies')} directly and mapped ${plural(graph.nodes.length, 'architectural component')}.`, 2],
      [`Observed means we saw direct evidence; inferred means the evidence makes it likely; unknown means the public surface does not say.`, 0],
      [`In total, ${counts.observed} components are observed, ${counts.inferred} are inferred, and ${counts.unknown} remain unknown.`, 2],
    ], budget),
    focusNodeIds: ['client', ...nodesIn('edge').map(n => n.id).slice(0, 2)],
    bullets: [
      { text: `Final URL: ${analysis.finalUrl}`.slice(0, 140), status: 'observed' },
      { text: `HTTP ${http.status} in ${http.timingMs.total} ms from the StackReel server`, status: 'observed' },
      { text: `${counts.observed} observed · ${counts.inferred} inferred · ${counts.unknown} unknown`, status: 'observed' },
    ],
    panel: { title: 'Response headers (observed)', lines: headerLines.length ? headerLines : ['(no identifying headers returned)'] },
    snippet: { title: 'Equivalent request', language: 'bash', code: `curl -sI ${analysis.finalUrl}\n# HTTP ${http.status}${http.statusText ? ' ' + http.statusText : ''}\n${headerLines.slice(0, 5).map(l => '# ' + l).join('\n')}`, illustrative: false },
  };

  // ── Scene 2: frontend ──────────────────────────────────────────────────
  const primaryFe = fe.filter(t => !['tailwind', 'bootstrap', 'webpack', 'jquery', 'alpine', 'htmx'].includes(t.id));
  const supportFe = fe.filter(t => !primaryFe.includes(t));
  const dom = browser?.dom;
  const s2 = {
    id: 2, key: 'frontend', title: 'Frontend architecture',
    subtitle: primaryFe.length ? `${list(primaryFe.map(techName), 3)}${supportFe.length ? ` + ${supportFe.length} supporting` : ''}` : 'No framework fingerprint matched',
    narration: fill([
      primaryFe.length
        ? [`The user interface is built with ${list(primaryFe.map(t => `${techName(t)}${t.status === 'inferred' ? ', which is inferred' : ''}`), 3)}.`, 1]
        : [`No known frontend framework left a recognizable fingerprint, so the rendering approach is unknown. The page may be hand-written HTML, or a framework that leaves no global markers.`, 1],
      primaryFe[0] ? [`That identification rests on concrete evidence: ${spokenEvidence(primaryFe[0])}.`, 1] : '',
      supportFe.length ? [`Supporting tools include ${list(supportFe.map(techName), 4)}.`, 2] : '',
      dom ? [`Once rendered, the page contained ${dom.counts.elements.toLocaleString('en-US')} DOM elements, ${plural(dom.counts.scripts, 'external script')} and ${plural(dom.counts.stylesheets, 'stylesheet')}.`, 2] : '',
      fe.some(t => ['nextjs', 'nuxt', 'gatsby', 'remix', 'sveltekit', 'astro'].includes(t.id))
        ? [`Meta-frameworks like this typically render HTML on the server or at build time, then hydrate it in the browser so it becomes interactive.`, 3] : '',
      !browserRan ? [`Because browser rendering was unavailable, only the static HTML could be examined, so client-side frameworks may be missed.`, 1] : '',
      [`A frontend framework tells us how the page is assembled, but not what powers the servers behind it.`, 3],
    ], budget),
    focusNodeIds: nodesIn('frontend').map(n => n.id),
    bullets: [...primaryFe, ...supportFe].slice(0, 5).map(t => ({ text: `${techName(t)} — ${t.category}`, status: t.status })),
    panel: { title: 'Frontend evidence', lines: fe.slice(0, 7).map(t => `${t.status.toUpperCase().padEnd(8)} ${techName(t)} ← ${t.rationale.split(' · ')[0]}`.slice(0, 160)) },
    snippet: dom
      ? { title: 'Rendered document (observed)', language: 'json', illustrative: false, code: JSON.stringify({ title: dom.title?.slice(0, 60), lang: dom.lang, generator: dom.generator, counts: { elements: dom.counts.elements, scripts: dom.counts.scripts, stylesheets: dom.counts.stylesheets, iframes: dom.counts.iframes, forms: dom.counts.forms } }, null, 2) }
      : { title: 'Static HTML (observed)', language: 'html', illustrative: false, code: ((http.htmlSample || '').match(/<head[\s\S]{0,600}/i)?.[0] || (http.htmlSample || '(empty document)').slice(0, 600)).replace(/\s+\n/g, '\n').slice(0, 600) },
  };

  // ── Scene 3: request flow ──────────────────────────────────────────────
  const apis = traffic.apiHosts;
  const flowPath = [node('client'), ...nodesIn('edge').filter(n => !n.id.startsWith('assets-')), ...nodesIn('origin').slice(0, 1)].filter(Boolean);
  const sampleApi = apis[0];
  const s3 = {
    id: 3, key: 'request-flow', title: 'Browser-to-server request flow',
    subtitle: flowPath.map(n => n.label).join('  ›  ').slice(0, 160),
    narration: fill([
      [`Let's follow a request. The browser resolves ${host} and opens an encrypted connection${tls?.protocol ? ` using ${tls.protocol.replace('TLSv', 'TLS ')}` : ''}.`, 1],
      edge.length
        ? [`The first system to answer is ${list(edge.map(t => t.name), 2)}, identified from ${spokenEvidence(edge[0])}.`, 1]
        : [`No CDN or edge network identified itself, so the browser appears to talk to the web server directly, though an undisclosed proxy cannot be ruled out.`, 1],
      edge.length ? [`An edge network caches content close to visitors and forwards cache misses to an origin server, whose software is ${technologies.some(t => t.layer === 'origin' || t.layer === 'hosting') ? 'partly visible in the headers' : 'not disclosed'}.`, 2] : '',
      browserRan ? [`While loading, the page made ${plural(traffic.totals.requests, 'network request')}: ${traffic.totals.firstParty} to ${traffic.siteDomain} and ${traffic.totals.thirdParty} to ${plural(traffic.totals.thirdPartyHosts, 'third-party host')}.`, 1] : '',
      sampleApi ? [`JavaScript then called ${apis.length > 1 ? `${apis.length} API hosts, led by` : 'an API at'} ${sampleApi.host}, using ${list(sampleApi.methods, 3)} requests${traffic.graphql ? ', including GraphQL' : ''}.`, 1]
        : browserRan ? [`No API calls were observed during the initial load, which suggests the content arrives fully formed from the server, or that data is fetched only after user interaction.`, 1] : '',
      browser?.websockets?.length ? [`The page also opened a WebSocket for real-time updates.`, 2] : '',
      tls?.alpn === 'h2' ? [`The server negotiated HTTP/2, so many requests share a single connection.`, 3] : '',
    ], budget),
    focusNodeIds: [...flowPath.map(n => n.id), ...nodesIn('api').map(n => n.id)].slice(0, 8),
    bullets: [
      ...flowPath.map(n => ({ text: n.label, status: n.status })).slice(0, 3),
      ...(sampleApi ? [{ text: `${sampleApi.count} call(s) to ${sampleApi.host}`, status: 'observed' }] : []),
    ].slice(0, 5),
    panel: { title: 'Network activity (observed)', lines: browserRan
      ? [`requests  ${traffic.totals.requests}`, `1st-party ${traffic.totals.firstParty}`, `3rd-party ${traffic.totals.thirdParty} (${traffic.totals.thirdPartyHosts} hosts)`, ...apis.slice(0, 4).map(a => `API ${a.methods.join('/')} ${a.host}${a.samplePaths[0] || ''}`.slice(0, 160)), ...http.redirects.map(r => `redirect ${r.status} → ${r.location}`.slice(0, 160))].slice(0, 12)
      : ['Browser rendering unavailable — only the document request was observed.', ...http.redirects.map(r => `redirect ${r.status} → ${r.location}`.slice(0, 160))] },
    snippet: sampleApi
      ? { title: 'Reconstructed from an observed request', language: 'javascript', illustrative: true, code: `// Method, host and path observed; body and headers not recorded\nconst res = await fetch('https://${sampleApi.host}${sampleApi.samplePaths[0] || '/'}', {\n  method: '${sampleApi.methods[0]}',\n});\n// observed status: ${sampleApi.statuses[0] ?? 'n/a'}` }
      : { title: 'Document request (observed)', language: 'http', illustrative: false, code: `GET ${new URL(analysis.finalUrl).pathname} HTTP/1.1\nHost: ${site.host}\n\nHTTP/1.1 ${http.status}\n${headerLines.slice(0, 4).join('\n')}` },
  };

  // ── Scene 4: backend ───────────────────────────────────────────────────
  const dataNodes = nodesIn('data');
  const s4 = {
    id: 4, key: 'backend', title: 'Backend services & data handling',
    subtitle: be.length ? `Observed: ${list(be.map(techName), 3)}` : (node('be-app') ? 'Backend inferred from API traffic' : 'Backend not observable'),
    narration: fill([
      be.length
        ? [`On the server side, ${list(be.map(t => `${techName(t)}${t.status === 'inferred' ? ' (inferred)' : ''}`), 3)} revealed ${be.length > 1 ? 'themselves' : 'itself'} through ${spokenEvidence(be[0])}.`, 1]
        : node('be-app')
          ? [`The API responses prove that some server-side application exists, but it does not identify its language, framework or structure. We label it inferred.`, 1]
          : [`The backend is unknown. No response header, cookie or API call exposed server-side technology. That is common and often deliberate: a well-configured edge hides what sits behind it.`, 1],
      be.length ? [`Headers like these are strong hints, but they can be set by proxies or leftover defaults, so they describe part of the stack, not all of it.`, 2] : '',
      dataNodes.some(n => n.status === 'observed') ? [`The browser talks directly to ${list(dataNodes.filter(n => n.status === 'observed').map(n => n.label), 2)}, a hosted data or content service.`, 1] : '',
      dataNodes.some(n => n.id === 'data-store') ? [`A dynamic application almost certainly stores data somewhere, but the database engine, its schema and where it runs are not visible from outside, so the data layer remains unknown in its details.`, 1]
        : [`There is no public evidence of where, or whether, this site stores data.`, 1],
      [`StackReel deliberately does not guess database products or internal services. Anything not shown here simply could not be observed.`, 2],
    ], budget),
    focusNodeIds: [...nodesIn('backend'), ...dataNodes].map(n => n.id).slice(0, 6),
    bullets: [...nodesIn('backend'), ...dataNodes].slice(0, 5).map(n => ({ text: n.label, status: n.status })),
    panel: { title: 'Server-side signals', lines: be.length ? be.slice(0, 8).map(t => `${t.status.toUpperCase().padEnd(8)} ${techName(t)} ← ${t.rationale.split(' · ')[0]}`.slice(0, 160)) : ['No server-side technology disclosed.', 'Database engine: unknown', 'Internal services: unknown'] },
    snippet: { title: 'What is known about the data layer', language: 'yaml', illustrative: false, code: [`backend:`, ...(be.length ? be.slice(0, 4).map(t => `  - ${techName(t)}   # ${t.status}`) : [`  status: ${node('be-app') ? 'inferred (API traffic observed)' : 'unknown'}`]), `data_store:`, ...(dataNodes.filter(n => n.status === 'observed').map(n => `  - ${n.label}   # observed`)), `  engine: unknown`, `  schema: unknown`, `  location: unknown`].join('\n') },
  };

  // ── Scene 5: security ──────────────────────────────────────────────────
  const concerns = security.findings.filter(f => f.status === 'concern');
  const passes = security.findings.filter(f => f.status === 'pass');
  const s5 = {
    id: 5, key: 'security', title: 'Security observations & trust boundaries',
    subtitle: `${plural(passes.length, 'control')} in place · ${plural(concerns.length, 'hardening observation')}`,
    narration: fill([
      [`Now the security posture, observed passively. We only read what any visitor's browser receives, and we did not probe for vulnerabilities.`, 1],
      tls?.protocol ? [`Transport is encrypted with ${tls.protocol.replace('TLSv', 'TLS ')}${tls.certificate?.issuer ? `, using a certificate issued by ${tls.certificate.issuer.split(' — ')[0]}` : ''}.`, 1] : '',
      passes.length ? [`Controls in place include ${list(passes.slice(0, 4).map(f => f.title.toLowerCase()), 4)}.`, 1] : '',
      concerns.length ? [`We noted ${plural(concerns.length, 'hardening observation')}, most notably: ${list(concerns.slice(0, 3).map(f => f.title.toLowerCase()), 3)}.`, 1] : [`No hardening gaps were noted among the checks performed.`, 1],
      concerns.length ? [`These are configuration observations, not proof that the site can be attacked. A missing header raises risk only when combined with another flaw.`, 1] : '',
      traffic.totals.thirdPartyHosts ? [`The trust boundary also extends to ${plural(traffic.totals.thirdPartyHosts, 'third-party host')}, because every external script runs with the same privileges as the site's own code.`, 2] : '',
    ], budget),
    focusNodeIds: nodesIn('security').map(n => n.id),
    bullets: security.findings.filter(f => f.status !== 'observation').slice(0, 5).map(f => ({ text: `${f.status === 'pass' ? 'PASS' : f.severity.toUpperCase()} · ${f.title}`.slice(0, 140), status: 'observed' })),
    panel: { title: 'Passive checks', lines: security.findings.slice(0, 12).map(f => `${f.status === 'pass' ? '[PASS]' : f.status === 'concern' ? `[${f.severity.toUpperCase()}]` : '[NOTE]'} ${f.title}`.slice(0, 160)) },
    snippet: { title: 'Security-relevant headers (observed)', language: 'http', illustrative: false, code: ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'].map(h => `${h}: ${http.headers[h] ? http.headers[h].slice(0, 90) : '(absent)'}`).join('\n') },
  };

  // ── Scene 6: summary ───────────────────────────────────────────────────
  const unknownNodes = graph.nodes.filter(n => n.status === 'unknown');
  const hosting = technologies.filter(t => t.layer === 'hosting');
  const s6 = {
    id: 6, key: 'summary', title: 'Deployment, unknowns & summary',
    subtitle: `${counts.observed} observed · ${counts.inferred} inferred · ${counts.unknown} unknown`,
    narration: fill([
      hosting.length || edge.length
        ? [`On deployment, the evidence points to ${list([...hosting, ...edge].map(t => t.name), 3)}.`, 1]
        : [`No hosting provider or cloud platform identified itself, so the deployment environment is unknown.`, 1],
      [`To summarize: ${host} ${edge.length ? `sits behind ${edge[0].name}` : 'is served directly'}, ${primaryFe.length ? `renders its interface with ${techName(primaryFe[0])}` : 'uses an unidentified frontend'}, and ${apis.length ? `talks to ${plural(apis.length, 'API host')}` : 'made no API calls during load'}.`, 1],
      unknownNodes.length ? [`What remains unknown: ${list(unknownNodes.map(n => n.label.toLowerCase()), 3)}.`, 1] : '',
      integrations.length ? [`It also relies on ${plural(integrations.length, 'third-party service')}, including ${list(integrations.slice(0, 3).map(i => i.name), 3)}.`, 2] : '',
      [`Every component in this map links back to the evidence behind it, so you can check each claim in the StackReel explorer.`, 2],
      [`This was a passive, single-page view. Authenticated areas, internal networks and server code were never accessed.`, 1],
    ], budget),
    focusNodeIds: graph.nodes.map(n => n.id).slice(0, 12),
    bullets: [
      { text: `${counts.observed} observed components`, status: 'observed' },
      { text: `${counts.inferred} inferred components`, status: 'inferred' },
      { text: `${counts.unknown} unknown components`, status: 'unknown' },
    ],
    panel: { title: 'Limitations', lines: [
      'Single page load from one location',
      'No authentication, no active probing',
      browserRan ? `${traffic.totals.requests} requests observed (cap ${analysis.limits?.maxBrowserRequests ?? '—'})` : 'Browser evidence unavailable',
      ...unknownNodes.slice(0, 4).map(n => `UNKNOWN  ${n.label}`),
    ] },
    snippet: { title: 'Architecture summary (derived)', language: 'json', illustrative: false, code: JSON.stringify({
      site: host,
      edge: edge.map(t => t.name),
      frontend: primaryFe.map(techName),
      apiHosts: apis.map(a => a.host).slice(0, 3),
      backend: be.length ? be.map(techName) : (node('be-app') ? 'inferred' : 'unknown'),
      dataStore: 'unknown',
      integrations: integrations.length,
    }, null, 2) },
  };

  return { provider: 'deterministic', targetDurationSec, scenes: [s1, s2, s3, s4, s5, s6] };
}
