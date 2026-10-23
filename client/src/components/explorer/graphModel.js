import { layoutGraph, LAYER_LABELS } from '@shared/graphLayout.js';

export const NODE_W = 196;
export const NODE_H = 72;

/** Converts the analysis graph into React Flow nodes/edges (pure; unit-tested). */
export function toFlow(graph, { width, height = 780, search = '', statuses, layers, selectedId } = {}) {
  const layout = layoutGraph(graph);
  const cols = Math.max(1, layout.columns.length);
  const W = width || Math.max(1180, cols * 250);
  const q = search.trim().toLowerCase();
  const matches = (n) => (!q || `${n.label} ${n.description} ${n.technologies.join(' ')}`.toLowerCase().includes(q))
    && (!statuses || statuses.has(n.status)) && (!layers || layers.has(n.layer));
  const neighbors = new Set();
  if (selectedId) for (const e of graph.edges) {
    if (e.source === selectedId) neighbors.add(e.target);
    if (e.target === selectedId) neighbors.add(e.source);
  }

  // Column lanes sit between the security band (top) and integrations band (bottom).
  const hasTop = layout.bands.some(b => b.layer === 'security');
  const hasBottom = layout.bands.some(b => b.layer === 'integrations');
  const laneTop = hasTop ? 0.09 * height + NODE_H / 2 + 26 : 0;
  const laneBottom = hasBottom ? 0.91 * height - NODE_H / 2 - 42 : height;
  const laneH = laneBottom - laneTop;
  const lanes = layout.columns.map((c) => ({
    id: `lane-${c.layer}`, type: 'lane', position: { x: c.x * W - NODE_W / 2 - 18, y: laneTop }, draggable: false, selectable: false, focusable: false,
    data: { label: LAYER_LABELS[c.layer], layer: c.layer, width: NODE_W + 36, height: laneH }, zIndex: -1, style: { width: NODE_W + 36, height: laneH },
  }));
  const bandW = layout.columns.length ? (layout.columns[layout.columns.length - 1].x - layout.columns[0].x) * W + NODE_W + 36 : W;
  const bands = layout.bands.map((b) => ({
    id: `band-${b.layer}`, type: 'band', position: { x: layout.columns[0] ? layout.columns[0].x * W - NODE_W / 2 - 18 : 0, y: b.y * height - NODE_H / 2 - 30 }, draggable: false, selectable: false, focusable: false,
    data: { label: LAYER_LABELS[b.layer], layer: b.layer }, zIndex: -1, style: { width: bandW, height: NODE_H + 44 },
  }));

  const nodes = graph.nodes.map((n) => {
    const p = layout.positions[n.id] || { x: 0.5, y: 0.5 };
    const visible = matches(n);
    return {
      id: n.id,
      type: 'arch',
      position: { x: p.x * W - NODE_W / 2, y: p.y * height - NODE_H / 2 },
      data: { node: n, dimmed: !visible || Boolean(selectedId && selectedId !== n.id && !neighbors.has(n.id)), highlighted: neighbors.has(n.id) },
      selected: n.id === selectedId,
    };
  });
  const visibleIds = new Set(graph.nodes.filter(matches).map(n => n.id));
  const edges = graph.edges.map((e) => {
    const touches = selectedId && (e.source === selectedId || e.target === selectedId);
    const visible = visibleIds.has(e.source) && visibleIds.has(e.target);
    const color = e.status === 'observed' ? 'var(--accent-2)' : e.status === 'inferred' ? 'var(--inferred)' : 'var(--unknown)';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.status === 'observed',
      label: touches ? e.label : undefined,
      data: { edge: e },
      style: {
        stroke: color,
        strokeWidth: touches ? 2.4 : 1.5,
        strokeDasharray: e.status === 'observed' ? undefined : e.status === 'inferred' ? '6 5' : '2 5',
        opacity: !visible ? 0.08 : selectedId && !touches ? 0.18 : 0.85,
      },
    };
  });
  return { nodes: [...bands, ...lanes, ...nodes], edges, width: W, height };
}
