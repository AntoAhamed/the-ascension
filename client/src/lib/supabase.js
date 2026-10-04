/**
 * Supabase browser client.
 *
 * Used ONLY for authentication (sign up, sign in, Google OAuth, session
 * persistence). All data access goes through the Express API so the
 * service-role key and Gemini key stay off the client.
 *
 * A missing configuration is an error, not a degraded mode. There is no local
 * fallback identity: if this module cannot build a client, the app says so and
 * stops, because a signed-in-looking shell with no real user id behind it cannot
 * attach points, streaks, or a leaderboard row to anyone.
 */
import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

/** Values shipped in .env.example, which means "copied but never filled in". */
const PLACEHOLDERS = ['your-anon-key', 'your-project-ref', ''];

/**
 * True when real Supabase credentials are present. Both values must be non-blank
 * and not still the example placeholder.
 */
export const hasSupabaseConfig =
  Boolean(url) &&
  Boolean(anonKey) &&
  !url.includes('your-project-ref') &&
  !PLACEHOLDERS.includes(anonKey);

let client = null;

if (hasSupabaseConfig) {
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'implicit',
    },
  });
} else if (import.meta.env.DEV) {
  // Loud, but non-fatal in development: the app renders a configuration panel
  // explaining exactly what to set, which is more useful than a blank screen.
  console.error(
    '[supabase] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in client/.env.\n' +
      '          Authentication is disabled and the app cannot sign anyone in.'
  );
}

/**
 * Explains the misconfiguration.
 *
 * Returns a short human-readable string, or null when the configuration is fine.
 * `throwOnError` is for the production path, where a build without credentials is
 * a deployment mistake that should be loud rather than quietly broken.
 */
export function assertSupabaseConfigured({ throwOnError = false } = {}) {
  if (hasSupabaseConfig) return null;

  const missing = [];
  if (!url) missing.push('VITE_SUPABASE_URL');
  else if (url.includes('your-project-ref')) missing.push('VITE_SUPABASE_URL (still the placeholder)');
  if (!anonKey) missing.push('VITE_SUPABASE_ANON_KEY');
  else if (PLACEHOLDERS.includes(anonKey)) missing.push('VITE_SUPABASE_ANON_KEY (still the placeholder)');

  const message = `Supabase is not configured. Set ${missing.join(' and ')} in client/.env, then restart the dev server. See client/.env.example.`;

  if (throwOnError) throw new Error(message);
  return message;
}

/** @type {import('@supabase/supabase-js').SupabaseClient|null} */
export const supabase = client;

/** Guard used by every auth call, so an unconfigured build fails clearly. */
function requireClient() {
  if (!supabase) {
    throw new Error(assertSupabaseConfigured() ?? 'Supabase is not configured');
  }
  return supabase;
}

/**
 * Google OAuth.
 *
 * Requires the provider to be enabled in Supabase -> Authentication -> Providers,
 * with your production redirect URL whitelisted.
 *
 * WHY REDIRECTS TO "/" AND NOT A DEDICATED CALLBACK PATH
 *   The client is built with flowType 'implicit' and detectSessionInUrl: true, so
 *   supabase-js reads the tokens out of the URL fragment itself, during
 *   initialisation, before any component renders. The landing page therefore does
 *   no work at all — it just has to be a page that loads the app.
 *
 *   Pointing this at a path like /auth/callback only works if the static host is
 *   configured to rewrite unknown paths to index.html. One that is not (or a local
 *   open of a deep link in a fresh tab) returns a 404, and the visitor lands on an
 *   error page having already authenticated. The root exists on every host.
 */
export async function signInWithGoogle() {
  const { error } = await requireClient().auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}`,
      // No queryParams: `prompt=consent` forces the Google account chooser on
      // every single sign-in, which is both slow and confusing for a returning
      // user who just wanted to log in.
    },
  });
  if (error) throw error;
}

export async function signInWithEmail(email, password) {
  const { error } = await requireClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUpWithEmail(email, password, username) {
  const { data, error } = await requireClient().auth.signUp({
    email,
    password,
    options: {
      // Read by the handle_new_user() trigger to pre-fill the username.
      data: { username, email },
    },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function onAuthStateChange(handler) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    handler(event, session);
  });
  return () => data.subscription.unsubscribe();
}
