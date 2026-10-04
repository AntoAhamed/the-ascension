/**
 * Which browser origins may call the API.
 *
 * WHY THIS IS A SEPARATE MODULE
 *   It is pure — no dotenv, no process.env, no Express — because the interesting
 *   part is the edge cases, and edge cases are only testable if they can be handed
 *   a string and asked a question. Keeping the matcher free of the config module
 *   also keeps the security-relevant rule readable in one screen.
 *
 * THE PROBLEM IT SOLVES
 *   CORS_ORIGIN is a static list. The client's origin in development is not static:
 *   Vite picks it at runtime, and if 5173 happens to be busy it silently takes
 *   5174. The API then rejects the app's own requests with a 403 that carries no
 *   Access-Control-Allow-Origin, which the browser reports as
 *
 *     "blocked by CORS policy ... No 'Access-Control-Allow-Origin' header"
 *
 *   Nothing in that message mentions ports, so the cause is invisible from where
 *   the symptom appears. Worse, the browser discards the body of a *preflight*
 *   response, so even the server's careful 403 payload never reaches the
 *   developer. The only place the information can exist is the server log — see
 *   index.js, which logs the refused origin for that reason.
 *
 *   Two independent fixes remove that whole class of failure, and neither is this
 *   function:
 *     - the client prefers a same-origin request in development, via the Vite
 *       proxy, so a browser never applies CORS to local work at all;
 *     - vite.config.js sets strictPort, so a port collision fails loudly at
 *       startup instead of silently moving the app.
 *   This is the third line: if the port shifts anyway — a `vite --port` override,
 *   a preview build, strictPort removed — local development keeps working instead
 *   of breaking mysteriously.
 *
 * WHY DEVELOPMENT ONLY
 *   In production the client origin is a real deployed hostname, and the existing
 *   validation in env.js refuses wildcards and plaintext http there. A blanket
 *   "any localhost port is fine" rule is appropriate for a developer's own
 *   machine and has no business reaching a deployed server. Note that CORS is not
 *   an authorization mechanism either way: every data route independently requires
 *   a verified Supabase JWT, so this widens who can *attempt* a call, not who can
 *   make one.
 */

/** The range Vite can hand out for a dev server when 5173 is taken. */
export const DEV_CLIENT_PORT_MIN = 5173;
export const DEV_CLIENT_PORT_MAX = 5199;

/**
 * Loopback hostnames, as they appear in a URL.
 *
 * `[::1]` is bracketed because that is how `new URL().hostname` renders an IPv6
 * literal — verified, not assumed. The bare `::1` form is unreachable: an
 * unbracketed IPv6 host makes `new URL()` throw outright, so it is deliberately
 * absent rather than listed and never matched.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * True for an origin that is plausibly this project's local dev server.
 *
 * Deliberately narrow. It requires http (Vite's dev server is not https), a
 * loopback host, and a port inside Vite's dev range. A hostname like
 * `localhost.evil.com` is not in the loopback set, so it is rejected — the check
 * is set membership on the parsed hostname, never a substring test on the whole
 * origin, because `includes('localhost')` would happily accept that.
 */
export function isDevClientOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') return false;

  let url;
  try {
    url = new URL(origin);
  } catch {
    // "null", "*", and a bare "::1" host. Not a dev server.
    return false;
  }

  // The string must be a bare, canonical origin — nothing appended. This rejects
  // "http://localhost:5173/evil" and "http://localhost:5173/", which parse fine
  // and would otherwise sail through on host and port alone. No browser ever sends
  // an Origin with a path, so the only inputs this discards are ones that cannot
  // legitimately occur; accepting them would only mean the function's contract was
  // "roughly an origin" rather than "an origin".
  if (url.origin !== origin) return false;

  if (url.protocol !== 'http:') return false;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;

  // An origin with no explicit port is port 80 for http, which is not in range.
  const port = url.port === '' ? 80 : Number(url.port);
  if (!Number.isInteger(port)) return false;

  return port >= DEV_CLIENT_PORT_MIN && port <= DEV_CLIENT_PORT_MAX;
}

/**
 * The one place an origin decision is made, so the log line and the 403 body can
 * never disagree about why something was refused.
 *
 * Returns true when the request may proceed. `allowedOrigins` is checked first, so
 * an explicitly configured origin always wins over the development fallback.
 */
export function isOriginAllowed(origin, { allowedOrigins, isProd }) {
  // No Origin header at all: curl, the health check, the cron endpoint. Not a
  // browser, so CORS does not apply and the browser cannot be the vector.
  if (!origin) return true;

  if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) return true;

  return !isProd && isDevClientOrigin(origin);
}

/**
 * An explanation aimed at whoever has to fix this, phrased for the server log.
 *
 * Returned rather than logged here because this module has no business writing to
 * stdout — and because the same text is worth asserting on in a test. Says what
 * was refused and what to do, because the browser's version of this message names
 * neither.
 */
export function explainOriginRejection(origin, { allowedOrigins = [], isProd = false } = {}) {
  const allowed = allowedOrigins.length ? allowedOrigins.join(', ') : '(none configured)';
  const looksLocal = isDevClientOrigin(origin);

  const lines = [
    `CORS refused the origin "${origin}".`,
    `  allowed: ${allowed}`,
  ];

  if (looksLocal) {
    lines.push(
      '  That looks like this project\'s own dev server, so the client is almost certainly on a',
      '  port outside Vite\'s dev range, or CORS_ORIGIN is set for a different port. Add the port',
      '  you are actually on to CORS_ORIGIN in server/.env, comma-separated.'
    );
  } else if (!isProd) {
    lines.push(
      '  In development, only loopback origins inside Vite\'s port range are accepted',
      `  (${DEV_CLIENT_PORT_MIN}-${DEV_CLIENT_PORT_MAX}). Anything else must be listed in CORS_ORIGIN.`
    );
  }

  lines.push(
    '  The browser hides this body for preflight requests, so this log line is the only place the',
    '  reason will ever appear.'
  );

  return lines.join('\n');
}
