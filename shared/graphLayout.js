// Deterministic layered layout used by both the interactive explorer and the
// video renderer. Main request-path layers are columns (left → right);
// security sits in a band above, external integrations in a band below.
// Returns unit coordinates (0..1) so callers can scale to any canvas.

export const MAIN_LAYERS = ['client', 'edge', 'origin', 'frontend', 'api', 'backend', 'data'];
export const LAYER_LABELS = {
  client: 'Browser & client', edge: 'CDN & edge', origin: 'Origin & hosting', frontend: 'Frontend',
  api: 'Public API', backend: 'Backend services', data: 'Data & storage', integrations: 'External integrations', security: 'Security boundaries',
};
export const LAYER_COLORS = {
  client: '#38bdf8', edge: '#22d3ee', origin: '#818cf8', frontend: '#a78bfa', api: '#f472b6',
  backend: '#c084fc', data: '#fbbf24', integrations: '#34d399', security: '#fb7185',
};

export function layoutGraph(graph, { bandTop = 0.09, bandBottom = 0.91, mainTop = 0.33, mainBottom = 0.72 } = {}) {
  const present = MAIN_LAYERS.filter(l => graph.nodes.some(n => n.layer === l));
  const columns = present.map((layer, i) => ({ layer, label: LAYER_LABELS[layer], x: present.length === 1 ? 0.5 : 0.06 + (i * 0.88) / (present.length - 1) }));
  const pos = {};
  for (const col of columns) {
    const items = graph.nodes.filter(n => n.layer === col.layer);
    const span = mainBottom - mainTop;
    items.forEach((n, i) => {
      const y = items.length === 1 ? (mainTop + mainBottom) / 2 : mainTop + (span * i) / (items.length - 1);
      pos[n.id] = { x: col.x, y, layer: n.layer };
    });
  }
  const band = (layer, y, x0, x1) => {
    const items = graph.nodes.filter(n => n.layer === layer);
    items.forEach((n, i) => {
      const x = items.length === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (items.length - 1);
      pos[n.id] = { x, y, layer };
    });
    return items.length;
  };
  const sec = band('security', bandTop, 0.2, 0.8);
  const ints = band('integrations', bandBottom, 0.12, 0.88);
  return {
    labelY: (bandTop + mainTop) / 2 + 0.035,
    columns,
    bands: [
      ...(sec ? [{ layer: 'security', label: LAYER_LABELS.security, y: bandTop }] : []),
      ...(ints ? [{ layer: 'integrations', label: LAYER_LABELS.integrations, y: bandBottom }] : []),
    ],
    positions: pos,
  };
}
