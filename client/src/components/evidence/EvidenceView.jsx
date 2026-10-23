import { useMemo, useState } from 'react';
import { ProjectGate, ProjectHeader } from '../explorer/ExplorerView.jsx';
import { TypingTerminal } from '../common/ui.jsx';

function headerLines(project) {
  const h = project.http;
  return [`HTTP ${h.status} ${h.statusText || ''}  (${h.timingMs.total} ms from the StackReel server)`, ...Object.entries(h.headers).map(([k, v]) => `${k}: ${v}`)];
}

export default function EvidenceView() {
  const [tab, setTab] = useState('headers');
  return <ProjectGate>{(project) => <EvidenceContent project={project} tab={tab} setTab={setTab} />}</ProjectGate>;
}

function EvidenceContent({ project, tab, setTab }) {
  const [q, setQ] = useState('');
  const requests = project.browser?.requests || [];
  const tabs = useMemo(() => ({
    headers: { label: 'Response headers', lines: headerLines(project) },
    redirects: { label: 'Redirects & transport', lines: [
      `requested  ${project.url}`,
      ...project.http.redirects.map(r => `${r.status} → ${r.location}`),
      `final      ${project.finalUrl}`,
      project.tls && !project.tls.error ? `tls        ${project.tls.protocol} · ${project.tls.cipher} · ALPN ${project.tls.alpn || 'none'}` : `tls        ${project.tls?.error || 'not applicable (http)'}`,
      ...(project.tls?.certificate ? [`cert       CN=${project.tls.certificate.subject} · ${project.tls.certificate.issuer}`, `valid      ${project.tls.certificate.validFrom} → ${project.tls.certificate.validTo}`] : []),
      ...(project.upgrade ? [`http→https ${project.upgrade.error ? project.upgrade.error : project.upgrade.upgradesToHttps ? 'redirects to HTTPS' : `no upgrade (HTTP ${project.upgrade.status})`}`] : []),
      `robots.txt ${project.robots?.note || 'n/a'}`,
    ] },
    dns: { label: 'DNS', lines: [
      ...project.dns.cname.map(c => `CNAME  ${c}`), ...project.dns.a.map(a => `A      ${a}`), ...project.dns.aaaa.map(a => `AAAA   ${a}`), ...project.dns.ns.map(n => `NS     ${n}`),
    ] },
    cookies: { label: 'Cookies (names & flags only)', lines: [...new Map([...project.http.cookies, ...(project.browser?.cookies || [])].map(c => [c.name, c])).values()]
      .map(c => `${c.name.padEnd(28)} Secure=${c.secure ? 'yes' : 'no '} HttpOnly=${c.httpOnly ? 'yes' : 'no '} SameSite=${c.sameSite || 'unset'}  (${c.source})`) },
    dom: { label: 'Rendered DOM summary', lines: project.browser?.dom && !project.browser.dom.error ? [
      `title        ${project.browser.dom.title}`, `lang         ${project.browser.dom.lang || '—'}`, `generator    ${project.browser.dom.generator || '—'}`,
      ...Object.entries(project.browser.dom.counts).map(([k, v]) => `${k.padEnd(12)} ${v}`),
      ...Object.entries(project.browser.dom.fingerprints).filter(([, v]) => v).map(([k, v]) => `fingerprint  ${k} = ${v === true ? 'present' : v}`),
    ] : ['Browser rendering was not available for this analysis.'] },
  }), [project]);

  const current = tabs[tab];
  return (
    <div className="mx-auto max-w-6xl">
      <ProjectHeader project={project} />
      <p className="mb-4 max-w-3xl text-sm text-fg-muted">Raw observations exactly as collected. Cookie values, query-string values and request bodies are never stored — only names and attributes.</p>
      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist">
        {Object.entries(tabs).map(([k, t]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`chip ${tab === k ? '!border-accent/50 !text-fg' : ''}`}>{t.label}</button>
        ))}
        <button role="tab" aria-selected={tab === 'requests'} onClick={() => setTab('requests')} className={`chip ${tab === 'requests' ? '!border-accent/50 !text-fg' : ''}`}>Network requests ({requests.length})</button>
      </div>
      {tab !== 'requests'
        ? <TypingTerminal title={`${project.site.host} — ${current.label}`} lines={current.lines.length ? current.lines : ['(none observed)']} maxHeight="max-h-[560px]" />
        : (
          <div className="glass overflow-hidden rounded-2xl">
            <div className="border-b border-line p-3"><input className="input !py-2 text-sm" placeholder="Filter by host, path or type…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter requests" /></div>
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full min-w-[720px] text-left font-mono text-[11.5px]">
                <thead className="sticky top-0 bg-[var(--surface-solid)] text-fg-subtle"><tr><th className="p-2.5">method</th><th className="p-2.5">type</th><th className="p-2.5">status</th><th className="p-2.5">url (query values removed)</th></tr></thead>
                <tbody>
                  {requests.filter(r => !q || `${r.href} ${r.type}`.toLowerCase().includes(q.toLowerCase())).map((r, i) => (
                    <tr key={i} className="border-t border-line/60">
                      <td className="p-2.5">{r.method}</td><td className="p-2.5 text-fg-muted">{r.type}</td>
                      <td className={`p-2.5 ${r.blocked ? 'text-danger' : r.failed ? 'text-warn' : r.status >= 400 ? 'text-warn' : 'text-ok'}`}>{r.blocked ? 'blocked by StackReel' : r.failed ? 'failed' : r.status ?? '—'}</td>
                      <td className="break-all p-2.5">{r.href}{r.queryKeys?.length ? <span className="text-fg-subtle">?{r.queryKeys.join('&')}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!requests.length && <p className="p-6 text-center text-sm text-fg-subtle">No browser network data (HTTP-only analysis).</p>}
            </div>
          </div>
        )}
    </div>
  );
}
