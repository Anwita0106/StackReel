import { motion } from 'motion/react';
import { CheckCircle2, Loader2, XCircle, Ban, RotateCcw, Square, Circle, X } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';

const TITLES = { analysis: 'Website analysis', render: 'Video render' };

export default function JobProgress({ job, compact = false }) {
  const { cancelJob, retryJob, dismissJob } = useApp();
  const active = job.status === 'queued' || job.status === 'running';
  const tone = job.status === 'failed' ? 'text-danger' : job.status === 'completed' ? 'text-ok' : job.status === 'cancelled' ? 'text-fg-subtle' : 'text-accent-2';
  const StatusIcon = job.status === 'completed' ? CheckCircle2 : job.status === 'failed' ? XCircle : job.status === 'cancelled' ? Ban : Loader2;

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass @container rounded-2xl p-4" data-testid={`job-${job.type}`}>
      <div className="flex items-start gap-3">
        <StatusIcon size={18} className={`mt-0.5 shrink-0 ${tone} ${active ? 'animate-spin' : ''}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="text-sm font-semibold">{TITLES[job.type] || job.type}</span>
            <span className="truncate font-mono text-xs text-fg-muted">{job.meta?.host}</span>
          </div>
          <div className="mt-0.5 text-xs text-fg-muted" aria-live="polite">
            {job.status === 'queued' && 'Waiting in queue…'}
            {job.status === 'running' && `${job.stage}`}
            {job.status === 'completed' && 'Completed'}
            {job.status === 'cancelled' && 'Cancelled'}
            {job.status === 'failed' && <span className="text-danger">{job.error?.message}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {active && <button className="btn btn-ghost btn-sm" onClick={() => cancelJob(job.id)}><Square size={12} /> Cancel</button>}
          {(job.status === 'failed' || job.status === 'cancelled') && <button className="btn btn-ghost btn-sm" onClick={() => retryJob(job.id)}><RotateCcw size={12} /> Retry</button>}
          {!active && <button className="rounded-lg p-1.5 text-fg-subtle hover:text-fg" onClick={() => dismissJob(job.id)} aria-label="Dismiss"><X size={14} /></button>}
        </div>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${TITLES[job.type]} progress`}>
        <motion.div className={`h-full rounded-full ${job.status === 'failed' ? 'bg-danger' : 'bg-gradient-to-r from-accent via-accent-3 to-accent-2'}`}
          animate={{ width: `${job.status === 'completed' ? 100 : job.progress}%` }} transition={{ ease: 'easeOut', duration: 0.5 }} />
      </div>

      {!compact && (
        <div className="mt-4 grid gap-4 @2xl:grid-cols-[minmax(0,240px)_1fr]">
          <ol className="space-y-1.5">
            {job.stages.map((s, i) => {
              const done = job.status === 'completed' || i < job.stageIndex;
              const current = i === job.stageIndex && active;
              return (
                <li key={s} className={`flex items-center gap-2 text-xs ${done ? 'text-fg' : current ? 'text-accent-2' : 'text-fg-subtle'}`}>
                  {done ? <CheckCircle2 size={13} className="text-ok" /> : current ? <Loader2 size={13} className="animate-spin" /> : <Circle size={13} />}
                  {s}
                </li>
              );
            })}
          </ol>
          <div className="terminal max-h-52 overflow-auto p-3 text-[11.5px] leading-relaxed" aria-label="Job log">
            {job.logs.slice(-14).map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-words"><span className="text-white/35">{l.t.slice(11, 19)} </span>{l.msg}</div>
            ))}
            {active && <div className="caret text-white/50" />}
          </div>
        </div>
      )}
    </motion.div>
  );
}
