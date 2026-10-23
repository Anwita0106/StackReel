import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { LayoutDashboard, Network, ShieldCheck, TerminalSquare, Clapperboard, Sun, Moon, Menu, X, Layers, RefreshCw } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useTheme } from '../../context/ThemeContext.jsx';

export const NAV = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { id: 'explorer', label: 'Architecture', Icon: Network, needsProject: true },
  { id: 'security', label: 'Security', Icon: ShieldCheck, needsProject: true },
  { id: 'evidence', label: 'Evidence', Icon: TerminalSquare, needsProject: true },
  { id: 'studio', label: 'Video Studio', Icon: Clapperboard, needsProject: true },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative grid size-9 place-items-center rounded-xl bg-gradient-to-br from-accent via-accent-4 to-accent-2 text-white shadow-glow">
        <Layers size={18} aria-hidden />
      </div>
      <div className="leading-tight">
        <div className="font-display text-[17px] font-bold tracking-tight">StackReel</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">architecture reels</div>
      </div>
    </div>
  );
}

export function ThemeToggle() {
  const { isDark, toggleTheme } = useTheme();
  return (
    <button onClick={toggleTheme} className="btn btn-ghost btn-sm !px-2.5" aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`} title={`Switch to ${isDark ? 'light' : 'dark'} theme`} data-testid="theme-toggle">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={isDark ? 'moon' : 'sun'} initial={{ rotate: -60, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 60, opacity: 0 }} transition={{ duration: 0.2 }}>
          {isDark ? <Moon size={16} /> : <Sun size={16} />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

function BackendStatus() {
  const { backend, refreshBackend } = useApp();
  const state = backend.state === 'online' && backend.ready?.ready === false ? 'degraded' : backend.state;
  const map = {
    checking: ['bg-fg-subtle', 'Connecting…'],
    online: ['bg-ok', 'API online'],
    degraded: ['bg-warn', 'API degraded'],
    offline: ['bg-danger', 'API offline'],
  };
  const [dot, label] = map[state];
  const problems = backend.ready?.checks ? Object.entries(backend.ready.checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail || 'unavailable'}`) : [];
  return (
    <button onClick={() => refreshBackend(true)} className="chip !py-1 hover:text-fg" title={state === 'offline' ? backend.error : problems.join('\n') || 'All systems ready — click to re-check'} data-testid="backend-status">
      <span className={`size-2 rounded-full ${dot} ${state === 'online' ? 'live-dot' : ''}`} aria-hidden />
      <span>{label}</span>
      <RefreshCw size={11} className="opacity-60" aria-hidden />
    </button>
  );
}

function ProjectSwitcher() {
  const { projects, routeProjectId, route, navigate } = useApp();
  if (!projects.items.length) return null;
  const view = route.view === 'dashboard' ? 'explorer' : route.view;
  return (
    <label className="hidden min-w-0 items-center gap-2 md:flex">
      <span className="sr-only">Active project</span>
      <select
        className="input !w-auto max-w-[240px] !rounded-xl !py-1.5 !pl-3 !pr-8 text-sm"
        value={routeProjectId || ''}
        onChange={(e) => navigate(view, e.target.value)}
        data-testid="project-switcher"
      >
        {projects.items.map((p) => <option key={p.id} value={p.id}>{p.site.host}</option>)}
      </select>
    </label>
  );
}

export function Shell({ children }) {
  const { route, navigate, routeProjectId } = useApp();
  const [open, setOpen] = useState(false);
  const current = NAV.find((n) => n.id === route.view) || NAV[0];

  const nav = (
    <nav className="flex flex-col gap-1" aria-label="Main">
      {NAV.map(({ id, label, Icon, needsProject }) => {
        const disabled = needsProject && !routeProjectId;
        const active = route.view === id;
        return (
          <button key={id} disabled={disabled} onClick={() => { navigate(id, routeProjectId); setOpen(false); }}
            className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${active ? 'text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'} disabled:cursor-not-allowed disabled:opacity-40`}
            aria-current={active ? 'page' : undefined} title={disabled ? 'Analyze a website first' : undefined} data-testid={`nav-${id}`}>
            {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl border border-line-strong bg-surface-2" transition={{ type: 'spring', stiffness: 400, damping: 34 }} />}
            <Icon size={17} className={`relative ${active ? 'text-accent-strong' : ''}`} aria-hidden />
            <span className="relative">{label}</span>
          </button>
        );
      })}
    </nav>
  );

  return (
    <div className="relative flex min-h-screen">
      <div className="ambient" aria-hidden><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /></div>

      <aside className="glass sticky top-0 z-20 hidden h-screen w-64 shrink-0 flex-col gap-8 rounded-none border-y-0 border-l-0 p-5 lg:flex">
        <Logo />
        {nav}
        <div className="mt-auto rounded-2xl border border-line bg-surface-2 p-3.5 text-xs leading-relaxed text-fg-muted">
          <div className="mb-1 font-semibold text-fg">Passive & evidence-based</div>
          StackReel only reads what any browser receives from a public page. Every claim links to its evidence.
        </div>
      </aside>

      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-40 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
            <motion.aside initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="glass-strong absolute inset-y-0 left-0 flex w-72 flex-col gap-8 rounded-none p-5">
              <div className="flex items-center justify-between"><Logo /><button className="p-2" onClick={() => setOpen(false)} aria-label="Close menu"><X size={18} /></button></div>
              {nav}
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-canvas/70 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8">
          <button className="btn btn-ghost btn-sm !px-2.5 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={16} /></button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-base font-semibold tracking-tight sm:text-lg">{current.label}</h1>
          </div>
          <ProjectSwitcher />
          <BackendStatus />
          <ThemeToggle />
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <AnimatePresence mode="wait">
            <motion.div key={`${route.view}-${route.view === 'dashboard' ? '' : routeProjectId}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25, ease: 'easeOut' }}>
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
