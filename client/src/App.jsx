import { lazy, Suspense, useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { GuestBanner } from './components/GuestBanner.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { useAuth } from './context/AuthContext.jsx';
import { LoadingPanel } from './components/ui/Spinner.jsx';
import { useDocumentTitle } from './hooks/useDocumentTitle.js';
import { api } from './lib/api.js';

/**
 * The signed-out screen is deferred. It is a mutually exclusive branch with the
 * dashboard — nobody is ever looking at both — and the overwhelmingly common
 * case is a returning user with a session, who would otherwise download it to
 * throw it away. Splitting on the auth branch means each visitor fetches only
 * the half they actually get.
 *
 * Dashboard stays a static import on purpose: it is the landing view, and
 * deferring it would put a network round trip in front of the first paint of
 * the page people came for.
 */
const AuthScreen = lazy(() =>
  import('./components/AuthScreen.jsx').then((m) => ({ default: m.AuthScreen }))
);

/**
 * Root component: gates the app on auth, and manages the active tab.
 *
 * This is a single-page app with tab state rather than a router — the four
 * sections share all their data and switching between them should feel
 * instant, without remounting and refetching.
 */
export default function App() {
  const { canExplore, isGuest, loading } = useAuth();
  const [tab, setTab] = useState('dashboard');

  // Wake the API as soon as the app starts. A free-tier host sleeps when idle,
  // and the boot takes 30-50 seconds — by the time the visitor has read the
  // sign-in form and submitted it, the server should be answering. Silent and
  // failure-proof: nothing here can surface to the UI.
  useEffect(() => {
    api.warmup();
  }, []);

  // The signed-out and still-authenticating screens have no status to report, so
  // the title stays the plain marketing one. Once the dashboard mounts it takes
  // over with the live state.
  useDocumentTitle({ authenticated: canExplore && !loading });

  // Reset to the dashboard when the user signs in fresh.
  useEffect(() => {
    if (canExplore) setTab('dashboard');
  }, [canExplore]);

  if (loading) {
    return (
      <>
        <div className="grid min-h-screen place-items-center">
          <LoadingPanel label="Waking the judge…" />
        </div>
        <Analytics />
      </>
    );
  }

  if (!canExplore) {
    return (
      <>
        <Suspense
          fallback={
            <div className="grid min-h-screen place-items-center">
              <LoadingPanel label="Loading…" />
            </div>
          }
        >
          <AuthScreen />
        </Suspense>
        <Analytics />
      </>
    );
  }

  return (
    <>
      {isGuest && <GuestBanner />}
      <Dashboard tab={tab} onTabChange={setTab} />
      <Analytics />
    </>
  );
}
