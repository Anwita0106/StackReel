// Evidence store. Every claim StackReel makes (technology, graph node,
// security finding, narration fact) references one or more evidence items
// collected during the inspection, so the UI can always answer "why?".
import crypto from 'node:crypto';

export const EVIDENCE_KINDS = ['header', 'cookie', 'html', 'dom', 'script', 'request', 'dns', 'tls', 'redirect', 'meta', 'robots', 'network', 'limitation'];

export function createEvidenceStore() {
  const items = new Map();
  return {
    add({ kind, source, label, value, detail }) {
      const key = `${kind}|${label}|${String(value).slice(0, 200)}`;
      const id = 'ev_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
      if (!items.has(id)) {
        items.set(id, {
          id,
          kind,
          source, // http | browser | dns | tls | robots
          label: String(label).slice(0, 160),
          value: value == null ? '' : String(value).slice(0, 600),
          ...(detail ? { detail: String(detail).slice(0, 400) } : {}),
        });
      }
      return id;
    },
    get: (id) => items.get(id),
    list: () => [...items.values()],
  };
}
