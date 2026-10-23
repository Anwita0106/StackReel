import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, useReactFlow, useNodesInitialized, getNodesBounds, getViewportForBounds } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { toPng } from 'html-to-image';
import { motion, AnimatePresence } from 'motion/react';
import { Globe, Shield, Server, Layers, Network, Cpu, Database, Puzzle, Lock, Search, Download, FileJson, Maximize2, X, ExternalLink, ArrowRight, Clapperboard, Info } from 'lucide-react';
import { LAYER_COLORS, LAYER_LABELS } from '@shared/graphLayout.js';
import { useApp, useRouteProject } from '../../context/AppContext.jsx';
import { useTheme } from '../../context/ThemeContext.jsx';
import { StatusBadge, ConfidenceBar, Legend, EmptyState, ErrorPanel, Skeleton } from '../common/ui.jsx';
import { timeAgo } from '../../lib/format.js';
import { toFlow, NODE_W, NODE_H } from './graphModel.js';

const ICONS = { client: Globe, edge: Shield, origin: Server, frontend: Layers, api: Network, backend: Cpu, data: Database, integrations: Puzzle, security: Lock };
const BORDER = { observed: 'solid', inferred: 'dashed', unknown: 'dotted' };

const ArchNode = memo(function ArchNode({ data, selected }) {
  const n = data.node;
  const Icon = ICONS[n.layer] || Layers;
  const color = LAYER_COLORS[n.layer];
  return (
    <div
      className={`group relative rounded-2xl px-3 py-2.5 transition-[opacity,transform,box-shadow] duration-200 ${data.dimmed ? 'opacity-25' : 'opacity-100'} ${selected ? 'scale-[1.04]' : 'hover:scale-[1.02]'}`}
      style={{
        width: NODE_W, height: NODE_H,
        background: 'var(--surface-solid)',
        border: `1.5px ${BORDER[n.status]} ${n.status === 'unknown' ? 'var(--unknown)' : color}`,
        boxShadow: selected ? `0 0 0 3px color-mix(in oklab, ${color} 35%, transparent), 0 16px 40px -16px ${color}` : data.highlighted ? `0 0 0 2px color-mix(in oklab, ${color} 25%, transparent)` : 'var(--shadow)',
      }}
      data-testid={`node-${n.id}`}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-transparent" />
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl" style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}>
          <Icon size={16} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`truncate text-[13px] font-semibold leading-tight ${n.status === 'unknown' ? 'text-fg-muted' : 'text-fg'}`} title={n.label}>{n.status === 'unknown' ? `? ${n.label}` : n.label}</div>
          <div className="mt-1 flex items-center gap-1.5"><StatusBadge status={n.status} size="xs" />{n.status !== 'unknown' && <span className="font-mono text-[10px] text-fg-subtle">{Math.round(n.confidence * 100)}%</span>}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-transparent" />
    </div>
  );
});

function Lane({ data }) {
  return (
    <div className="h-full w-full rounded-3xl border border-dashed" style={{ borderColor: `color-mix(in oklab, ${LAYER_COLORS[data.layer]} 25%, transparent)`, background: `color-mix(in oklab, ${LAYER_COLORS[data.layer]} 4%, transparent)` }}>
      <div className="px-3 pt-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: LAYER_COLORS[data.layer] }}>{data.label}</div>
    </div>
  );
}
function Band({ data }) {
  return (
    <div className="h-full w-full rounded-3xl border border-dashed" style={{ borderColor: `color-mix(in oklab, ${LAYER_COLORS[data.layer]} 25%, transparent)`, background: `color-mix(in oklab, ${LAYER_COLORS[data.layer]} 4%, transparent)` }}>
      <div className="px-4 pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: LAYER_COLORS[data.layer] }}>{data.label}</div>
    </div>
  );
}
const nodeTypes = { arch: ArchNode, lane: Lane, band: Band };

function download(name, href) {
  const a = document.createElement('a');
  a.href = href; a.download = name; a.click();
}

function EvidenceItem({ ev }) {
  if (!ev) return null;
  return (
    <li className="rounded-xl border border-line bg-inset p-2.5">
      <div className="flex items-center gap-2">
        <span className="chip !px-1.5 !py-0 font-mono !text-[10px] uppercase">{ev.kind}</span>
        <span className="truncate text-xs font-medium text-fg-muted">{ev.label}</span>
        <span className="ml-auto font-mono text-[10px] text-fg-subtle">{ev.source}</span>
      </div>
      <code className="mt-1.5 block break-all text-[11.5px] leading-snug text-fg">{ev.value || '—'}</code>
    </li>
  );
}

