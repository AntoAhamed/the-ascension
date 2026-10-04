import { useState } from 'react';
import { m } from 'framer-motion';
import { ArrowRight, Eye, Flame, KeyRound, Mail, Zap } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { hasSupabaseConfig, signInWithGoogle } from '../lib/supabase.js';
import { Spinner } from './ui/Spinner.jsx';

const MODES = { login: 'Sign in', signup: 'Create account' };

/**
 * Auth screen: email/password + Google OAuth.
 *
 * Both paths are real Supabase Auth. When the project is not configured the
 * screen shows exactly which environment variables are missing and offers no way
 * past it — a form that accepted any credentials would be a way to reach a
 * dashboard with no user behind it.
 */
export function AuthScreen() {
  const { signIn, signUp, configError, enterGuest, authIntent } = useAuth();

  // The guest banner's "Create account" button exits guest mode with a signup
  // intent, so this screen opens on the form that matches what they asked for.
  const [mode, setMode] = useState(authIntent);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (!email || !password) {
      setError('Enter your email and password.');
      return;
    }
    if (mode === 'signup' && username.trim().length < 3) {
      setError('Pick a username of at least 3 characters.');
      return;
    }
    if (password.length < 6) {
      setError('Passwords must be at least 6 characters.');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'login') {
        await signIn(email, password);
      } else {
        const { data, error: signUpError } = await signUp(email, password, username.trim());
        if (signUpError) throw signUpError;
        // Supabase may require email confirmation before a session exists.
        if (!data?.session) {
          setNotice('Check your inbox to confirm your email, then sign in.');
          setMode('login');
        }
      }
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    setError(null);
    setGoogleBusy(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(friendlyAuthError(err));
      setGoogleBusy(false);
    }
  };

  const canUseGoogle = hasSupabaseConfig;
  // Without credentials every submit would throw from requireClient(). Disable the
  // controls instead, so the notice above is the only thing the user has to read
  // rather than something they discover by clicking a button.
  const authUnavailable = Boolean(configError);

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
      {/* Background grid + drifting orbs */}
      <div className="pointer-events-none absolute inset-0 bg-grid-fade bg-grid [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
      <m.div
        className="pointer-events-none absolute -left-32 top-1/4 h-72 w-72 rounded-full bg-neon-cyan/10 blur-3xl"
        animate={{ x: [0, 40, 0], y: [0, -30, 0] }}
        transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
      />
      <m.div
        className="pointer-events-none absolute -right-32 bottom-1/4 h-72 w-72 rounded-full bg-neon-violet/10 blur-3xl"
        animate={{ x: [0, -40, 0], y: [0, 30, 0] }}
        transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative w-full max-w-md">
        <m.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="panel p-7 sm:p-8"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-neon-cyan/60 to-transparent" />

          {/* Brand */}
          <div className="text-center">
            <m.div
              animate={{ y: [0, -5, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-neon-cyan/30 bg-neon-cyan/10"
            >
              <Zap size={26} className="text-neon-cyan" />
            </m.div>
            <h1 className="mt-5 font-display text-3xl font-black tracking-tight text-white">
              THE <span className="text-gradient">ASCENSION</span>
            </h1>
            <p className="mt-1.5 flex items-center justify-center gap-1.5 text-sm text-slate-400">
              <Flame size={13} className="text-neon-amber" />
              One task a day. Seven tiers. Zero excuses.
            </p>
          </div>

          {/* Unconfigured-build notice. This replaces what used to be a demo
              entry point: without credentials the app cannot authenticate
              anyone, so it says so instead of offering a way around it. */}
          {configError && (
            <div className="mt-6 rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3">
              <p className="text-xs leading-relaxed text-rose-200">
                <strong>Sign-in is unavailable.</strong> This build has no Supabase credentials, so
                no one can be authenticated. Add{' '}
                <code className="rounded bg-black/30 px-1 py-0.5 text-[10px]">
                  VITE_SUPABASE_URL
                </code>{' '}
                and{' '}
                <code className="rounded bg-black/30 px-1 py-0.5 text-[10px]">
                  VITE_SUPABASE_ANON_KEY
                </code>{' '}
                to <code className="rounded bg-black/30 px-1 py-0.5 text-[10px]">client/.env</code>{' '}
                and restart the dev server.
              </p>
            </div>
          )}

          {/* Google */}
          {canUseGoogle && (
            <button
              onClick={handleGoogle}
              disabled={googleBusy || authUnavailable}
              className="btn-ghost mt-6 w-full bg-white/[0.05] py-3"
            >
              {googleBusy ? (
                <Spinner size={16} />
              ) : (
                <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden>
                  <path
                    fill="#4285F4"
                    d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.8c1.8 0 3.3.6 4.5 1.8l3.4-3.4A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"
                  />
                </svg>
              )}
              Continue with Google
            </button>
          )}

          {canUseGoogle && (
            <div className="my-6 flex items-center gap-3">
              <span className="h-px flex-1 bg-white/10" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">
                or
              </span>
              <span className="h-px flex-1 bg-white/10" />
            </div>
          )}

          {/* Email form */}
          <form onSubmit={handleSubmit} className={canUseGoogle ? '' : 'mt-6'}>
            {mode === 'signup' && (
              <div className="mb-3.5">
                <label htmlFor="auth-username" className="mb-1.5 block text-xs font-semibold text-slate-400">
                  Username
                </label>
                <input
                  id="auth-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20))}
                  placeholder="your_name"
                  autoComplete="username"
                  className="field"
                />
              </div>
            )}

            <div className="mb-3.5">
              <label htmlFor="auth-email" className="mb-1.5 block text-xs font-semibold text-slate-400">
                Email
              </label>
              <div className="relative">
                <Mail
                  size={15}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-600"
                />
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="field pl-10"
                />
              </div>
            </div>

            <div>
              <label htmlFor="auth-password" className="mb-1.5 block text-xs font-semibold text-slate-400">
                Password
              </label>
              <div className="relative">
                <KeyRound
                  size={15}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-600"
                />
                <input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  className="field pl-10"
                />
              </div>
            </div>

            {error && (
              <m.p
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-3.5 rounded-lg border border-rose-400/25 bg-rose-500/[0.08] px-3 py-2 text-xs leading-relaxed text-rose-200"
              >
                {error}
              </m.p>
            )}
            {notice && (
              <m.p
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-3.5 rounded-lg border border-emerald-400/25 bg-emerald-500/[0.08] px-3 py-2 text-xs text-emerald-200"
              >
                {notice}
              </m.p>
            )}

            <button
              type="submit"
              disabled={busy || authUnavailable}
              className="btn-primary mt-5 w-full"
            >
              {busy ? (
                <>
                  <Spinner size={16} />
                  Just a moment…
                </>
              ) : (
                <>
                  {MODES[mode]}
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          <p className="mt-5 text-center text-xs text-slate-500">
            {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}{' '}
            <button
              onClick={() => {
                setMode(mode === 'login' ? 'signup' : 'login');
                setError(null);
                setNotice(null);
              }}
              className="font-semibold text-neon-cyan transition-colors hover:text-cyan-300"
            >
              {mode === 'login' ? 'Create one' : 'Sign in'}
            </button>
          </p>

          {/* Guest mode.

              Offered last and visually secondary on purpose: it is a preview, not
              the path the product wants anyone on. Nothing below it requires an
              account, and nothing here creates one.

              Unlike the form above, this works even when Supabase is
              unconfigured. Guest data never leaves the browser, so there is
              nothing for the missing credentials to block. */}
          <div className="mt-6 border-t border-white/[0.07] pt-5">
            <button
              onClick={enterGuest}
              className="btn-ghost w-full"
              data-testid="enter-guest"
            >
              <Eye size={15} aria-hidden="true" />
              Explore as guest
            </button>
            <p className="mt-2.5 text-center text-[11px] leading-relaxed text-slate-600">
              Browse the full app with sample data. Nothing is saved, and you won&apos;t be
              on the leaderboard.
            </p>
          </div>
        </m.div>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-slate-600">
          Scored by Gemini. Streaks decay at UTC midnight.
          <br />
          One primary achievement per day.
        </p>
      </div>
    </div>
  );
}

/** Turns Supabase's terse auth errors into something actionable. */
function friendlyAuthError(err) {
  const msg = String(err?.message ?? err ?? '');

  // Surfaces as raw JSON today: `{"code":400,"error_code":"validation_failed",
  // "msg":"Unsupported provider: provider is not enabled"}`. Google is never even
  // contacted — Supabase rejects the call because the provider is switched off in
  // the project, which is a dashboard setting and cannot be fixed from the client.
  // Saying so is the whole difference between a dead end and a fix.
  if (/provider is not enabled|unsupported provider/i.test(msg)) {
    return 'Google sign-in is not enabled on this project. An administrator must turn it on in Supabase → Authentication → Providers → Google, then add this site\'s URL under Redirect URLs.';
  }
  if (/invalid login credentials/i.test(msg)) return 'That email and password combination is incorrect.';
  if (/email not confirmed/i.test(msg)) return 'Confirm your email first — check your inbox.';
  if (/user already registered/i.test(msg)) return 'An account with that email already exists. Try signing in.';
  if (/password should be at least/i.test(msg)) return 'Passwords must be at least 6 characters.';
  if (/rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';
  if (/fetch|network/i.test(msg)) return 'Could not reach the authentication service.';
  return msg || 'Something went wrong. Please try again.';
}