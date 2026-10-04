/**
 * Thin API client.
 *
 * Every call attaches the Supabase access token as a Bearer credential. There is
 * no other way to authenticate to this API: the server verifies the JWT against
 * Supabase on every request and derives the user id from that answer alone.
 *
 * GUEST MODE
 *   A visitor who has not signed in gets the same method names answered by
 *   guestApi.js, which serves browser-local data. The branch lives here and
 *   nowhere else, so no component has to know guest mode exists and the real path
 *   stays one readable call per endpoint instead of a condition sprinkled through
 *   the UI.
 *
 *   A guest call returns before `request()` runs, so it never reaches the network:
 *   there is no token to send, and nothing here can touch `profiles` or
 *   `daily_logs`. The server is unaware guest mode exists and has no demo route.
 */
import { supabase } from './supabase.js';
import { ApiError } from './apiError.js';
import { guestStore } from './guestSession.js';
import { guestApi } from './guestApi.js';
import { resolveApiBase } from './apiBase.js';
import { fetchWithRetry } from './fetchWithRetry.js';

export { ApiError };

/**
 * Where API calls go.
 *
 * The rule lives in ./apiBase.js, which is pure and unit-tested. It used to live
 * here as a regex plus a ternary, and nothing could assert on it: api.js pulls in
 * Supabase and `import.meta.env`, so a plain Node test cannot import it. A decision
 * that caused an outage has to be reachable from a test, or it is a decision
 * nobody is checking.
 *
 * `import.meta.env.DEV` is true for `vite dev` and false for `vite build`, so any
 * built bundle always takes the absolute branch no matter how it is served.
 */
const BASE = resolveApiBase(import.meta.env.VITE_API_URL, import.meta.env.DEV);

/**
 * Mirrors the current Supabase session into the request path.
 *
 * The token is also read fresh from Supabase on every request below. That
 * redundancy is deliberate: `getSession()` is the authority, while this cached
 * value keeps the module usable if a call is made before AuthProvider mounts.
 */
let accessToken = '';

export function setAccessToken(token) {
  accessToken = typeof token === 'string' ? token : '';
}

/**
 * A 401 means the token we sent is no longer good. One retry with a freshly
 * fetched token covers the common race where Supabase refreshed the session in
 * the background between our render and this call. A second 401 is a real
 * sign-out, so it propagates and the app returns to the auth screen.
 */
async function request(path, { method = 'GET', body, signal, _isRetry = false } = {}) {
  const token = await currentToken();

  if (!token) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'You are not signed in.');
  }

  // fetchWithRetry owns the failure modes: timeout, cold-start retry, and the
  // caller's AbortSignal. A NETWORK ApiError comes out of it already shaped;
  // an AbortError passes through untouched for callers that cancel.
  const res = await fetchWithRetry({
    url: `${BASE}${path}`,
    init: {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    },
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // A non-JSON body means we probably hit the wrong path (e.g. an HTML 404
      // page from the dev server or a proxy). Surface that instead of a bare
      // "malformed response", which is impossible to act on.
      const snippet = text.trim().slice(0, 80);
      throw new ApiError(
        res.status,
        'BAD_RESPONSE',
        res.status === 404
          ? `API endpoint not found (${method} ${path}). Check that VITE_API_URL points at the API root and includes /api.`
          : `The API returned a non-JSON response (HTTP ${res.status}): ${snippet}`,
        { path, method, status: res.status }
      );
    }
  }

  if (res.status === 401 && !_isRetry) {
    // The token may have expired. Fetch a fresh one and try exactly once.
    const fresh = await supabase?.auth.getSession().then(({ data: s }) => s?.session?.access_token ?? '');
    if (fresh && fresh !== token) {
      setAccessToken(fresh);
      return request(path, { method, body, signal, _isRetry: true });
    }
  }

  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(
      res.status,
      e.code ?? 'UNKNOWN',
      e.message ?? `Request failed with status ${res.status}`,
      e.details
    );
  }

  return data;
}