function NodePanel({ project, node, onClose, onSelect }) {
  const evidence = useMemo(() => new Map(project.evidence.map(e => [e.id, e])), [project]);
  const techs = project.technologies.filter(t => node.technologies.includes(t.id));
  const rels = project.graph.edges.filter(e => e.source === node.id || e.target === node.id);
  const label = (id) => project.graph.nodes.find(n => n.id === id)?.label || id;
  return (
    <motion.aside key={node.id} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }}
      className="glass-strong flex max-h-[780px] flex-col overflow-hidden rounded-3xl" aria-label={`Details for ${node.label}`} data-testid="node-panel">
      <div className="flex items-start gap-3 border-b border-line p-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: LAYER_COLORS[node.layer] }}>{LAYER_LABELS[node.layer]}</div>
          <h3 className="mt-1 font-display text-lg font-semibold leading-tight">{node.label}</h3>
          <div className="mt-2"><StatusBadge status={node.status} /></div>
        </div>
        <button className="rounded-lg p-1.5 text-fg-subtle hover:text-fg" onClick={onClose} aria-label="Close details"><X size={16} /></button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4 text-sm">
        {node.status !== 'unknown' && <div><div className="mb-1.5 text-xs font-semibold text-fg-muted">Confidence</div><ConfidenceBar value={node.confidence} status={node.status} /></div>}
        <p className="leading-relaxed text-fg-muted">{node.description}</p>
        {Object.keys(node.details || {}).length > 0 && (
          <dl className="grid grid-cols-2 gap-2">
            {Object.entries(node.details).map(([k, v]) => <div key={k} className="rounded-xl bg-inset p-2"><dt className="text-[11px] text-fg-subtle">{k}</dt><dd className="truncate font-mono text-xs">{String(v)}</dd></div>)}
          </dl>
        )}
        {techs.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-semibold text-fg-muted">Technologies</div>
            <ul className="space-y-2">{techs.map(t => (
              <li key={t.id} className="rounded-xl border border-line p-2.5">
                <div className="flex items-center gap-2"><span className="font-semibold">{t.name}{t.version ? ` ${t.version}` : ''}</span><span className="ml-auto"><StatusBadge status={t.status} size="xs" /></span></div>
                <div className="mt-0.5 text-xs text-fg-subtle">{t.category}</div>
              </li>
            ))}</ul>
          </div>
        )}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-fg-muted">Why this node exists <span className="font-normal text-fg-subtle">({node.evidenceIds.length} evidence item{node.evidenceIds.length === 1 ? '' : 's'})</span></div>
          {node.evidenceIds.length
            ? <ul className="space-y-2" data-testid="node-evidence">{node.evidenceIds.map(id => <EvidenceItem key={id} ev={evidence.get(id)} />)}</ul>
            : <p className="rounded-xl border border-dashed border-line p-3 text-xs text-fg-subtle">No direct evidence — this node is shown to make an {node.status} part of the architecture explicit rather than silently omitted.</p>}
        </div>
        {node.limitations?.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-semibold text-fg-muted">Limitations</div>
            <ul className="list-disc space-y-1 pl-4 text-xs text-fg-muted">{node.limitations.map(l => <li key={l}>{l}</li>)}</ul>
          </div>
        )}
        {rels.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-semibold text-fg-muted">Relationships</div>
            <ul className="space-y-2">{rels.map(e => (
              <li key={e.id}>
                <button className="w-full rounded-xl border border-line p-2.5 text-left hover:border-line-strong" onClick={() => onSelect(e.source === node.id ? e.target : e.source)}>
                  <div className="flex items-center gap-1.5 text-xs font-medium"><span className="truncate">{label(e.source)}</span><ArrowRight size={12} className="shrink-0 text-fg-subtle" /><span className="truncate">{label(e.target)}</span><span className="ml-auto"><StatusBadge status={e.status} size="xs" /></span></div>
                  <div className="mt-1 text-[11.5px] text-fg-muted">{e.explanation}</div>
                </button>
              </li>
            ))}</ul>
          </div>
        )}
      </div>
    </motion.aside>
  );
}

