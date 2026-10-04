/**
 * THE ASCENSION — API server
 */
import express from 'express';
import compression from 'compression';
import http from 'node:http';
import { constants as zlibConstants } from 'node:zlib';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { config, assertValidConfig } from './config/env.js';
import { isOriginAllowed, explainOriginRejection } from './config/origins.js';
import { HttpError } from './lib/errors.js';
import { getSupabaseAdmin } from './config/supabaseAdmin.js';
import { setTierTable, getTierTable } from './lib/tiers.js';
import { startDecayJob, stopDecayJob } from './jobs/decayJob.js';
import { profileRouter } from './routes/profile.js';
import { submissionRouter } from './routes/submissions.js';
import { logsRouter } from './routes/logs.js';
import { leaderboardRouter } from './routes/leaderboard.js';
import { adminRouter } from './routes/admin.js';
import { feedbackRouter } from './routes/feedback.js';

assertValidConfig();

const app = express();

/**
 * Behind a reverse proxy (Render, Fly, Railway, nginx) the client IP arrives in
 * X-Forwarded-For. Without this, express-rate-limit buckets every request under
 * the proxy's address and one noisy client throttles everyone. `1` trusts exactly
 * one hop, which is what these platforms add.
 */
app.set('trust proxy', 1);

app.use(helmet());
app.use(express.json({ limit: '32kb' }));

/**
 * Response compression.
 *
 * Every response this server sends is JSON, and JSON is the best compression
 * case there is — a leaderboard page of 100 rows repeats keys and column names on
 * every single row, so it typically lands at roughly a quarter of its size. That
 * matters most for the endpoints that are both the largest and the most
 * requested: /api/leaderboard and /api/logs.
 *
 * `threshold` skips anything under 1 KB. Below that the gzip header plus
 * dictionary cost more than the saving, so compressing a small error body or a
 * health probe is pure overhead. The 8 KB default would also compress the
 * handful of tiny responses this API emits.
 */
app.use(
  compression({
    threshold: 1024,
    // Brotli when the client offers it — ~15% smaller than gzip on JSON, and
    // every current browser and CDN accepts it. Quality is pinned to 5 rather
    // than zlib's default of 11, which spends far more CPU than the extra few
    // percent is worth on an API that is mostly small documents.
    brotli: { enabled: true, zlib: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } } },
  })
);

/**
 * Cache policy.
 *
 * The default for this API is `no-store`, and it is a security control rather
 * than a performance knob. Almost everything under /api is scoped to one
 * verified user: their points, their streak, their submission history, their
 * rank. With no explicit Cache-Control a shared cache (a CDN in front of the
 * origin, or an institutional proxy) is entitled to apply heuristic freshness
 * to a 200 response and store one user's payload, then serve it to the next
 * request that looks similar. `no-store` removes that possibility outright.
 *
 * The one exception is /api/tiers, which is explicitly re-marked below. It is
 * public, it contains no user data, and it changes only when the schema does.
 *
 * Express emits no Cache-Control of its own, so this default is the whole
 * policy — nothing downstream has to opt out.
 */
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * CORS allowlist.
 *
 * An unknown origin is rejected outright (403) rather than silently served
 * without CORS headers. The distinction matters: the silent version produces a
 * confusing "blocked by CORS" message in the browser console, while an explicit
 * 403 says which origin was refused.
 *
 * A request with no Origin header is allowed. That is curl, the health check, and
 * the cron endpoint — none of them are browsers, so CORS does not apply to them
 * and the browser cannot be the attack vector here. Authorization still does:
 * every data route requires a verified Supabase JWT.
 *
 * The decision itself lives in config/origins.js so it can be tested without
 * booting Express, and so the log line below and the 403 body cannot drift apart.
 *
 * WHY THE REJECTION IS LOGGED
 *   For a preflight (OPTIONS), the browser discards the response body. A developer
 *   whose dev server moved to a different port sees only "No
 *   'Access-Control-Allow-Origin' header is present" — no port, no origin, no
 *   hint. The server log is the single place that information can reach a human,
 *   so it is written unconditionally on rejection instead of being left to the
 *   generic access log.
 */
