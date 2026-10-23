import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { CheckCircle2, AlertTriangle, Info, X, CircleDashed, CircleHelp, Eye } from 'lucide-react';

const STATUS = {
  observed: { label: 'Observed', cls: 'text-observed border-observed/35 bg-observed/10', Icon: Eye, hint: 'Directly supported by collected evidence' },
  inferred: { label: 'Inferred', cls: 'text-inferred border-inferred/35 bg-inferred/10', Icon: CircleDashed, hint: 'Plausible, supported by indirect evidence' },
  unknown: { label: 'Unknown', cls: 'text-unknown border-unknown/35 bg-unknown/10', Icon: CircleHelp, hint: 'Not established by available observations' },
};

export function StatusBadge({ status, size = 'sm' }) {
  const s = STATUS[status] || STATUS.unknown;
  return (
    <span title={s.hint} className={`inline-flex items-center gap-1 rounded-full border font-semibold ${size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'} ${s.cls}`}>
      <s.Icon size={size === 'xs' ? 10 : 12} aria-hidden /> {s.label}
    </span>
  );
}

export function ConfidenceBar({ value, status }) {
  const color = status === 'observed' ? 'bg-observed' : status === 'inferred' ? 'bg-inferred' : 'bg-unknown';
  return (
    <div className="flex items-center gap-2" aria-label={`Confidence ${Math.round(value * 100)}%`}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <motion.div className={`h-full rounded-full ${color}`} initial={{ width: 0 }} animate={{ width: `${Math.round(value * 100)}%` }} transition={{ duration: 0.6, ease: 'easeOut' }} />
      </div>
      <span className="w-9 text-right font-mono text-[11px] text-fg-muted">{Math.round(value * 100)}%</span>
    </div>
  );
}

export function Legend({ className = '' }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {Object.keys(STATUS).map((k) => <StatusBadge key={k} status={k} />)}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="glass flex flex-col items-center justify-center gap-3 rounded-3xl px-6 py-14 text-center">
      {Icon && (
        <div className="grid size-14 place-items-center rounded-2xl border border-line bg-surface-2 text-accent-strong">
          <Icon size={26} aria-hidden />
        </div>
      )}
      <h3 className="font-display text-lg font-semibold">{title}</h3>
      <div className="max-w-md text-sm text-fg-muted">{children}</div>
      {action}
    </div>
  );
}

export function Skeleton({ className = '' }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function SectionTitle({ eyebrow, title, children, right }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h2 className="font-display text-xl font-semibold tracking-tight">{title}</h2>
        {children && <p className="mt-1 text-sm text-fg-muted">{children}</p>}
      </div>
      {right}
    </div>
  );
}

export function ErrorPanel({ title = 'Something went wrong', message, onRetry }) {
  return (
    <div role="alert" className="glass flex items-start gap-3 rounded-2xl border-danger/30 p-4">
      <AlertTriangle className="mt-0.5 shrink-0 text-danger" size={18} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className="mt-0.5 break-words text-sm text-fg-muted">{message}</div>
      </div>
      {onRetry && <button className="btn btn-ghost btn-sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

const TONES = {
  success: { Icon: CheckCircle2, cls: 'text-ok' },
  error: { Icon: AlertTriangle, cls: 'text-danger' },
  info: { Icon: Info, cls: 'text-info' },
};
export function Toasts({ toasts, onDismiss }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => {
          const { Icon, cls } = TONES[t.tone] || TONES.info;
          return (
            <motion.div key={t.id} layout initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 40 }}
              className="glass-strong pointer-events-auto flex items-start gap-3 rounded-2xl p-3.5" role={t.tone === 'error' ? 'alert' : 'status'}>
              <Icon size={18} className={`mt-0.5 shrink-0 ${cls}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{t.title}</div>
                {t.message && <div className="mt-0.5 break-words text-xs text-fg-muted">{t.message}</div>}
              </div>
              <button className="rounded-lg p-1 text-fg-subtle hover:text-fg" onClick={() => onDismiss(t.id)} aria-label="Dismiss notification"><X size={14} /></button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/** Terminal that types its lines out once (instant when reduced motion is on). */
export function TypingTerminal({ title, lines, className = '', speed = 4, maxHeight = 'max-h-80', colorize }) {
  const reduce = useReducedMotion();
  const total = lines.reduce((a, l) => a + l.length, 0);
  const [shown, setShown] = useState(reduce ? total : 0);
  const key = lines.join('\n');
  const prev = useRef(key);
  useEffect(() => {
    if (reduce) { setShown(total); return undefined; }
    if (prev.current !== key) { prev.current = key; setShown(0); }
    const id = window.setInterval(() => setShown((s) => (s >= total ? s : s + Math.max(speed, Math.ceil(total / 120)))), 16);
    return () => window.clearInterval(id);
  }, [key, total, speed, reduce]);
  let budget = shown;
  return (
    <div className={`terminal overflow-hidden ${className}`}>
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" /><span className="size-2.5 rounded-full bg-[#febc2e]" /><span className="size-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 truncate text-[11px] text-white/50">{title}</span>
      </div>
      <pre className={`overflow-auto p-4 text-[12px] leading-relaxed ${maxHeight}`}>
        {lines.map((line, i) => {
          if (budget <= 0) return null;
          const part = line.slice(0, budget);
          budget -= line.length;
          const done = budget >= 0;
          return (
            <div key={i} className={`whitespace-pre-wrap break-all ${!done || (i === lines.length - 1 && shown < total + 1) ? 'caret' : ''}`}>
              <span className="select-none text-cyan-300/70">› </span>
              <span className={colorize ? colorize(line) : ''}>{part}</span>
            </div>
          );
        })}
        {lines.length === 0 && <span className="text-white/40">(no data)</span>}
      </pre>
    </div>
  );
}

/** Image that shows an honest placeholder when the file cannot be loaded. */
export function SafeImg({ src, className, label = 'image unavailable' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <div className={`${className} grid place-items-center bg-surface-3 font-mono text-[9px] text-fg-subtle`} title={label}>{failed ? label : ''}</div>;
  return <img src={src} alt="" className={className} onError={() => setFailed(true)} loading="lazy" />;
}