function FlowCanvas({ project, selectedId, setSelectedId, search, statuses, layers }) {
  const { isDark } = useTheme();
  const { fitView, getNodes } = useReactFlow();
  const flow = useMemo(() => toFlow(project.graph, { search, statuses, layers, selectedId }), [project, search, statuses, layers, selectedId]);
  const nodesReady = useNodesInitialized();
  const wrapRef = useRef(null);
  // Fit once nodes are measured, and again whenever the canvas changes size (window resize, side panel).
  useEffect(() => { if (nodesReady) fitView({ padding: 0.1, duration: 300 }); }, [nodesReady, project.id, fitView]);
  useEffect(() => {
    if (!wrapRef.current || typeof ResizeObserver === 'undefined') return undefined;
    let t;
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => fitView({ padding: 0.1, duration: 200 }), 120); });
    ro.observe(wrapRef.current);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, [fitView]);

  const exportPng = useCallback(async () => {
    const nodes = getNodes();
    const bounds = getNodesBounds(nodes);
    const w = Math.ceil(bounds.width + 80), h = Math.ceil(bounds.height + 80);
    const vp = getViewportForBounds(bounds, w, h, 0.5, 2, 0.04);
    const el = document.querySelector('.react-flow__viewport');
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
    const dataUrl = await toPng(el, { backgroundColor: bg, width: w, height: h, pixelRatio: 2, style: { width: `${w}px`, height: `${h}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` } });
    download(`stackreel-${project.site.host}-architecture.png`, dataUrl);
  }, [getNodes, project]);

  return (
    <div ref={wrapRef} className="glass relative h-[min(780px,75vh)] min-h-[460px] overflow-hidden rounded-3xl" data-testid="flow-canvas">
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        colorMode={isDark ? 'dark' : 'light'}
        onNodeClick={(_, n) => n.type === 'arch' && setSelectedId(n.id === selectedId ? null : n.id)}
        onPaneClick={() => setSelectedId(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.25}
        maxZoom={2}
        fitView
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={28} size={1.2} />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      <div className="absolute right-3 top-3 flex gap-2">
        <button className="btn btn-ghost btn-sm !bg-[var(--surface-solid)]" onClick={() => fitView({ padding: 0.12, duration: 400 })}><Maximize2 size={13} /> Fit</button>
        <button className="btn btn-ghost btn-sm !bg-[var(--surface-solid)]" onClick={exportPng} data-testid="export-png"><Download size={13} /> PNG</button>
        <button className="btn btn-ghost btn-sm !bg-[var(--surface-solid)]" onClick={() => {
          const blob = new Blob([JSON.stringify({ site: project.site, analyzedAt: project.createdAt, graph: project.graph, technologies: project.technologies, evidence: project.evidence }, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          download(`stackreel-${project.site.host}-architecture.json`, url);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}><FileJson size={13} /> JSON</button>
      </div>
    </div>
  );
}

export function ProjectGate({ children }) {
  const { projectId, status, project, error } = useRouteProject();
  const { navigate, loadProject } = useApp();
  if (!projectId) return <EmptyState icon={Network} title="No project selected" action={<button className="btn btn-primary" onClick={() => navigate('dashboard')}>Analyze a website</button>}>Run an analysis from the dashboard first.</EmptyState>;
  if (status === 'error') return <ErrorPanel title="Could not load this analysis" message={error} onRetry={() => loadProject(projectId, { force: true })} />;
  if (!project) return <div className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-[520px] rounded-3xl" /></div>;
  return children(project);
}

export function ProjectHeader({ project, right }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="eyebrow mb-1">Analyzed {timeAgo(project.createdAt)} · {project.browser?.ok ? 'browser + HTTP evidence' : 'HTTP evidence only'}</div>
        <h2 className="truncate font-display text-2xl font-bold tracking-tight sm:text-3xl">{project.site.host}</h2>
        <a href={project.finalUrl} target="_blank" rel="noreferrer noopener" className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-fg-muted hover:text-accent-2">{project.finalUrl} <ExternalLink size={11} /></a>
      </div>
      {right}
    </div>
  );
}

export default function ExplorerView() {
  const { navigate } = useApp();
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [statuses, setStatuses] = useState(new Set(['observed', 'inferred', 'unknown']));
  const [layerFilter, setLayerFilter] = useState('all');
  const toggleStatus = (s) => setStatuses((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n.size ? n : prev; });

  return (
    <ProjectGate>
      {(project) => {
        const node = project.graph.nodes.find(n => n.id === selectedId);
        const layers = layerFilter === 'all' ? undefined : new Set([layerFilter]);
        const counts = Object.fromEntries(['observed', 'inferred', 'unknown'].map(s => [s, project.graph.nodes.filter(n => n.status === s).length]));
        return (
          <div className="mx-auto max-w-[1600px]">
            <ProjectHeader project={project} right={<button className="btn btn-primary" onClick={() => navigate('studio', project.id)}><Clapperboard size={15} /> Open video studio</button>} />
            {project.unavailable?.length > 0 && (
              <div className="glass mb-4 flex items-start gap-2.5 rounded-2xl p-3 text-xs text-fg-muted" role="note">
                <Info size={15} className="mt-0.5 shrink-0 text-info" />
                <div><span className="font-semibold text-fg">Evidence limits: </span>{project.unavailable.join(' ')}</div>
              </div>
            )}
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <label className="relative min-w-[220px] flex-1 sm:max-w-sm">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
                <span className="sr-only">Search components</span>
                <input className="input !rounded-xl !py-2 !pl-9 text-sm" placeholder="Search components, technologies…" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="graph-search" />
              </label>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
                {['observed', 'inferred', 'unknown'].map(s => (
                  <button key={s} onClick={() => toggleStatus(s)} aria-pressed={statuses.has(s)} className={`chip transition-opacity ${statuses.has(s) ? '' : 'opacity-40'}`}>
                    <span className={`size-2 rounded-full bg-${s}`} />{s} · {counts[s]}
                  </button>
                ))}
              </div>
              <select className="rounded-xl border border-line bg-inset px-3 py-2 text-sm" value={layerFilter} onChange={(e) => setLayerFilter(e.target.value)} aria-label="Filter by layer">
                <option value="all">All layers</option>
                {project.graph.layers.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <Legend className="ml-auto hidden xl:flex" />
            </div>
            <div className={`grid gap-4 ${node ? 'lg:grid-cols-[minmax(0,1fr)_380px]' : ''}`}>
              <ReactFlowProvider>
                <FlowCanvas project={project} selectedId={selectedId} setSelectedId={setSelectedId} search={search} statuses={statuses} layers={layers} />
              </ReactFlowProvider>
              <AnimatePresence>{node && <NodePanel project={project} node={node} onClose={() => setSelectedId(null)} onSelect={setSelectedId} />}</AnimatePresence>
            </div>
            {!node && <p className="mt-3 text-center text-xs text-fg-subtle">Click any component to see the evidence behind it. Dashed = inferred, dotted = unknown.</p>}
            <TechTable project={project} />
          </div>
        );
      }}
    </ProjectGate>
  );
}

function TechTable({ project }) {
  if (!project.technologies.length && !project.integrations.length) return null;
  const rows = [...project.technologies, ...project.integrations.map(i => ({ ...i, rationale: `Requests to ${i.hosts.join(', ')}` }))];
  return (
    <section className="mt-10">
      <h3 className="mb-3 font-display text-lg font-semibold">Detected technologies & services</h3>
      <div className="glass overflow-x-auto rounded-2xl">
        <table className="w-full min-w-[640px] text-left text-sm" data-testid="tech-table">
          <thead className="border-b border-line text-xs text-fg-subtle"><tr><th className="p-3 font-medium">Technology</th><th className="p-3 font-medium">Category</th><th className="p-3 font-medium">Status</th><th className="w-40 p-3 font-medium">Confidence</th><th className="p-3 font-medium">Evidence</th></tr></thead>
          <tbody>
            {rows.map(t => (
              <tr key={t.id} className="border-b border-line/60 last:border-0">
                <td className="p-3 font-semibold">{t.name}{t.version ? <span className="ml-1 font-mono text-xs text-fg-muted">{t.version}</span> : null}</td>
                <td className="p-3 text-fg-muted">{t.category}</td>
                <td className="p-3"><StatusBadge status={t.status} size="xs" /></td>
                <td className="p-3"><ConfidenceBar value={t.confidence} status={t.status} /></td>
                <td className="max-w-[360px] truncate p-3 font-mono text-[11.5px] text-fg-muted" title={t.rationale}>{t.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