app.use(
  cors({
    origin(origin, cb) {
      if (isOriginAllowed(origin, config)) return cb(null, true);

      console.warn(
        `[cors] ${explainOriginRejection(origin, {
          allowedOrigins: config.allowedOrigins,
          isProd: config.isProd,
        })}`
      );

      // The 'not allowed by CORS' substring is load-bearing: the error handler
      // below matches on it to pick this 403 instead of a 500.
      cb(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86_400,
  })
);

app.use(morgan(config.isProd ? 'combined' : 'dev'));

/**
 * Broad ceiling for the whole API. This is a backstop against a runaway client
 * or a scrape; the per-route limiters below are what actually protect the
 * expensive endpoints.
 */
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' } },
  })
);

/* ---------------- health ---------------- */

/**
 * Public and unauthenticated by design — orchestrators poll it to decide
 * whether to route traffic here. It reports liveness only; no credential,
 * version, or configuration detail is exposed.
 *
 * `no-store` rather than the `no-cache` a probe might tempt you toward:
 * `no-cache` still permits storing the response, it just forces revalidation
 * every time, and a monitor polling once a second would generate that
 * revalidation traffic forever. `no-store` means nothing is written down.
 */
app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * GET /api/tiers — the rank ladder.
 *
 * Public so the marketing/landing surface can render the ladder without an
 * account. The thresholds are not secret: they are in the client bundle either
 * way (FALLBACK_TIERS mirrors this table) and contain no user data.
 *
 * This is the one endpoint in the API that may be cached, and the opt-in has to
 * be explicit because the global policy above denies caching for everything.
 * The table is seven rows of constants loaded once at boot from `get_tier_table`
 * and only ever changed by a schema edit — which means a deploy. A short
 * freshness window with a long stale-while-revalidate tail therefore serves
 * every reader from cache while still self-healing if the ladder is ever edited
 * in place.
 *
 * `public` is safe here only because the payload is identical for everyone and
 * contains nothing user-specific. Anything user-scoped stays `no-store`.
 */
app.get('/api/tiers', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  res.json({ tiers: getTierTable() });
});

/* ---------------- api ---------------- */
// Every router below applies requireAuth internally; there is no route here that
// reaches the database on an unauthenticated request.

app.use('/api/profile', profileRouter);
app.use('/api/submissions', submissionRouter);
app.use('/api/logs', logsRouter);
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/cron', adminRouter);
app.use('/api/feedback', feedbackRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'No such API endpoint. All routes are prefixed with /api.',
    },
  });
});

