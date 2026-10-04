/**
 * Authentication audit.
 *
 * The property that must never silently regress: no route reaches the database
 * on an unauthenticated request. Express has no way to say "this entire router is
 * private", so the guarantee is a single line per router — `Router.use(requireAuth)`
 * — that a later edit can move below a route registration and quietly undo. A
 * router with the auth applied out of order still *looks* correct in review,
 * because the middleware is present; it is only at runtime that the endpoint is
 * open.
 *
 * So the check is static, and it is part of the build. It reads index.js and each
 * router file and reports anything that would be reachable without a session.
 *
 * This is a source audit, not a runtime probe. It cannot see a handler that
 * conditionally skips its own auth, and it does not exercise Supabase. What it
 * does guarantee is the structural property that is easy to break and invisible
 * in review.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Endpoints reachable without a session, each with the reason it is safe.
 * Adding a path here is a decision, not a convenience — the comment is the record.
 */
const PUBLIC_ROUTES = new Map([
  [
    '/api/health',
    'liveness probe for the platform; returns no configuration or user data',
  ],
  [
    '/api/tiers',
    'the rank ladder, which is already public in the client bundle (FALLBACK_TIERS) and contains no user data',
  ],
]);

/**
 * Routers that authenticate with a shared secret rather than a user JWT, because
 * an external scheduler has no Supabase session. Each handler must call the
 * secret assertion itself.
 */
const SECRET_ROUTERS = new Map([['adminRouter', 'assertCronSecret']]);

/** @param {(msg: string) => void} report */
export function auditAuth(report) {
  const indexPath = join(SRC, 'index.js');
  if (!existsSync(indexPath)) {
    report('index.js not found — cannot audit route authentication');
    return;
  }
  const indexSrc = readFileSync(indexPath, 'utf8');

  /* -- 1. a bare handler on the app itself has no router to protect it --------- */
  const DIRECT_ROUTE_RE = /app\.(get|post|put|patch|delete)\(\s*'(\/api[^']*)'/g;
  for (const m of indexSrc.matchAll(DIRECT_ROUTE_RE)) {
    const path = m[2];
    if (PUBLIC_ROUTES.has(path)) continue;
    report(
      `index.js registers ${path} directly on the app, so nothing guarantees it is ` +
        'authenticated. Mount it on a Router that calls requireAuth, or — if it is ' +
        'genuinely public — add it to PUBLIC_ROUTES in server/scripts/audit-auth.mjs with a reason.'
    );
  }

  /* -- 2. every mounted router must be private, and privately from the top ---- */
  const MOUNT_RE = /app\.use\(\s*'(\/api[^']*)'\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let audited = 0;

  for (const m of indexSrc.matchAll(MOUNT_RE)) {
    const [, mountPath, routerName] = m;

    const importRe = new RegExp(
      `import\\s*\\{[^}]*\\b${routerName}\\b[^}]*\\}\\s*from\\s*'([^']+)'`
    );
    const importMatch = indexSrc.match(importRe);
    if (!importMatch) {
      report(`index.js mounts ${routerName} at ${mountPath} but its import could not be resolved`);
      continue;
    }

    const routerFile = resolvePath(SRC, importMatch[1].replace(/^\.\//, ''));
    if (!existsSync(routerFile)) {
      report(`index.js mounts ${routerName} at ${mountPath} but ${importMatch[1]} does not exist`);
      continue;
    }

    const rel = relative(process.cwd(), routerFile);
    const routerSrc = readFileSync(routerFile, 'utf8');
    const lines = routerSrc.split('\n');

    // The secret-guarded routers are held to their own rule.
    if (SECRET_ROUTERS.has(routerName)) {
      const assertName = SECRET_ROUTERS.get(routerName);
      const handlerCount = (routerSrc.match(/\b(get|post|put|patch|delete)\s*\(/g) ?? []).length;
      const guardedCount = (routerSrc.match(new RegExp(`${assertName}\\s*\\(`, 'g')) ?? []).length;

      if (handlerCount === 0) {
        report(`${rel}: ${routerName} is mounted at ${mountPath} but registers no routes`);
      } else if (guardedCount < handlerCount) {
        report(
          `${rel}: ${routerName} registers ${handlerCount} route handler(s) but only ` +
            `${guardedCount} call ${assertName}(). An unguarded handler on a mounted ` +
            'router is reachable without the secret.'
        );
      }
      audited++;
      continue;
    }

    // The ordering check. Express evaluates app.use() and route registrations in
    // source order, so auth has to come first to cover everything after it.
    const authLine = lines.findIndex((l) => /^\s*\w*[Rr]outer\.use\(\s*requireAuth\s*\)/.test(l));
    const firstRouteLine = lines.findIndex((l) =>
      /^\s*\w*[Rr]outer\.(get|post|put|patch|delete|use)\s*\(/.test(l)
    );

    if (authLine === -1) {
      report(
        `${rel}: ${routerName} is mounted at ${mountPath} but never applies requireAuth, ` +
          'so every route on it answers unauthenticated requests.'
      );
    } else if (firstRouteLine !== -1 && firstRouteLine < authLine) {
      report(
        `${rel}: ${routerName} registers its first route at line ${firstRouteLine + 1} but ` +
          `applies requireAuth at line ${authLine + 1}. Express matches in order, so ` +
          'everything above the auth line is reachable without a session.'
      );
    }
    audited++;
  }

  if (audited === 0) {
    report('no routers were found to audit — the mount pattern in index.js may have changed');
  }
}
