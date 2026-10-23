import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ShieldCheck, ShieldAlert, Info, ChevronDown, Lock } from 'lucide-react';
import { ProjectGate, ProjectHeader } from '../explorer/ExplorerView.jsx';

const SEV = {
  high: 'text-danger border-danger/35 bg-danger/10',
  medium: 'text-warn border-warn/35 bg-warn/10',
  low: 'text-info border-info/35 bg-info/10',
  info: 'text-fg-muted border-line bg-surface-2',
};

function Finding({ f, evidence, index }) {
  const [open, setOpen] = useState(index < 2 && f.status === 'concern');
  const Icon = f.status === 'pass' ? ShieldCheck : f.status === 'concern' ? ShieldAlert : Info;
  return (
    <motion.li initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }} className="glass overflow-hidden rounded-2xl" data-testid="finding">
      <button className="flex w-full items-center gap-3 p-4 text-left" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Icon size={18} className={`shrink-0 ${f.status === 'pass' ? 'text-ok' : f.status === 'concern' ? (f.severity === 'high' ? 'text-danger' : f.severity === 'medium' ? 'text-warn' : 'text-info') : 'text-fg-muted'}`} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{f.title}</div>
          <div className="text-xs text-fg-subtle">{f.category} · confidence {f.confidence}</div>
        </div>
        {f.status === 'pass' ? <span className="chip text-ok">pass</span> : <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${SEV[f.severity]}`}>{f.severity}</span>}
        <ChevronDown size={16} className={`shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="grid gap-4 border-t border-line p-4 text-sm md:grid-cols-2">
          <div><div className="mb-1 text-xs font-semibold text-fg-subtle">Observation</div><p className="text-fg-muted">{f.observation}</p></div>
          <div><div className="mb-1 text-xs font-semibold text-fg-subtle">Potential impact</div><p className="text-fg-muted">{f.impact}</p></div>
          <div className="md:col-span-2"><div className="mb-1 text-xs font-semibold text-fg-subtle">Recommended remediation</div><p>{f.remediation}</p></div>
          <div className="md:col-span-2">
            <div className="mb-1.5 text-xs font-semibold text-fg-subtle">Evidence</div>
            <ul className="space-y-1.5">{f.evidenceIds.map(id => evidence.get(id)).filter(Boolean).map(ev => (
              <li key={ev.id} className="rounded-lg bg-inset px-3 py-2 font-mono text-[11.5px]"><span className="text-fg-subtle">{ev.label}: </span><span className="break-all">{ev.value}</span></li>
            ))}</ul>
          </div>
        </div>
      )}
    </motion.li>
  );
}

export default function SecurityView() {
  const [filter, setFilter] = useState('all');
  return (
    <ProjectGate>
      {(project) => <SecurityContent project={project} filter={filter} setFilter={setFilter} />}
    </ProjectGate>
  );
}

function SecurityContent({ project, filter, setFilter }) {
  const evidence = useMemo(() => new Map(project.evidence.map(e => [e.id, e])), [project]);
  const { findings, summary, disclaimer } = project.security;
  const list = findings.filter(f => filter === 'all' || (filter === 'pass' ? f.status === 'pass' : f.status !== 'pass' && (filter === 'concern' || f.severity === filter)));
  const tls = project.tls && !project.tls.error ? project.tls : null;
  return (
    <div className="mx-auto max-w-5xl">
      <ProjectHeader project={project} />
      <div className="glass mb-5 flex items-start gap-3 rounded-2xl p-4 text-sm" role="note">
        <Info size={18} className="mt-0.5 shrink-0 text-info" />
        <p className="text-fg-muted">{disclaimer}</p>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="glass rounded-2xl p-4"><div className="font-display text-3xl font-bold text-ok">{summary.passes}</div><div className="text-xs text-fg-muted">Controls in place</div></div>
        <div className="glass rounded-2xl p-4"><div className="font-display text-3xl font-bold">{summary.concerns}</div><div className="text-xs text-fg-muted">Hardening observations</div></div>
        <div className="glass rounded-2xl p-4"><div className="flex gap-3 font-mono text-sm"><span className="text-danger">{summary.bySeverity.high} high</span><span className="text-warn">{summary.bySeverity.medium} med</span><span className="text-info">{summary.bySeverity.low} low</span></div><div className="mt-2 text-xs text-fg-muted">By severity (no aggregate score — it would be misleading)</div></div>
        <div className="glass rounded-2xl p-4">
          <div className="flex items-center gap-2 font-semibold"><Lock size={15} className={tls ? 'text-ok' : 'text-fg-subtle'} />{tls ? tls.protocol : 'No TLS data'}</div>
          <div className="mt-1 truncate text-xs text-fg-muted">{tls ? `${tls.cipher}${tls.certificate ? ` · ${tls.certificate.issuer}` : ''}` : project.finalUrl.startsWith('http:') ? 'Served over plain HTTP' : project.tls?.error}</div>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter findings">
        {[['all', 'All'], ['concern', 'Observations'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['pass', 'Passing']].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} className={`chip ${filter === k ? '!border-accent/50 !text-fg' : ''}`}>{l}</button>
        ))}
      </div>
      <ul className="space-y-3">{list.map((f, i) => <Finding key={f.id} f={f} evidence={evidence} index={i} />)}</ul>
      {!list.length && <p className="py-10 text-center text-sm text-fg-subtle">No findings in this category.</p>}
    </div>
  );
}
