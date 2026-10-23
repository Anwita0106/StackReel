import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useHashRoute } from '../lib/router.js';

const AppContext = createContext(null);
const LAST_PROJECT = 'stackreel.lastProject';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function AppProvider({ children, pollMs = 1000 }) {
  const [route, navigate] = useHashRoute();
  const [backend, setBackend] = useState({ state: 'checking', ready: null, capabilities: null, error: null });
  const [projects, setProjects] = useState({ status: 'loading', items: [], error: null });
  const [renders, setRenders] = useState({ status: 'loading', items: [] });
  const [stats, setStats] = useState(null);
  const [jobs, setJobs] = useState({}); // id -> job
  const [toasts, setToasts] = useState([]);
  const [projectCache, setProjectCache] = useState({}); // id -> { status, data, error }
  const handled = useRef(new Set());

  const toast = useCallback((title, message, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, title, message, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 5000);
  }, []);
  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const refreshBackend = useCallback(async (refreshCaps = false) => {
    try {
      await api.health();
      const [ready, capabilities] = await Promise.all([api.ready(), api.capabilities(refreshCaps)]);
      setBackend({ state: 'online', ready, capabilities, error: null });
      return true;
    } catch (err) {
      setBackend((b) => ({ ...b, state: 'offline', error: err.message }));
      return false;
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const items = await api.projects();
      setProjects({ status: 'ready', items, error: null });
    } catch (err) {
      setProjects((p) => ({ ...p, status: 'error', error: err.message }));
    }
  }, []);
  const refreshRenders = useCallback(async () => {
    try { setRenders({ status: 'ready', items: await api.renders() }); } catch { setRenders((r) => ({ ...r, status: 'error' })); }
  }, []);
  const refreshStats = useCallback(async () => { try { setStats(await api.stats()); } catch { setStats(null); } }, []);
  const refreshAll = useCallback(() => Promise.all([refreshProjects(), refreshRenders(), refreshStats()]), [refreshProjects, refreshRenders, refreshStats]);

  // Initial load + reconnect loop while the backend is offline.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const tick = async () => {
      const ok = await refreshBackend();
      if (cancelled) return;
      if (ok) {
        await refreshAll();
        const active = await api.jobs('?active=1').catch(() => []);
        if (!cancelled && active.length) setJobs((j) => ({ ...Object.fromEntries(active.map((x) => [x.id, x])), ...j }));
        timer = window.setTimeout(tick, 30000);
      } else {
        setProjects((p) => (p.status === 'loading' ? { ...p, status: 'error', error: 'API offline' } : p));
        timer = window.setTimeout(tick, 4000);
      }
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [refreshBackend, refreshAll]);

  const loadProject = useCallback(async (id, { force = false } = {}) => {
    if (!id) return;
    setProjectCache((c) => (c[id]?.status === 'ready' && !force ? c : { ...c, [id]: { status: 'loading', data: c[id]?.data || null } }));
    try {
      const data = await api.project(id);
      setProjectCache((c) => ({ ...c, [id]: { status: 'ready', data } }));
      try { localStorage.setItem(LAST_PROJECT, id); } catch { /* ignore */ }
    } catch (err) {
      setProjectCache((c) => ({ ...c, [id]: { status: 'error', error: err.message, code: err.code } }));
    }
  }, []);

  // Resolve which project the current route refers to.
  const routeProjectId = route.projectId || (() => { try { return localStorage.getItem(LAST_PROJECT); } catch { return null; } })() || projects.items[0]?.id || null;
  useEffect(() => {
    if (route.view !== 'dashboard' && routeProjectId && !projectCache[routeProjectId]) loadProject(routeProjectId);
  }, [route.view, routeProjectId, projectCache, loadProject]);

  const trackJob = useCallback((job) => setJobs((j) => ({ ...j, [job.id]: job })), []);

  // Poll every non-terminal job.
  useEffect(() => {
    const active = Object.values(jobs).filter((j) => !TERMINAL.has(j.status));
    if (!active.length) return undefined;
    const timer = window.setInterval(async () => {
      for (const j of active) {
        try {
          const fresh = await api.job(j.id, { timeoutMs: 8000 });
          setJobs((all) => ({ ...all, [fresh.id]: fresh }));
        } catch (err) {
          if (err.status === 404) {
            setJobs((all) => ({ ...all, [j.id]: { ...j, status: 'failed', error: { code: 'JOB_LOST', message: 'The server no longer knows this job (it may have restarted).' } } }));
          }
        }
      }
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [jobs, pollMs]);

  // React to jobs finishing (exactly once per job).
  useEffect(() => {
    for (const job of Object.values(jobs)) {
      if (!TERMINAL.has(job.status) || handled.current.has(job.id)) continue;
      handled.current.add(job.id);
      if (job.type === 'analysis') {
        if (job.status === 'completed') {
          toast('Analysis complete', `Mapped ${job.result.host}. Opening the architecture explorer.`, 'success');
          refreshAll();
          loadProject(job.result.projectId, { force: true });
          if (job.result.renderJobId) api.job(job.result.renderJobId).then(trackJob).catch(() => {});
          navigate('explorer', job.result.projectId);
        } else if (job.status === 'failed') {
          toast('Analysis failed', job.error?.message || 'The website could not be analyzed.', 'error');
        }
      } else if (job.type === 'render') {
        if (job.status === 'completed') {
          toast('Video ready', `Rendered and verified a ${Math.round(job.result.durationSec)}s MP4.`, 'success');
          refreshRenders();
          refreshStats();
        } else if (job.status === 'failed') {
          toast('Render failed', job.error?.message || 'The video could not be rendered.', 'error');
        }
      }
    }
  }, [jobs, toast, refreshAll, refreshRenders, refreshStats, loadProject, navigate, trackJob]);

  const startAnalysis = useCallback(async (input) => {
    const out = await api.startAnalysis(input);
    trackJob(out.job);
    if (out.deduplicated) toast('Already running', 'An analysis of this URL is already in progress — showing it.', 'info');
    return out.job;
  }, [trackJob, toast]);

  const startRender = useCallback(async (projectId, options) => {
    const out = await api.startRender(projectId, options);
    trackJob(out.job);
    return out.job;
  }, [trackJob]);

  const cancelJob = useCallback(async (id) => { try { trackJob(await api.cancelJob(id)); } catch (err) { toast('Could not cancel', err.message, 'error'); } }, [trackJob, toast]);
  const retryJob = useCallback(async (id) => {
    try { const out = await api.retryJob(id); trackJob(out.job); return out.job; } catch (err) { toast('Could not retry', err.message, 'error'); return null; }
  }, [trackJob, toast]);
  const dismissJob = useCallback((id) => setJobs((j) => { const n = { ...j }; delete n[id]; return n; }), []);

  const deleteProject = useCallback(async (id) => {
    await api.deleteProject(id);
    setProjectCache((c) => { const n = { ...c }; delete n[id]; return n; });
    try { if (localStorage.getItem(LAST_PROJECT) === id) localStorage.removeItem(LAST_PROJECT); } catch { /* ignore */ }
    await refreshAll();
  }, [refreshAll]);

  const value = useMemo(() => ({
    route, navigate, backend, refreshBackend, projects, renders, stats, refreshAll, refreshRenders,
    jobs, startAnalysis, startRender, cancelJob, retryJob, dismissJob,
    projectCache, loadProject, routeProjectId, deleteProject,
    toasts, toast, dismissToast,
  }), [route, navigate, backend, refreshBackend, projects, renders, stats, refreshAll, refreshRenders, jobs, startAnalysis, startRender, cancelJob, retryJob, dismissJob, projectCache, loadProject, routeProjectId, deleteProject, toasts, toast, dismissToast]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

/** Convenience: the full project for the current route. */
export function useRouteProject() {
  const { routeProjectId, projectCache } = useApp();
  const entry = routeProjectId ? projectCache[routeProjectId] : null;
  return { projectId: routeProjectId, status: entry?.status || (routeProjectId ? 'loading' : 'none'), project: entry?.data || null, error: entry?.error };
}
