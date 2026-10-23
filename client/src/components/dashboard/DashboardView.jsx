import { motion } from 'motion/react';
import { Network, Clapperboard, Trash2, Play, Download, Film, Radar, ShieldCheck, Sparkles } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import AnalyzeForm from './AnalyzeForm.jsx';
import PipelinePreview from './PipelinePreview.jsx';
import JobProgress from '../jobs/JobProgress.jsx';
import { EmptyState, ErrorPanel, SectionTitle, Skeleton, SafeImg } from '../common/ui.jsx';
import { screenshotUrl, renderFileUrl } from '../../lib/api.js';
import { formatBytes, formatDuration, timeAgo } from '../../lib/format.js';

const fade = (i = 0) => ({ initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { delay: i * 0.06, duration: 0.45, ease: [0.2, 0.8, 0.2, 1] } });

function Hero() {
  return (
    <section className="grid items-center gap-8 lg:grid-cols-[1.1fr_1fr]">
      <motion.div {...fade(0)}>
        <div className="eyebrow mb-4 flex items-center gap-2"><Sparkles size={12} /> Evidence-aware architecture videos</div>
        <h2 className="font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl xl:text-6xl">
          <span className="text-gradient">Reverse Engineer</span><br />Any Website.
        </h2>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-fg-muted sm:text-lg">
          Paste a URL. StackReel inspects what the site publicly reveals, maps its likely architecture with evidence for every component, and renders a narrated explainer video.
        </p>
        <div className="mt-7"><AnalyzeForm /></div>
      </motion.div>
      <motion.div {...fade(2)}><PipelinePreview /></motion.div>
    </section>
  );
}

function Onboarding() {
  const steps = [
    { Icon: Radar, title: 'Inspect', text: 'Headers, TLS, DNS, the rendered DOM and every network request — in a sandboxed browser that cannot reach private networks.' },
    { Icon: Network, title: 'Map', text: 'Deterministic signatures build a graph. Each node is observed, inferred or unknown, with the evidence one click away.' },
    { Icon: Clapperboard, title: 'Render', text: 'A six-scene script is narrated and rendered to a real MP4 with captions — verified before it is offered for download.' },
  ];
  return (
    <section className="grid gap-4 md:grid-cols-3">
      {steps.map(({ Icon, title, text }, i) => (
        <motion.div key={title} {...fade(3 + i)} className="glass card-hover rounded-3xl p-5">
          <div className="mb-3 flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl border border-line bg-surface-2 text-accent-strong"><Icon size={18} /></div>
            <span className="font-mono text-xs text-fg-subtle">0{i + 1}</span>
          </div>
          <div className="font-display text-lg font-semibold">{title}</div>
          <p className="mt-1 text-sm leading-relaxed text-fg-muted">{text}</p>
        </motion.div>
      ))}
    </section>
  );
}

function Stats() {
  const { stats } = useApp();
  if (!stats || stats.analyses === 0) return null; // never show invented numbers
  const items = [
    ['Websites analyzed', stats.analyses],
    ['Components mapped', stats.componentsMapped],
    ['Videos rendered', stats.videos],
    ['Minutes of video', (stats.videoSeconds / 60).toFixed(1)],
  ];
  return (
    <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Your StackReel statistics" data-testid="stats">
      {items.map(([label, value], i) => (
        <motion.div key={label} {...fade(i)} className="glass rounded-2xl p-4">
          <div className="font-display text-3xl font-bold tracking-tight">{value}</div>
          <div className="mt-1 text-xs text-fg-muted">{label}</div>
        </motion.div>
      ))}
    </section>
  );
}

