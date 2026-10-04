import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { setAccessToken } from '../lib/api.js';
import { guestStore } from '../lib/guestSession.js';
import { purgeBrowserSession } from '../lib/sessionPurge.js';
import {
  assertSupabaseConfigured,
  hasSupabaseConfig,
  onAuthStateChange,
  signInWithEmail,
  signOut as supabaseSignOut,
  signUpWithEmail,
  supabase,
} from '../lib/supabase.js';

/**
 * Where the app sends you once a session is over.
 *
 * A FULL page load, not a client-side route change. Every component still mounted
 * at that moment has an in-flight request behind it, a midnight resync timer, or
 * both; unmounting them by hand means auditing every one. Replacing the document
 * discards the whole tree at once, which is the only version of this that cannot
 * leave a request running against a session that no longer exists.
 *
 * WHY /login RATHER THAN "/"
 *   Neither path is a route — this app decides between the auth screen and the
 *   dashboard from session state, not from the URL — so the app would render the
 *   sign-in screen at either one. /login is here because it says what the user is
 *   looking at, and so that a signed-out URL stays recognisable in history and in
 *   a shared tab.
 *
 *   The cost is a deployment requirement, and it is the same one Google OAuth
 *   already has (see the note on redirectTo in lib/supabase.js): the static host
 *   must serve index.html for unknown paths, or /login 404s instead of loading
 *   the app. Vite's dev server does this by default. On a host that does not,
 *   change this constant to '/' — nothing else depends on the value.
 */
const SIGNED_OUT_PATH = '/login';

/**
 * How long the teardown will wait for Supabase to revoke the refresh token.
 *
 * Bounded on purpose, and the reason is not politeness but correctness. Signing
 * out makes a network call, and a browser on a slow, captive, offline or
 * firewalled connection will leave that promise pending for a very long time. An
 * unbounded await means the purge and the redirect behind it never happen, which
 * is the whole bug this function exists to fix: the token stays in localStorage,
 * the next load re-authenticates, and a user who just deleted their account gets
 * the "Could not reach the API" screen instead of the sign-in form.
 *
 * Waiting longer would not help even on a healthy connection, because the
 * navigation on the last line aborts any request still in flight. So there is
 * nothing to trade the bound away for: the fast case still gets its revocation,
 * and the slow case stops hanging.
 */
const SIGNOUT_GRACE_MS = 2000;

