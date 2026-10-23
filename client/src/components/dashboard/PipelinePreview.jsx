import { motion, useReducedMotion } from 'motion/react';
import { Globe, Shield, Server, Layers, Network, Cpu, Database } from 'lucide-react';

// An explanatory schematic of what StackReel maps. It is NOT a scan result
// and is labelled accordingly.
const STEPS = [
  { label: 'Browser', Icon: Globe, color: 'var(--accent-2)' },
  { label: 'CDN / edge', Icon: Shield, color: 'var(--accent-2)' },
  { label: 'Origin', Icon: Server, color: 'var(--accent-4)' },
  { label: 'Frontend', Icon: Layers, color: 'var(--accent)' },
  { label: 'Public API', Icon: Network, color: 'var(--accent-3)' },
  { label: 'Backend', Icon: Cpu, color: 'var(--accent)' },
  { label: 'Data', Icon: Database, color: 'var(--inferred)' },
];

export default function PipelinePreview() {
  const reduce = useReducedMotion();
  const W = 640, H = 220;
  const pts = STEPS.map((_, i) => ({ x: 46 + i * ((W - 92) / (STEPS.length - 1)), y: i % 2 ? 140 : 80 }));
  const path = pts.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `C ${pts[i - 1].x + 40} ${pts[i - 1].y}, ${p.x - 40} ${p.y}, ${p.x} ${p.y}`)).join(' ');
  return (
    <div className="glass relative overflow-hidden rounded-3xl p-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">How StackReel maps a site</span>
        <span className="chip">illustration · not a scan</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Illustration of the layers StackReel looks for: browser, edge, origin, frontend, API, backend and data">
        <defs>
          <linearGradient id="pp-g" x1="0" x2="1"><stop offset="0" stopColor="var(--accent-2)" /><stop offset="0.5" stopColor="var(--accent)" /><stop offset="1" stopColor="var(--accent-3)" /></linearGradient>
        </defs>
        <path d={path} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
        <motion.path d={path} fill="none" stroke="url(#pp-g)" strokeWidth="2.5" strokeLinecap="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduce ? 0 : 1.8, ease: 'easeInOut' }} />
        {!reduce && [0, 1, 2].map((k) => (
          <circle key={k} r="4" fill="var(--accent-2)">
            <animateMotion dur="4.5s" begin={`${k * 1.5}s`} repeatCount="indefinite" path={path} />
          </circle>
        ))}
        {STEPS.map(({ label, Icon, color }, i) => (
          <motion.g key={label} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduce ? 0 : 0.2 + i * 0.15 }}>
            <rect x={pts[i].x - 34} y={pts[i].y - 22} width="68" height="44" rx="12" fill="var(--surface-solid)" stroke={color} strokeOpacity="0.6" />
            <foreignObject x={pts[i].x - 9} y={pts[i].y - 16} width="18" height="18"><Icon size={18} color={color} /></foreignObject>
            <text x={pts[i].x} y={pts[i].y + 16} textAnchor="middle" fontSize="9.5" fontWeight="600" fill="var(--fg-muted)" fontFamily="var(--font-sans)">{label}</text>
          </motion.g>
        ))}
        <text x={W / 2} y={H - 10} textAnchor="middle" fontSize="11" fill="var(--fg-subtle)" fontFamily="var(--font-mono)">each layer is labelled observed · inferred · unknown from evidence</text>
      </svg>
    </div>
  );
}