function ActiveJobs() {
  const { jobs } = useApp();
  const list = Object.values(jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  if (!list.length) return null;
  return (
    <section aria-label="Jobs">
      <SectionTitle eyebrow="Live" title="Pipeline activity">Real progress from the server — stages, logs and failures as they happen.</SectionTitle>
      <div className="space-y-3">{list.map((j, i) => <JobProgress key={j.id} job={j} compact={i > 0 && j.status === 'completed'} />)}</div>
    </section>
  );
}

function RecentProjects() {
  const { projects, navigate, deleteProject, toast, refreshAll } = useApp();
  if (projects.status === 'loading') {
    return <section><SectionTitle title="Recent analyses" /><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-56 rounded-3xl" />)}</div></section>;
  }
  if (projects.status === 'error' && !projects.items.length) {
    return <section><SectionTitle title="Recent analyses" /><ErrorPanel title="Could not load analyses" message={projects.error} onRetry={refreshAll} /></section>;
  }
  if (!projects.items.length) {
    return (
      <section>
        <SectionTitle title="Recent analyses" />
        <EmptyState icon={Network} title="No analyses yet">Enter a public website above. Your first architecture map appears here — nothing is pre-filled or simulated.</EmptyState>
      </section>
    );
  }
  return (
    <section>
      <SectionTitle eyebrow="Library" title="Recent analyses">{projects.items.length} saved on this machine</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="recent-projects">
        {projects.items.map((p, i) => (
          <motion.article key={p.id} {...fade(i)} className="glass card-hover group flex flex-col overflow-hidden rounded-3xl">
            <button className="relative block aspect-[16/8] w-full overflow-hidden bg-surface-3 text-left" onClick={() => navigate('explorer', p.id)} aria-label={`Open ${p.site.host}`}>
              {p.hasScreenshot
                ? <SafeImg src={screenshotUrl(p.id)} label="screenshot unavailable" className="h-full w-full object-cover object-top opacity-90 transition-transform duration-500 group-hover:scale-[1.03]" />
                : <div className="grid h-full place-items-center font-mono text-xs text-fg-subtle">no screenshot (HTTP-only analysis)</div>}
              <div className="absolute inset-0 bg-gradient-to-t from-[var(--surface-solid)] via-transparent" />
            </button>
            <div className="flex flex-1 flex-col gap-3 p-4">
              <div className="min-w-0">
                <div className="truncate font-display text-lg font-semibold">{p.site.host}</div>
                <div className="truncate text-xs text-fg-muted">{p.title} · {timeAgo(p.createdAt)}</div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {p.topTechnologies.slice(0, 4).map(t => <span key={t} className="chip">{t}</span>)}
                {!p.topTechnologies.length && <span className="text-xs text-fg-subtle">No technology fingerprints matched</span>}
              </div>
              <div className="mt-auto flex items-center gap-3 font-mono text-[11px]">
                <span className="text-observed">{p.counts.observed} observed</span>
                <span className="text-inferred">{p.counts.inferred} inferred</span>
                <span className="text-unknown">{p.counts.unknown} unknown</span>
              </div>
              <div className="flex gap-2">
                <button className="btn btn-ghost btn-sm flex-1" onClick={() => navigate('explorer', p.id)}><Network size={13} /> Map</button>
                <button className="btn btn-ghost btn-sm flex-1" onClick={() => navigate('studio', p.id)}><Clapperboard size={13} /> Studio</button>
                <button className="btn btn-ghost btn-sm !px-2.5" aria-label={`Delete ${p.site.host}`} onClick={async () => {
                  if (!window.confirm(`Delete the analysis of ${p.site.host} and its videos?`)) return;
                  try { await deleteProject(p.id); toast('Deleted', p.site.host, 'info'); } catch (err) { toast('Delete failed', err.message, 'error'); }
                }}><Trash2 size={13} /></button>
              </div>
            </div>
          </motion.article>
        ))}
      </div>
    </section>
  );
}

function VideoGallery() {
  const { renders, navigate } = useApp();
  if (renders.status !== 'ready' || !renders.items.length) return null;
  return (
    <section>
      <SectionTitle eyebrow="Rendered" title="Generated videos">Verified MP4 files, rendered on this machine.</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="video-gallery">
        {renders.items.map((r, i) => (
          <motion.article key={r.id} {...fade(i)} className="glass card-hover group overflow-hidden rounded-2xl">
            <button className="relative block aspect-video w-full overflow-hidden" onClick={() => navigate('studio', r.projectId)} aria-label={`Play video for ${r.host}`}>
              <SafeImg src={renderFileUrl(r.id, 'poster.jpg')} label="poster unavailable" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
              <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors group-hover:bg-black/30">
                <span className="grid size-11 place-items-center rounded-full bg-white/90 text-black opacity-0 shadow-lg transition-opacity group-hover:opacity-100"><Play size={18} fill="currentColor" /></span>
              </span>
              <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white">{formatDuration(r.durationSec)}</span>
            </button>
            <div className="flex items-center gap-2 p-3">
              <Film size={14} className="shrink-0 text-fg-subtle" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{r.host}</div>
                <div className="font-mono text-[11px] text-fg-subtle">{r.height}p · {formatBytes(r.sizeBytes)} · {timeAgo(r.createdAt)}</div>
              </div>
              <a className="btn btn-ghost btn-sm !px-2.5" href={renderFileUrl(r.id, 'video.mp4', true)} aria-label={`Download MP4 for ${r.host}`}><Download size={13} /></a>
            </div>
          </motion.article>
        ))}
      </div>
    </section>
  );
}

export default function DashboardView() {
  const { projects } = useApp();
  return (
    <div className="mx-auto max-w-7xl space-y-12">
      <Hero />
      <ActiveJobs />
      <Stats />
      {projects.status === 'ready' && !projects.items.length && <Onboarding />}
      <RecentProjects />
      <VideoGallery />
      <footer className="flex items-center gap-2 border-t border-line pt-6 text-xs text-fg-subtle">
        <ShieldCheck size={14} /> StackReel never bypasses logins, paywalls, CAPTCHAs or robots.txt, and never runs active security tests.
      </footer>
    </div>
  );
}
