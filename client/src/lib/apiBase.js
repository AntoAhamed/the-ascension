/**
 * Which URL the browser should send API calls to.
 *
 * Pure and dependency-free on purpose: no `import.meta.env`, no Supabase, no
 * fetch. That is what lets it be imported and exercised by a plain Node test,
 * which matters because this rule caused a production-blocking outage and a
 * source-text assertion cannot protect it. An earlier version of the test asserted
 * only that the identifier `LOCAL_API` appeared in api.js; a mutation that kept the
 * name and inverted the rule passed that test cleanly. Behaviour has to be
 * asserted by calling the thing, not by grepping for its name.
 *
 * THE RULE
 *   Three cases, and the middle one is the point:
 *
 *     development + local API   ->  '/api'  (relative; the Vite dev server proxies it)
 *     development + remote API  ->  the absolute URL, unchanged
 *     production, anything      ->  the absolute URL if configured, else '/api'
 *
 * WHY DEVELOPMENT + LOCAL IS RELATIVE
 *   Vite.config.js proxies /api to the API, so a relative request is same-origin
 *   and the browser never applies CORS to it at all. That removes the entire class
 *   of failure where a dev port shift, or a stale CORS_ORIGIN, breaks the app's own
 *   requests — the failure that produced a login screen which could not reach its
 *   own API while reporting nothing but "No 'Access-Control-Allow-Origin' header".
 *
 * WHY DEVELOPMENT + REMOTE IS *NOT* RELATIVE
 *   Pointing VITE_API_URL at a deployed API is a deliberate choice to talk to
 *   another host. Silently redirecting that at whatever happens to be listening on
 *   localhost:4000 would be worse than the CORS prompt it replaces: it would send
 *   real credentials somewhere the developer did not choose. The cost is that the
 *   remote origin must be listed in CORS_ORIGIN, which is a documented,
 *   one-line consequence rather than a mystery.
 */

/**
 * Matches a URL pointing at this machine: a local API rather than a deployed one.
 *
 * Both loopback spellings Vite and a developer may use, with or without a port and
 * with or without a trailing /api. Anchored at both ends, and the hostname is a
 * closed alternation rather than a substring, so 'localhost.evil.com' and
 * 'notlocalhost' do not match.
 */
const LOCAL_API = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/api)?$/i;

/** True when `rawBase` names an API on this machine. */
export function isLocalApiUrl(rawBase) {
  return LOCAL_API.test(String(rawBase ?? '').trim());
}

/**
 * Normalise a configured base into a canonical absolute API root, or '' if unset.
 *
 * Tolerant about the trailing /api, because both spellings are reasonable and the
 * codebase has shipped a 404 from getting it wrong: 'https://api.example.com' and
 * 'https://api.example.com/api' must both resolve to
 * 'https://api.example.com/api'.
 */
export function normalizeApiBase(rawBase) {
  const trimmed = String(rawBase ?? '').trim().replace(/\/+$/, '');
  return trimmed ? `${trimmed.replace(/\/api$/, '')}/api` : '';
}

/**
 * @param {string} rawBase   the configured VITE_API_URL; '' or undefined when unset
 * @param {boolean} isDev    true for `vite dev`, false for any built bundle
 * @returns {string} an absolute API root, or the relative '/api'
 */
export function resolveApiBase(rawBase, isDev) {
  const absolute = normalizeApiBase(rawBase);

  if (isDev && isLocalApiUrl(rawBase)) return '/api';

  // Same-origin deployment: the API is served behind the same host, so a relative
  // path is correct and no configuration is needed.
  return absolute || '/api';
}