// Anything else that reaches the server (wrong prefix, missing /api) also gets
// JSON. Without this, Express returns an HTML 404 page and the browser client
// can only report an unhelpful "malformed response".
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.originalUrl}. API routes are prefixed with /api.`,
    },
  });
});

/* ---------------- errors ---------------- */

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err?.message?.includes('not allowed by CORS')) {
    return res.status(403).json({
      error: {
        code: 'CORS_REJECTED',
        message: 'This origin is not permitted to call the API.',
      },
    });
  }

  // express-rate-limit signals a blocked request with a numeric status.
  if (err?.status === 429) {
    return res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
    });
  }

  // Supabase errors that escaped translation
  if (err?.code || err?.details) {
    console.error('[unhandled db error]', err);
    return res.status(500).json({
      error: { code: 'DATABASE_ERROR', message: 'A database error occurred.' },
    });
  }

  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
});

/* ---------------- boot ---------------- */

async function bootstrap() {
  // Tier thresholds are authoritative in the database. A failure here is not
  // fatal — the built-in FALLBACK_TIERS is a deliberate, complete copy — but it
  // is reported without guessing at a cause, because the common failures have
  // opposite remedies: an unreachable project wants a look at the keys, while an
  // empty result means schema.sql has not been run yet. The reachability check
  // below distinguishes them, so this message stays neutral.
  try {
    const { data, error } = await getSupabaseAdmin().rpc('get_tier_table');
    if (error) throw error;
    if (Array.isArray(data) && data.length) {
      setTierTable(data);
      console.log(`[boot] loaded ${data.length} tiers from the database`);
    } else {
      console.warn(
        '[boot] get_tier_table returned no rows — using the built-in fallback table.\n' +
          '[boot]       supabase/schema.sql has not been run (or the tiers table is empty).'
      );
    }
  } catch (err) {
    console.error(`[boot] could not load tiers: ${err.message}`);
    console.error('[boot] Falling back to the built-in tier table; the reachability check below will say more.');
  }

  // Prove the database is reachable AND the schema exists. This one IS fatal:
  // without it every request would fail with a confusing 500, and the process
  // would keep accepting traffic it cannot serve.
  try {
    const { error } = await getSupabaseAdmin().from('profiles').select('id').limit(1);
    if (error) throw error;
    console.log('[boot] Supabase connection OK');
  } catch (err) {
    console.error('\n' + '='.repeat(72));
    console.error('  CANNOT REACH THE DATABASE — REFUSING TO START');
    console.error('='.repeat(72));
    console.error(`\n  ${err.message}\n`);
    console.error('  Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, then confirm');
    console.error('  supabase/schema.sql has been run in the SQL editor.\n');
    process.exit(1);
  }

  startDecayJob();

  const server = app.listen(config.port, () => {
    console.log(`\n  THE ASCENSION API`);
    console.log(`  http://localhost:${config.port}`);
    console.log(`  env: ${config.nodeEnv}  model: ${config.geminiModel}`);
    console.log(`  cors: ${config.allowedOrigins.join(', ')}\n`);
  });

  server.on('error', (err) => onListenError(err, config.port));

  // Close the listener before exiting so the platform sees a clean shutdown
  // rather than a forced kill. The cron task is stopped first so it cannot fire
  // mid-shutdown — a reconcile starting while the listener is draining would
  // race the exit and log a failure that is really just the process leaving.
  const shutdown = (signal) => () => {
    console.log(`\n[shutdown] ${signal} received, closing server`);
    stopDecayJob();
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

/**
 * A failed listen() deserves better than an unhandled 'error' event.
 *
 * EADDRINUSE is one of the commonest development failures there is — a previous
 * `node --watch` is still alive in another terminal — and the default outcome
 * hides that completely: Node prints an exception trace that names a syscall
 * and an errno, and `node --watch` then waits silently for a file change, so
 * the developer is left with a client that runs and an API that quietly does
 * not. Handled, the same failure can say what actually matters:
 *
 *   - whether the port's current occupant IS this API. The probe hits
 *     /api/health; a 200 with our shape means a leftover instance, which is the
 *     usual case, and the useful fact is that the client would work against it.
 *   - how to find and stop whatever holds the port.
 *   - that PORT exists, for the rarer "I meant to run two" case.
 *
 * The process still exits 1. Retrying the bind is pointless in development (the
 * other instance is not going away) and unnecessary in production (the
 * platform's restart policy is the retry loop) — the only thing missing was the
 * explanation.
 */
async function onListenError(err, port) {
  if (err?.code !== 'EADDRINUSE') {
    console.error(`\n[boot] the HTTP server failed to start: ${err?.message ?? err}`);
    process.exit(1);
  }

  const holder = await probePort(port);

  const lines = [
    '',
    '='.repeat(72),
    `  PORT ${port} IS ALREADY IN USE — REFUSING TO START`,
    '='.repeat(72),
    '',
  ];

  if (holder === 'this-api') {
    lines.push(
      '  Another copy of THIS API is already listening there (its /api/health',
      '  answers). That is almost always a previous `npm run dev` or `node --watch`',
      '  that is still alive in another terminal.',
      '',
      '  The client will work against the already-running instance, so you can',
      '  either just use it, or stop it before starting this one.'
    );
  } else {
    lines.push(
      holder === 'something-else'
        ? '  Whatever holds the port does not answer /api/health, so it is some other program.'
        : '  The port is held, but its occupant did not answer a probe at all.',
      ''
    );
  }

  lines.push(
    '',
    '  To find the process holding the port:',
    `    Windows:      Get-NetTCPConnection -LocalPort ${port} -State Listen`,
    `    macOS/Linux:  lsof -i :${port}`,
    '',
    '  Stop that process, or run this server on a different port with PORT=<n>.',
    ''
  );

  console.error(lines.join('\n'));
  process.exit(1);
}

/**
 * Ask the port's current occupant what it is. Resolves 'this-api' when
 * /api/health answers 200 with our shape, 'something-else' when it answers at
 * all, and 'no-answer' otherwise. Bounded at 1.5s so a firewall-blackholed port
 * cannot hang the exit.
 */
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        res.on('end', () => {
          resolve(res.statusCode === 200 && body.includes('"ok":true') ? 'this-api' : 'something-else');
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve('no-answer'));
  });
}

bootstrap();

export default app;

