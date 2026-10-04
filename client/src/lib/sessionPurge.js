/**
 * Erasing this app's traces from the browser.
 *
 * WHY A SEPARATE MODULE
 *   Two flows need the same thing — signing out, and deleting an account — and
 *   both need it to be complete. Keeping the key list here rather than inline in
 *   AuthContext means it can be asserted directly (see scripts/test-session-
 *   teardown.mjs) instead of only being observable by signing out of a real app
 *   and inspecting devtools.
 *
 * WHY IT EXISTS AT ALL
 *   Ending the session is only half the job, and the half that is easy to miss.
 *   Supabase persists its tokens in localStorage, so clearing React state while
 *   leaving that key in place means the *next* page load silently
 *   re-authenticates from disk. After an account deletion that is exactly the
 *   reported failure: DELETE /api/profile succeeds, the app navigates, the fresh
 *   page reads the surviving token, calls GET /api/profile for a user that no
 *   longer exists, gets a 401, and renders "Could not reach the API" instead of
 *   the sign-in screen.
 *
 *   So: no token on disk, no token in memory, no trace on the next load.
 *
 * PREFIXES, NOT EXACT KEYS
 *   Supabase's storage key embeds the project ref (`sb-<project-ref>-auth-token`),
 *   which is not knowable from application code, and its PKCE verifier keys are
 *   siblings of it. Matching the `sb-` prefix catches the whole family including
 *   anything a future supabase-js version adds. The two `asc`/`ascension`
 *   prefixes cover everything this app writes, so a key added later is covered
 *   by default rather than by remembering to update a list.
 *
 *   Deliberately does not call storage.clear(). That would also delete keys
 *   belonging to anything else served from the same origin, which is not this
 *   module's business.
 */
import { GUEST_STORAGE_KEY } from './guestSession.js';

/**
 * Every storage key whose contents belong to this session.
 *
 * `ascension.` covers the guest session (GUEST_STORAGE_KEY is asserted to match,
 * so renaming it without updating this is a test failure rather than a silently
 * orphaned key). `asc.` covers app preferences. `sb-` covers Supabase auth.
 */
export const SESSION_KEY_PREFIXES = ['sb-', 'asc.', 'ascension.'];

/**
 * True if a storage key holds this session's data.
 *
 * Exported because "is this key mine?" is the whole decision, and it is the part
 * worth testing: a prefix list that over-matches destroys data it does not own,
 * and one that under-matches leaves a live token on disk.
 */
export function isSessionKey(key, prefixes = SESSION_KEY_PREFIXES) {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

/**
 * Remove every session key from localStorage.
 *
 * @param {Storage|null} storage injectable, so the behaviour can be tested
 *   without a DOM and a browser that refuses localStorage degrades to a no-op
 *   instead of throwing.
 * @returns {{ removed: string[], kept: string[] }} what was removed and what was
 *   left alone. Reported rather than returned silently: a key that survived a
 *   deletion is the exact bug this module exists to prevent, so the caller can
 *   log it.
 */
export function purgeBrowserSession(storage = defaultStorage()) {
  const removed = [];
  const kept = [];

  if (!storage) return { removed, kept };

  try {
    // Snapshot first: removing while iterating a live Storage is implementation-
    // defined, and the skipped key would be a token left on disk.
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }

    for (const key of keys) {
      if (isSessionKey(key)) {
        storage.removeItem(key);
        removed.push(key);
      } else {
        kept.push(key);
      }
    }
  } catch {
    // Private-mode Safari and locked-down browsers throw on access, not just on
    // use. The redirect still happens; there is nothing better to do here.
    return { removed, kept };
  }

  return { removed, kept };
}

/** localStorage, or null when it is unavailable or throws on access. */
function defaultStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export { GUEST_STORAGE_KEY };