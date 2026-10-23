import { lazy, Suspense } from 'react';
import { MotionConfig } from 'motion/react';
import { ThemeProvider } from './context/ThemeContext.jsx';
import { AppProvider, useApp } from './context/AppContext.jsx';
import { Shell } from './components/layout/Shell.jsx';
import { Toasts, Skeleton } from './components/common/ui.jsx';
import DashboardView from './components/dashboard/DashboardView.jsx';
import ErrorBoundary from './components/common/ErrorBoundary.jsx';

// Heavier views load on demand (React Flow, canvas renderer).
const ExplorerView = lazy(() => import('./components/explorer/ExplorerView.jsx'));
const SecurityView = lazy(() => import('./components/security/SecurityView.jsx'));
const EvidenceView = lazy(() => import('./components/evidence/EvidenceView.jsx'));
const StudioView = lazy(() => import('./components/studio/StudioView.jsx'));

function Routes() {
  const { route, toasts, dismissToast } = useApp();
  const View = { explorer: ExplorerView, security: SecurityView, evidence: EvidenceView, studio: StudioView }[route.view] || DashboardView;
  return (
    <>
      <Shell>
        <Suspense fallback={<div className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-[480px] rounded-3xl" /></div>}>
          <ErrorBoundary resetKey={`${route.view}/${route.projectId}`}>
            <View />
          </ErrorBoundary>
        </Suspense>
      </Shell>
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <AppProvider>
          <Routes />
        </AppProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
