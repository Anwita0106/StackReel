import { registrableDomain } from './detector.js';

// Passive security-posture observations. Nothing here sends probes beyond
// the ordinary page load. A missing header is reported as a configuration
// observation with context — never as proof that the site is exploitable.

function parseHsts(value) {
  const maxAge = Number((value.match(/max-age=(\d+)/i) || [])[1] || 0);
  return { maxAge, includeSubDomains: /includesubdomains/i.test(value), preload: /preload/i.test(value) };
}

export function analyzeSecurity({ http, browser, tls, upgrade, facts, ev }) {
  const findings = [];
  const headers = http.headers;
  const isHttps = new URL(http.finalUrl).protocol === 'https:';
  const add = (f) => findings.push({ confidence: 'high', ...f });
  const hdrEv = (name) => ev.add({ kind: 'header', source: 'http', label: `Response header ${name}`, value: headers[name] });
  const absentEv = (name) => ev.add({ kind: 'header', source: 'http', label: `Response header ${name}`, value: '(not present in the final document response)' });

  // Transport
  if (!isHttps) {
    add({ id: 'transport-http', category: 'Transport', title: 'Page is served over plain HTTP', severity: 'high', status: 'concern',
      observation: `The final document was delivered from ${http.finalUrl} without TLS.`,
      evidenceIds: [ev.add({ kind: 'redirect', source: 'http', label: 'Final URL', value: http.finalUrl })],
      impact: 'Traffic can be read or modified by anyone on the network path.',
      remediation: 'Serve the site exclusively over HTTPS and redirect http:// requests to https://.' });
  } else {
    add({ id: 'transport-https', category: 'Transport', title: 'Document served over HTTPS', severity: 'info', status: 'pass',
      observation: 'The final document was delivered over TLS.',
      evidenceIds: [ev.add({ kind: 'redirect', source: 'http', label: 'Final URL', value: http.finalUrl })],
      impact: 'Protects confidentiality and integrity in transit.', remediation: 'None required.' });
  }
  if (tls && !tls.error) {
    const tlsEv = ev.add({ kind: 'tls', source: 'tls', label: 'Negotiated TLS session', value: `${tls.protocol} · ${tls.cipher}${tls.alpn ? ` · ALPN ${tls.alpn}` : ''}` });
    if (/TLSv1(\.1)?$/.test(tls.protocol || '')) {
      add({ id: 'tls-legacy', category: 'Transport', title: `Legacy TLS version negotiated (${tls.protocol})`, severity: 'high', status: 'concern',
        observation: `The server negotiated ${tls.protocol} with a modern client.`, evidenceIds: [tlsEv],
        impact: 'TLS 1.0/1.1 are deprecated and lack modern protections.', remediation: 'Disable TLS 1.0 and 1.1; prefer TLS 1.3 with TLS 1.2 as fallback.' });
    } else {
      add({ id: 'tls-modern', category: 'Transport', title: `Modern TLS negotiated (${tls.protocol})`, severity: 'info', status: 'pass',
        observation: `Negotiated ${tls.protocol} using ${tls.cipher}.`, evidenceIds: [tlsEv], impact: 'Current, supported protocol version.', remediation: 'None required.' });
    }
    if (tls.certificate?.validTo) {
      const days = Math.round((new Date(tls.certificate.validTo) - Date.now()) / 86_400_000);
      const certEv = ev.add({ kind: 'tls', source: 'tls', label: 'Certificate', value: `CN=${tls.certificate.subject} · issuer ${tls.certificate.issuer} · valid until ${tls.certificate.validTo}` });
      if (!tls.authorized) {
        add({ id: 'tls-untrusted', category: 'Transport', title: 'Certificate did not validate', severity: 'high', status: 'concern',
          observation: `Certificate validation failed: ${tls.authorizationError}.`, evidenceIds: [certEv],
          impact: 'Browsers will warn users; connections may be intercepted.', remediation: 'Install a certificate from a trusted CA that matches the hostname.' });
      } else if (days < 14) {
        add({ id: 'tls-expiring', category: 'Transport', title: `Certificate expires in ${days} days`, severity: 'medium', status: 'concern',
          observation: `The certificate's notAfter date is ${tls.certificate.validTo}.`, evidenceIds: [certEv],
          impact: 'An expired certificate makes the site unreachable for most users.', remediation: 'Renew the certificate and automate renewal.' });
      }
    }
  }
  if (upgrade && !upgrade.error) {
    const upEv = ev.add({ kind: 'redirect', source: 'http', label: 'http:// probe of the same host', value: `HTTP ${upgrade.status}${upgrade.location ? ` → ${upgrade.location}` : ''}` });
    add(upgrade.upgradesToHttps
      ? { id: 'http-upgrade', category: 'Transport', title: 'Plain HTTP redirects to HTTPS', severity: 'info', status: 'pass', observation: 'A request to http:// was redirected to https://.', evidenceIds: [upEv], impact: 'Users who type the bare domain land on the encrypted site.', remediation: 'None required.' }
      : { id: 'http-no-upgrade', category: 'Transport', title: 'Plain HTTP does not redirect to HTTPS', severity: 'medium', status: 'concern', observation: `http:// returned ${upgrade.status} without redirecting to https://.`, evidenceIds: [upEv], impact: 'Visitors arriving via http:// may stay on an unencrypted connection.', remediation: 'Return a 301/308 redirect from http:// to https:// for every path.' });
  }

  // HSTS
  if (isHttps) {
    if (headers['strict-transport-security']) {
      const h = parseHsts(headers['strict-transport-security']);
      const weak = h.maxAge < 15_552_000; // 180 days
      add({ id: 'hsts', category: 'Headers', title: weak ? 'HSTS max-age is short' : 'HSTS enabled', severity: weak ? 'low' : 'info', status: weak ? 'concern' : 'pass',
        observation: `Strict-Transport-Security max-age=${h.maxAge}${h.includeSubDomains ? ', includeSubDomains' : ''}${h.preload ? ', preload' : ''}.`,
        evidenceIds: [hdrEv('strict-transport-security')],
        impact: weak ? 'Browsers forget the HTTPS-only rule quickly, re-opening a downgrade window.' : 'Browsers will refuse plain-HTTP connections to this host.',
        remediation: weak ? 'Use max-age of at least 15552000 (180 days); 31536000 is common.' : 'None required.' });
    } else {
      add({ id: 'hsts-missing', category: 'Headers', title: 'No Strict-Transport-Security header', severity: 'low', status: 'concern',
        observation: 'The HTTPS response did not include HSTS.', evidenceIds: [absentEv('strict-transport-security')],
        impact: 'A first visit via http:// could be downgraded by an on-path attacker. This is a hardening gap, not a demonstrated vulnerability.',
        remediation: 'Add "Strict-Transport-Security: max-age=31536000; includeSubDomains" once HTTPS is used everywhere.' });
    }
  }

  // CSP
  const csp = headers['content-security-policy'];
  const cspRO = headers['content-security-policy-report-only'];
  if (csp) {
    const weaknesses = [];
    if (/script-src[^;]*'unsafe-inline'/i.test(csp) && !/script-src[^;]*('nonce-|'sha(256|384|512)-|'strict-dynamic')/i.test(csp)) weaknesses.push("script-src allows 'unsafe-inline'");
    if (/script-src[^;]*'unsafe-eval'/i.test(csp)) weaknesses.push("script-src allows 'unsafe-eval'");
    if (/(default|script)-src[^;]*\s\*(\s|;|$)/i.test(csp)) weaknesses.push('wildcard (*) script source');
    if (!/(default-src|script-src)/i.test(csp)) weaknesses.push('no script-src/default-src directive');
    add({ id: 'csp', category: 'Headers', title: weaknesses.length ? 'Content-Security-Policy present with permissive directives' : 'Content-Security-Policy present', severity: weaknesses.length ? 'low' : 'info', status: weaknesses.length ? 'concern' : 'pass',
      observation: weaknesses.length ? `CSP found; noted: ${weaknesses.join('; ')}.` : 'A CSP restricting script sources is set.', evidenceIds: [hdrEv('content-security-policy')],
      impact: weaknesses.length ? 'Permissive directives reduce how much the policy limits injected scripts.' : 'Limits the impact of HTML/script injection.',
      remediation: weaknesses.length ? "Prefer nonces or hashes over 'unsafe-inline', avoid 'unsafe-eval', and enumerate trusted sources." : 'None required.', confidence: 'medium' });
  } else {
    add({ id: 'csp-missing', category: 'Headers', title: cspRO ? 'CSP only in report-only mode' : 'No Content-Security-Policy header', severity: 'low', status: 'concern',
      observation: cspRO ? 'A Content-Security-Policy-Report-Only header is set, but nothing is enforced.' : 'No CSP was observed on the document response (a <meta> CSP may still exist).',
      evidenceIds: [cspRO ? hdrEv('content-security-policy-report-only') : absentEv('content-security-policy')],
      impact: 'Without an enforced CSP, any script-injection bug has a larger blast radius. Missing CSP alone is not an exploitable issue.',
      remediation: 'Introduce a CSP (start in report-only mode, then enforce) with nonce-based script-src.', confidence: 'medium' });
  }

  // Framing
  const xfo = headers['x-frame-options'];
  const frameAncestors = csp && /frame-ancestors/i.test(csp);
  add(xfo || frameAncestors
    ? { id: 'framing', category: 'Headers', title: 'Framing restricted', severity: 'info', status: 'pass', observation: xfo ? `X-Frame-Options: ${xfo}` : 'CSP frame-ancestors directive present.', evidenceIds: [xfo ? hdrEv('x-frame-options') : hdrEv('content-security-policy')], impact: 'Reduces clickjacking exposure.', remediation: 'None required.' }
    : { id: 'framing-missing', category: 'Headers', title: 'No anti-framing policy', severity: 'low', status: 'concern', observation: 'Neither X-Frame-Options nor CSP frame-ancestors was set.', evidenceIds: [absentEv('x-frame-options')], impact: 'Pages could be embedded by other sites (clickjacking), which matters most for pages with state-changing actions.', remediation: "Set CSP \"frame-ancestors 'self'\" (or X-Frame-Options: DENY/SAMEORIGIN).", confidence: 'medium' });

  // Other headers
  if ((headers['x-content-type-options'] || '').toLowerCase() !== 'nosniff') {
    add({ id: 'nosniff-missing', category: 'Headers', title: 'X-Content-Type-Options: nosniff not set', severity: 'info', status: 'concern', observation: 'MIME-type sniffing protection header was absent.', evidenceIds: [absentEv('x-content-type-options')], impact: 'Minor hardening gap; browsers may sniff content types in edge cases.', remediation: 'Add "X-Content-Type-Options: nosniff".' });
  }
  if (!headers['referrer-policy']) {
    add({ id: 'referrer-missing', category: 'Headers', title: 'No Referrer-Policy header', severity: 'info', status: 'concern', observation: 'Browsers fall back to their default (usually strict-origin-when-cross-origin).', evidenceIds: [absentEv('referrer-policy')], impact: 'Low; modern browser defaults already trim referrers.', remediation: 'Set "Referrer-Policy: strict-origin-when-cross-origin" explicitly.' });
  }
  if (headers['access-control-allow-origin'] === '*') {
    add({ id: 'cors-wildcard', category: 'Headers', title: 'Document allows any origin (ACAO: *)', severity: 'info', status: 'concern', observation: 'The HTML response carries Access-Control-Allow-Origin: *.', evidenceIds: [hdrEv('access-control-allow-origin')], impact: 'Usually harmless for public content; it cannot be combined with credentials.', remediation: 'Only send CORS headers on endpoints that need cross-origin reads.', confidence: 'medium' });
  }
  const disclosure = [['server', /\d/], ['x-powered-by', /./], ['x-aspnet-version', /./]].filter(([n, re]) => headers[n] && re.test(headers[n]));
  if (disclosure.length) {
    add({ id: 'version-disclosure', category: 'Headers', title: 'Software/version details disclosed in headers', severity: 'info', status: 'concern', observation: disclosure.map(([n]) => `${n}: ${headers[n]}`).join(' · '), evidenceIds: disclosure.map(([n]) => hdrEv(n)), impact: 'Helps fingerprinting; not a vulnerability by itself.', remediation: 'Remove or genericize X-Powered-By and version numbers in Server.' });
  }

  // Cookies (names and attributes only — values are never stored)
  const cookies = facts.cookies;
  if (cookies.length) {
    const insecure = isHttps ? cookies.filter(c => !c.secure) : [];
    const noSameSite = cookies.filter(c => !c.sameSite || c.sameSite === 'None' && !c.secure);
    const sessionLike = cookies.filter(c => /sess|auth|token|sid|jwt|login/i.test(c.name));
    const sessionNoHttpOnly = sessionLike.filter(c => !c.httpOnly);
    const cookieEv = cookies.slice(0, 6).map(c => ev.add({ kind: 'cookie', source: c.source, label: `Cookie ${c.name}`, value: `Secure=${c.secure} HttpOnly=${c.httpOnly} SameSite=${c.sameSite || 'unset'}` }));
    if (insecure.length) add({ id: 'cookie-secure', category: 'Cookies', title: `${insecure.length} cookie(s) without the Secure flag`, severity: 'low', status: 'concern', observation: `Cookies without Secure: ${insecure.slice(0, 6).map(c => c.name).join(', ')}.`, evidenceIds: cookieEv, impact: 'These cookies may be sent over unencrypted connections if one is ever made.', remediation: 'Set the Secure attribute on every cookie served over HTTPS.' });
    if (sessionNoHttpOnly.length) add({ id: 'cookie-httponly', category: 'Cookies', title: 'Session-like cookie readable by JavaScript', severity: 'medium', status: 'concern', confidence: 'medium', observation: `Cookies whose names suggest session use lack HttpOnly: ${sessionNoHttpOnly.map(c => c.name).join(', ')}.`, evidenceIds: cookieEv, impact: 'If these hold session credentials, an XSS bug could read them. The name is only a hint — StackReel cannot see what the cookie contains.', remediation: 'Mark authentication/session cookies HttpOnly.' });
    if (noSameSite.length) add({ id: 'cookie-samesite', category: 'Cookies', title: `${noSameSite.length} cookie(s) without an explicit SameSite policy`, severity: 'info', status: 'concern', observation: `Without SameSite (or SameSite=None without Secure): ${noSameSite.slice(0, 6).map(c => c.name).join(', ')}.`, evidenceIds: cookieEv, impact: 'Browsers default to Lax, so impact is usually low.', remediation: 'Set SameSite=Lax or Strict explicitly on first-party cookies.' });
    if (!insecure.length && !sessionNoHttpOnly.length) add({ id: 'cookie-ok', category: 'Cookies', title: 'Observed cookies use secure attributes', severity: 'info', status: 'pass', observation: `${cookies.length} cookie(s) observed; none flagged for missing Secure or HttpOnly on session-like names.`, evidenceIds: cookieEv, impact: 'Good cookie hygiene.', remediation: 'None required.' });
  }

  // Mixed content & third-party scripts (requires browser evidence)
  if (facts.blockedRequests?.length) {
    const targets = [...new Set(facts.blockedRequests.map(r => r.host))];
    add({ id: 'internal-requests', category: 'Content', title: `Page tried to reach ${targets.length} non-public destination(s)`, severity: 'info', status: 'observation', confidence: 'high',
      observation: `StackReel's sandbox refused requests to: ${targets.slice(0, 5).join(', ')}. Pages sometimes reference internal or development hosts by mistake.`,
      evidenceIds: facts.blockedRequests.slice(0, 3).map(r => ev.add({ kind: 'request', source: 'browser', label: 'Blocked by StackReel egress policy', value: `${r.method} ${r.href}` })),
      impact: 'For real visitors these requests fail or reach their own local network; usually a leftover configuration reference.',
      remediation: 'Remove references to internal, localhost or metadata addresses from production pages.' });
  }
  if (facts.requests.length && isHttps) {
    const mixed = facts.requests.filter(r => r.protocol === 'http:');
    if (mixed.length) {
      add({ id: 'mixed-content', category: 'Content', title: `${mixed.length} insecure (http://) subresource request(s)`, severity: mixed.some(r => ['script', 'stylesheet', 'xhr', 'fetch'].includes(r.type)) ? 'medium' : 'low', status: 'concern',
        observation: `Examples: ${mixed.slice(0, 3).map(r => r.href).join(', ')}.`, evidenceIds: mixed.slice(0, 3).map(r => ev.add({ kind: 'request', source: 'browser', label: `Mixed-content ${r.type} request`, value: r.href })),
        impact: 'Active mixed content (scripts) is blocked by browsers; passive content can be tampered with in transit.', remediation: 'Load every subresource over https://.' });
    }
    const site = registrableDomain(facts.siteHost);
    const thirdScripts = facts.requests.filter(r => r.type === 'script' && r.host && registrableDomain(r.host) !== site);
    const noSri = (browser.dom?.scriptSrcs || []).filter(s => { try { return registrableDomain(new URL(s.src).hostname) !== site && !s.integrity; } catch { return false; } });
    if (thirdScripts.length) {
      add({ id: 'third-party-scripts', category: 'Supply chain', title: `${new Set(thirdScripts.map(r => r.host)).size} third-party script host(s)`, severity: 'info', status: 'observation', confidence: 'high',
        observation: `Scripts loaded from: ${[...new Set(thirdScripts.map(r => r.host))].slice(0, 8).join(', ')}.${noSri.length ? ` ${noSri.length} statically referenced third-party script(s) have no Subresource Integrity attribute.` : ''}`,
        evidenceIds: thirdScripts.slice(0, 4).map(r => ev.add({ kind: 'request', source: 'browser', label: 'Third-party script', value: r.href })),
        impact: 'Each third-party script runs with full page privileges; a compromise of that provider affects this site.',
        remediation: 'Review third-party scripts periodically; use SRI for static library URLs and a CSP allow-list.' });
    }
  }

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => (a.status === 'pass') - (b.status === 'pass') || order[a.severity] - order[b.severity]);
  return {
    mode: 'passive',
    disclaimer: 'Passive observation only: StackReel loaded the public page once and read what any browser receives. No vulnerability probing, credential testing, fuzzing or exploitation was performed. A missing header is a hardening observation, not proof that the site is exploitable.',
    findings,
    summary: {
      concerns: findings.filter(f => f.status === 'concern').length,
      passes: findings.filter(f => f.status === 'pass').length,
      bySeverity: Object.fromEntries(['high', 'medium', 'low', 'info'].map(s => [s, findings.filter(f => f.status === 'concern' && f.severity === s).length])),
    },
  };
}
