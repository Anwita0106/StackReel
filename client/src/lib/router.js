import { useEffect, useState, useCallback } from 'react';

// Tiny hash router: #/view/:projectId. Keeps state across refreshes and
// works with any static host.
export const VIEWS = ['dashboard', 'explorer', 'security', 'evidence', 'studio'];

export function parseHash(hash = window.location.hash) {
  const [, view = 'dashboard', projectId = null] = hash.replace(/^#/, '').split('/');
  return { view: VIEWS.includes(view) ? view : 'dashboard', projectId: projectId || null };
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((view, projectId) => {
    const next = view === 'dashboard' ? '#/dashboard' : `#/${view}${projectId ? `/${projectId}` : ''}`;
    if (window.location.hash !== next) window.location.hash = next;
    else setRoute(parseHash(next));
  }, []);
  return [route, navigate];
}
