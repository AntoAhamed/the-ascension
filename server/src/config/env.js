/**
 * Environment loading + validation.
 *
 * Fails fast and loudly. Every value the server needs to reach Postgres, verify
 * a JWT, and call Gemini is mandatory — there is no fallback path and no
 * degraded mode, because a half-configured server does not degrade, it produces
 * 500s much later that look like application bugs.
 *
 * The rule is deliberately strict: a missing or blank credential stops the boot
 * rather than surfacing as a runtime error. A server that starts and then fails
 * per-request is far harder to diagnose than one that refuses to start.
 */
import 'dotenv/config';

const raw = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  cronSecret: process.env.CRON_SECRET ?? '',
};

/** Values shipped in .env.example. A file copied but never filled in is a config bug. */
const PLACEHOLDERS = ['your-anon-key', 'your-service-role-key', 'your-gemini-api-key'];

/**
 * The explicit CORS allowlist. Comma-separated; spaces are trimmed.
 *
 * This is not the whole story in development: config/origins.js additionally
 * accepts any loopback origin inside Vite's dev port range, because the dev
 * client's origin is chosen by Vite at runtime rather than by us. Production has
 * no such fallback — validateConfig() rejects wildcards there — so a deployed
 * client must be listed explicitly, which is correct, since its origin is a fixed
 * hostname we chose.
 */
const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

export const config = Object.freeze({
  ...raw,
  isProd: raw.nodeEnv === 'production',
  // Trailing slashes are stripped, not trusted: the browser's Origin header
  // never has one, so 'https://app.vercel.app/' in an env var would silently
  // match nothing — a CORS wall that looks configured. Normalising here makes
  // the forgiving thing happen at the boundary instead of per request.
  allowedOrigins: corsOrigin
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
});

/**
 * Collect human-readable problems with the current configuration.
 * Returns an array — empty means good to go.
 */
export function validateConfig() {
  const problems = [];

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    problems.push(`PORT must be a valid port number, received "${process.env.PORT}"`);
  }

  // --- Mandatory: the app cannot function without these ---------------------
  // `isPlaceholder` treats blank and placeholder alike, because both mean the
  // value was never filled in.
  const isPlaceholder = (v) => !v || v.trim() === '' || PLACEHOLDERS.includes(v.trim());

  if (isPlaceholder(config.supabaseUrl)) {
    problems.push('SUPABASE_URL is missing, blank, or still a placeholder (expected https://<ref>.supabase.co)');
  } else if (!/^https?:\/\//.test(config.supabaseUrl)) {
    problems.push(`SUPABASE_URL must start with http(s):// — received "${config.supabaseUrl}"`);
  }

  if (isPlaceholder(config.supabaseAnonKey)) {
    problems.push('SUPABASE_ANON_KEY is missing, blank, or still a placeholder');
  }
  if (isPlaceholder(config.supabaseServiceRoleKey)) {
    problems.push('SUPABASE_SERVICE_ROLE_KEY is missing, blank, or still a placeholder');
  }
  if (
    !isPlaceholder(config.supabaseServiceRoleKey) &&
    config.supabaseServiceRoleKey === config.supabaseAnonKey
  ) {
    problems.push('SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are identical — they must be different keys');
  }
  if (isPlaceholder(config.geminiApiKey)) {
    problems.push('GEMINI_API_KEY is missing, blank, or still a placeholder');
  }

  // --- CORS -----------------------------------------------------------------
  if (config.allowedOrigins.length === 0) {
    problems.push(
      'CORS_ORIGIN is empty. No browser would be able to call the API. Set it to the exact origin(s) serving the client, e.g. https://your-app.vercel.app'
    );
  } else {
    // Every entry must be a bare origin — scheme, host, optional port, nothing
    // else. The Origin header it is compared against never carries a path, so
    // 'https://host/app' matches nothing, and it does so silently.
    const malformed = config.allowedOrigins.filter((o) => {
      // Wildcards are the wildcard check's business (it owns the dev/prod
      // distinction); this check is about origins that *look* precise.
      if (o === '*' || o === 'null') return false;
      try {
        const u = new URL(o);
        return u.origin !== o || (u.protocol !== 'http:' && u.protocol !== 'https:');
      } catch {
        return true;
      }
    });
    if (malformed.length) {
      problems.push(
        `CORS_ORIGIN entries must be bare origins (scheme + host, no path): ${malformed.join(', ')}`
      );
    }
  }

  // --- Production-only hardening -------------------------------------------
  // In development a wildcard CORS and an unprotected cron endpoint are a
  // convenience. In production they are the two ways this server can be abused,
  // so both become hard boot failures rather than warnings.
  if (config.isProd) {
    const wildcards = config.allowedOrigins.filter((o) => o === '*' || o === 'null');
    if (wildcards.length) {
      problems.push(
        `CORS_ORIGIN must not be a wildcard in production (found "${wildcards.join(', ')}"). List the exact client origins instead.`
      );
    }
    const insecure = config.allowedOrigins.filter((o) => o.startsWith('http://') && !o.startsWith('http://localhost'));
    if (insecure.length) {
      problems.push(
        `CORS_ORIGIN contains plaintext http origins in production: ${insecure.join(', ')}. Use https.`
      );
    }
    if (isPlaceholder(config.cronSecret)) {
      problems.push(
        'CRON_SECRET is required in production — without it POST /api/cron/decay is open to anyone and will drain decay against every profile.'
      );
    }
  }

  return problems;
}

export function assertValidConfig() {
  const problems = validateConfig();
  if (problems.length === 0) return;

  const banner = '\n' + '='.repeat(72) + '\n  CONFIGURATION PROBLEMS — REFUSING TO START\n' + '='.repeat(72);
  console.error(banner);
  for (const p of problems) console.error(`  x ${p}`);
  console.error('='.repeat(72));
  console.error(
    '\n  The server has no demo or offline fallback, so it cannot start until every\n' +
      '  credential above is real. Copy server/.env.example -> server/.env and fill it in:\n\n' +
      '    SUPABASE_URL               Project Settings -> API\n' +
      '    SUPABASE_ANON_KEY          Project Settings -> API -> anon (publishable)\n' +
      '    SUPABASE_SERVICE_ROLE_KEY  Project Settings -> API -> service_role  [server only]\n' +
      '    GEMINI_API_KEY             https://aistudio.google.com/apikey\n' +
      '    CORS_ORIGIN                the exact origin serving the client\n' +
      '    CRON_SECRET                required when NODE_ENV=production\n\n' +
      '  Then run supabase/schema.sql in the Supabase SQL editor.\n'
  );
  process.exit(1);
}