/**
 * The access token for this request.
 *
 * Prefers the live Supabase session so a token refreshed in another tab (or by
 * Supabase's auto-refresh timer) is picked up without a page reload. Falls back
 * to the cached value that AuthContext mirrors.
 */
async function currentToken() {
  if (supabase) {
    try {
      const { data } = await supabase.auth.getSession();
      const live = data.session?.access_token;
      if (live) {
        if (live !== accessToken) setAccessToken(live);
        return live;
      }
      // getSession() returning nothing is authoritative: signed out.
      if (!data.session) return '';
    } catch {
      // Fall through to the cached token rather than failing the request.
    }
  }
  return accessToken;
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

/**
 * The whole public surface.
 *
 * Each entry picks its implementation first and only then decides how to call
 * it. Written out per method rather than mapped from the URL: a table keyed on
 * path strings would silently send a guest to the real server the first time an
 * endpoint's URL changed, which is a failure that only shows up in front of a
 * prospective user.
 */
const asGuest = () => guestStore.isGuest();

export const api = {
  health: () => (asGuest() ? guestApi.health() : request('/health')),

  /**
   * Wake the API before anybody needs it.
   *
   * Called once at app start — before the visitor has signed in, so it goes out
   * without a token against the public health endpoint. A sleeping instance
   * takes 30-50 seconds to boot; paying that cost while the user is still
   * reading the sign-in form means the profile fetch that follows a successful
   * login lands on a warm server instead of a cold one.
   *
   * Genuinely fire-and-forget: every failure mode is swallowed. A warm-up that
   * could surface an error would be a bug generator, not an optimization.
   * Guests skip it — they never call the real API, so waking it would be pure
   * load for nothing.
   *
   * @returns {Promise<boolean>} whether the API answered, for tests.
   */
  warmup: async () => {
    if (asGuest()) return false;
    try {
      const res = await fetchWithRetry({
        url: `${BASE}/health`,
        // The longest wait anywhere in the client: this exists precisely for
        // the case where the instance has not started yet.
        timeoutMs: 60_000,
        maxAttempts: 2,
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  profile: {
    // Takes an optional AbortSignal so the caller can cancel a fetch that a
    // newer one has superseded. The guest path is synchronous against local
    // storage and needs no signal.
    get: (signal) => (asGuest() ? guestApi.profile.get() : request('/profile', { signal })),
    update: (patch) =>
      asGuest()
        ? guestApi.profile.update(patch)
        : request('/profile', { method: 'PATCH', body: patch }),
    delete: () =>
      asGuest() ? guestApi.profile.delete() : request('/profile', { method: 'DELETE' }),
  },

  submissions: {
    today: () => (asGuest() ? guestApi.submissions.today() : request('/submissions/today')),
    create: (taskDescription, signal) =>
      asGuest()
        ? guestApi.submissions.create(taskDescription, signal)
        : request('/submissions', {
            method: 'POST',
            body: { taskDescription },
            signal,
          }),
    /**
     * Undo today's accepted submission so a better one can replace it.
     * The server refuses if the entry is not from the current UTC day — past
     * days are permanently locked.
     */
    revokeToday: () =>
      asGuest() ? guestApi.submissions.revokeToday() : request('/submissions/today', { method: 'DELETE' }),
  },

  logs: {
    list: ({ limit = 50, offset = 0 } = {}) =>
      asGuest() ? guestApi.logs.list({ limit, offset }) : request(`/logs?limit=${limit}&offset=${offset}`),
  },

  leaderboard: {
    // `signal` lets a scope toggle cancel the request it superseded.
    get: ({ filter = 'all_time', limit = 100, signal } = {}) =>
      asGuest()
        ? guestApi.leaderboard.get({ filter, limit })
        : request(`/leaderboard?filter=${filter}&limit=${limit}`, { signal }),
  },

  tiers: () => (asGuest() ? guestApi.tiers() : request('/tiers')),

  feedback: {
    submit: (feedbackType, message) =>
      asGuest()
        ? Promise.reject(new ApiError(400, 'GUEST', 'Feedback not available in guest mode.'))
        : request('/feedback', { method: 'POST', body: { feedbackType, message } }),
  },
};