/**
 * Auth state for the whole app.
 *
 * The source of truth is Supabase, plus one extra thing that is deliberately NOT
 * authentication: `isGuest`. A guest has no identity. They get browser-local data
 * and a fully explorable UI, and there is no code path from the guest store to
 * the API or the database. It is tracked separately from `session` precisely so
 * it can never be mistaken for a signed-in user, and so `isAuthenticated` keeps
 * meaning exactly one thing: a verified Supabase JWT exists.
 *
 * If the project is not configured, `configError` is set and the app renders a
 * configuration error rather than pretending to be signed in.
 */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Read straight from the store rather than mirrored into state: lib/api.js
  // consults the store on every request, and two copies of one flag is one too
  // many. The re-render that puts the banner on screen comes from the
  // subscription below.
  const [isGuest, setIsGuest] = useState(() => guestStore.isGuest());

  // True when the build is missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
  // In production this is a hard failure; in development it is a warning and
  // the sign-in screen explains what to fix.
  const [configError, setConfigError] = useState(() =>
    hasSupabaseConfig ? null : assertSupabaseConfigured()
  );

  useEffect(() => guestStore.subscribe((state) => setIsGuest(state !== null)), []);

  /**
   * Which form the auth screen should open on. 'signup' is how the guest
   * banner's call to action sends someone to create an account instead of asking
   * them to sign into one they do not have.
   */
  const [authIntent, setAuthIntent] = useState('login');

  /**
   * Leaves guest mode and returns to the auth screen.
   *
   * Accepts `{ intent: 'signup' | 'login' }`.
   */
  const exitGuest = useCallback(({ intent = 'login' } = {}) => {
    guestStore.stop();
    setAuthIntent(intent);
    setIsGuest(false);
  }, []);

  const enterGuest = useCallback(() => {
    guestStore.start();
    setAuthIntent('login');
    setIsGuest(true);
  }, []);

  /**
   * Ends the session completely and leaves the page.
   *
   * The single teardown path for both signing out and deleting an account.
   * Duplicating it across those two flows is how they drift: the delete flow
   * needs the same sequence for exactly the same reasons, and it is the one that
   * has to be right about storage because a deleted account is the case where a
   * surviving token is worst.
   *
   * THE ORDER IS THE FIX, not an incidental detail:
   *
   *   1. React state + the cached token. lib/api.js reads that token on every
   *      request, so clearing it makes any request issued from here on fail fast
   *      instead of reaching a server that no longer knows this user.
   *
   *   2. Storage, purged immediately, before any network call. From this instant
   *      there is no credential on disk, whatever the network does next.
   *
   *   3. Ask Supabase to revoke the refresh token, bounded by SIGNOUT_GRACE_MS.
   *      This is the only step that can block, so it is the only step allowed to.
   *
   *   4. Storage purged again. supabase-js writes to localStorage as part of
   *      signing out, so the purge in step 2 can be undone by the very call that
   *      follows it. Purging last means the last writer is the one that erases.
   *
   *   5. Full document load at SIGNED_OUT_PATH. This also aborts the sign-out
   *      request if step 3 timed out, which is the real backstop behind the bound.
   *
   * Nothing after step 1 is allowed to throw. A teardown that gives up halfway
   * leaves the user in a state that looks signed out and is not, which is harder
   * to recover from than never having started.
   */
  const endSession = useCallback(async () => {
    setUser(null);
    setSession(null);
    setAccessToken('');
    guestStore.stop();
    purgeBrowserSession();

    // Racing a timeout rather than a bare catch: a rejected request is quick and
    // handled, but a request that never settles is not an error at all and would
    // be indistinguishable from success if only exceptions were caught.
    await Promise.race([
      supabaseSignOut().catch(() => undefined),
      new Promise((resolveTimer) => setTimeout(resolveTimer, SIGNOUT_GRACE_MS)),
    ]);

    purgeBrowserSession();
    window.location.href = SIGNED_OUT_PATH;
  }, []);

  useEffect(() => {
    if (!hasSupabaseConfig) {
      setLoading(false);
      return undefined;
    }

    let active = true;

    // Establish the initial session before rendering protected routes.
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      // A real identity supersedes guest data. Clearing it here is what stops a
      // guest's sample points from surviving into a real account's session and
      // briefly rendering someone else's history.
      if (data.session) guestStore.stop();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
      if (data.session?.access_token) setAccessToken(data.session.access_token);
      setLoading(false);
    });

    const unsubscribe = onAuthStateChange((event, nextSession) => {
      if (!active) return;
      if (nextSession) guestStore.stop();
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setAccessToken(nextSession?.access_token ?? '');
      if (event === 'SIGNED_OUT') setAccessToken('');
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo(
    () => ({
      session,
      user,
      loading,
      isAuthenticated: Boolean(user),
      /** True while exploring with no account. Not an identity — see above. */
      isGuest,
      /** True when the app should render the app rather than the auth screen. */
      canExplore: Boolean(user) || isGuest,
      /** Which form AuthScreen should open on: 'login' | 'signup'. */
      authIntent,
      /** Set when the build is missing Supabase credentials. See lib/supabase.js. */
      configError,
      /**
       * Supabase requires email confirmation before password sign-in works.
       * Always true now that a missing config is reported through `configError`
       * instead of a fake session.
       */
      signupNeedsConfirmation: true,

      enterGuest,
      exitGuest,

      /**
       * End the session and leave the page.
       *
       * Replaces the previous `signOut()`. That version cleared React state and
       * left the token sitting in localStorage, so the very next page load
       * re-authenticated from disk — which is what turned a successful account
       * deletion into a "Could not reach the API" screen. It also had a second
       * problem for guests: it branched on `guestStore.isGuest()`, so signing out
       * of a preview returned to the auth screen without a redirect and without
       * clearing storage. One path, no branch.
       *
       * Note the request itself is NOT here. Deleting an account is an API call
       * (api.profile.delete()), and it belongs to the caller, because it needs a
       * live token — which means it has to happen *before* this runs, not after.
       */
      endSession,

      async signIn(email, password) {
        // Leaving guest mode first means a failed sign-in leaves the visitor
        // where they were, rather than half-converted.
        const result = await signInWithEmail(email, password);
        exitGuest();
        return result;
      },

      async signUp(email, password, username) {
        const result = await signUpWithEmail(email, password, username);
        // Sign-up may not produce a session yet (email confirmation), so this
        // clears guest mode unconditionally rather than waiting for one.
        exitGuest();
        return result;
      },
    }),
    [session, user, loading, isGuest, configError, authIntent, enterGuest, exitGuest, endSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}