/**
 * The client/server origin boundary.
 *
 * WHY ONE TEST SPANS TWO WORKSPACES
 *   The failure this guards against did not live in either half. The API held a
 *   static one-entry allowlist; the client held a base-URL rule that defeated the
 *   proxy written to avoid cross-origin requests; and the dev server was free to
 *   move ports without saying so. Any one of them is defensible in isolation. All
 *   three together produce a login screen that silently cannot reach its own API.
 *   So the assertions are grouped by the boundary they protect rather than by the
 *   directory the file happens to sit in.
 *
 * WHAT IS ACTUALLY BEING PROVEN
 *   1. config/origins.js accepts exactly the loopback origins a Vite dev server can
 *      produce, and nothing adjacent to them. The near-misses matter more than the
 *      hits: `localhost.evil.com` and `https://localhost:5173` are the two shapes a
 *      naive implementation lets through.
 *   2. That leniency cannot reach production. The gate is `!isProd`, asserted here
 *      against the real source so the rule cannot be quietly deleted.
 *   3. index.js logs a rejection. For a preflight the browser throws the response
 *      body away, so this log line is the only place the offending origin can ever
 *      be seen by a human.
 *   4. The client prefers the same-origin proxy in development, and the proxy it
 *      relies on still exists with a correctly normalised target.
 *   5. vite.config.js sets strictPort, so the port cannot move silently again.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

import { stripJsComments } from '../../scripts/lib/strip-js-comments.mjs';
import { resolveApiBase, isLocalApiUrl } from '../../client/src/lib/apiBase.js';

import {
  DEV_CLIENT_PORT_MIN,
  DEV_CLIENT_PORT_MAX,
  isDevClientOrigin,
  isOriginAllowed,
  explainOriginRejection,
} from '../src/config/origins.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function eq(label, actual, expected) {
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Read a source file with its comments removed.
 *
 * Every source scan below goes through this. It is not hygiene, it is the whole
 * point: api.js documents `import.meta.env.DEV` in the comment directly above the
 * line that uses it, so an assertion for that token passes against the prose even
 * after the branch has been deleted. A test that passes for the wrong reason is
 * worse than no test, because it reports coverage while providing none.
 */
function readCode(...segments) {
  return stripJsComments(readFileSync(resolve(repo, ...segments), 'utf8'));
}

/* ------------------------------------------------------------------ *
 * 1. The dev-origin predicate
 * ------------------------------------------------------------------ */

// The port range Vite actually hands out, starting from the port we configure.
eq('range starts at 5173', DEV_CLIENT_PORT_MIN, 5173);
check('range is contiguous', DEV_CLIENT_PORT_MAX > DEV_CLIENT_PORT_MIN);

// Exactly the ports a Vite dev server can be reached on.
for (const port of [5173, 5174, 5180, 5199]) {
  check(`http://localhost:${port} accepted`, isDevClientOrigin(`http://localhost:${port}`));
}

// Just outside the range, in both directions.
for (const port of [5172, 5200, 3000, 80]) {
  check(`http://localhost:${port} rejected`, !isDevClientOrigin(`http://localhost:${port}`));
}

// Alternate loopback spellings a developer may reasonably use. `::1` is absent on
// purpose: unbracketed, it is not a URL at all, so `new URL()` throws and the
// matcher never sees a hostname to compare.
for (const host of ['127.0.0.1', '[::1]']) {
  check(`http://${host}:5173 accepted`, isDevClientOrigin(`http://${host}:5173`));
}

/* --- the near-misses. Each of these is a real way to get it wrong. --- */

// Substring matching on the origin is the classic bug: 'localhost.evil.com'
// contains 'localhost'. This asserts it is rejected.
check(
  'http://localhost.evil.com:5173 rejected',
  !isDevClientOrigin('http://localhost.evil.com:5173'),
  'a substring test on the origin would have accepted this'
);
check('http://notlocalhost:5173 rejected', !isDevClientOrigin('http://notlocalhost:5173'));
check('http://localhostX:5173 rejected', !isDevClientOrigin('http://localhostX:5173'));

// Vite's dev server is http. An https origin on the dev port is someone else's
// app, or a redirect target, and must not inherit the fallback.
check('https://localhost:5173 rejected', !isDevClientOrigin('https://localhost:5173'));

// A remote host on a dev-range port is not a dev server.
check('http://example.com:5173 rejected', !isDevClientOrigin('http://example.com:5173'));

// Non-localhost IP.
check('http://192.168.1.10:5173 rejected', !isDevClientOrigin('http://192.168.1.10:5173'));

// Non-Origin values that reach this function.
for (const value of ['null', '*', 'file://', '', undefined, null, 5173, {}]) {
  check(`${JSON.stringify(value) ?? String(value)} rejected`, !isDevClientOrigin(value));
}

// Not origins at all. Each parses to a dev host and port, and is refused purely
// because the string carries something an Origin header cannot.
check('http://localhost:5173/evil rejected', !isDevClientOrigin('http://localhost:5173/evil'));
check('http://localhost:5173/ rejected', !isDevClientOrigin('http://localhost:5173/'));
check('http://localhost:5173?x=1 rejected', !isDevClientOrigin('http://localhost:5173?x=1'));
check('http://localhost:80 rejected (default port, out of range)', !isDevClientOrigin('http://localhost:80'));
check('http://::1:5173 rejected (unparseable, unbracketed IPv6)', !isDevClientOrigin('http://::1:5173'));

/* ------------------------------------------------------------------ *
 * 2. isOriginAllowed — the ordering and the production gate
 * ------------------------------------------------------------------ */

// No Origin header: curl, the health check, the cron endpoint.
eq('absent origin allowed in production', isOriginAllowed(undefined, { allowedOrigins: [], isProd: true }), true);
eq('empty-string origin allowed', isOriginAllowed('', { allowedOrigins: [], isProd: true }), true);

// An explicitly configured origin always wins, in either direction.
eq(
  'configured origin allowed in development',
  isOriginAllowed('http://localhost:5173', { allowedOrigins: ['http://localhost:5173'], isProd: false }),
  true
);
eq(
  'configured origin allowed in production',
  isOriginAllowed('https://app.example.com', { allowedOrigins: ['https://app.example.com'], isProd: true }),
  true
);

// THE load-bearing assertion: the dev fallback must not exist in production.
// A deployment that inherited it would accept any localhost port, which is a
// meaningfully different security posture from the one this file documents.
for (const origin of ['http://localhost:5174', 'http://127.0.0.1:5199', 'http://[::1]:5173']) {
  eq(
    `${origin} rejected in production`,
    isOriginAllowed(origin, { allowedOrigins: ['https://app.example.com'], isProd: true }),
    false
  );
  eq(
    `${origin} accepted in development`,
    isOriginAllowed(origin, { allowedOrigins: ['https://app.example.com'], isProd: false }),
    true
  );
}

// A production origin that was never configured is refused in both modes.
eq(
  'unconfigured production origin rejected',
  isOriginAllowed('https://evil.example.com', { allowedOrigins: ['https://app.example.com'], isProd: true }),
  false
);
eq(
  'unconfigured external origin rejected in development too',
  isOriginAllowed('https://evil.example.com', { allowedOrigins: [], isProd: false }),
  false
);

// Missing allowedOrigins must not throw — a defensive default, since a caller
// could reasonably pass only the flag.
eq(
  'allowedOrigins omitted does not throw',
  isOriginAllowed('https://app.example.com', { isProd: true }),
  false
);

/* ------------------------------------------------------------------ *
 * 3. The rejection explanation
 * ------------------------------------------------------------------ */

const localRejection = explainOriginRejection('http://localhost:5174', {
  allowedOrigins: ['http://localhost:5173'],
  isProd: false,
});
check('local rejection names the origin', localRejection.includes('http://localhost:5174'));
check('local rejection names the allowed origins', localRejection.includes('http://localhost:5173'));
check('local rejection names CORS_ORIGIN', localRejection.includes('CORS_ORIGIN'));
check('local rejection mentions the dev range', localRejection.includes(String(DEV_CLIENT_PORT_MIN)));
check(
  'local rejection explains the browser hides the body',
  /preflight/i.test(localRejection),
  'this is the whole reason the message exists'
);

const prodRejection = explainOriginRejection('https://evil.example.com', {
  allowedOrigins: ['https://app.example.com'],
  isProd: true,
});
check('production rejection names the origin', prodRejection.includes('https://evil.example.com'));
check(
  'production rejection does not advertise the dev range',
  !prodRejection.includes(String(DEV_CLIENT_PORT_MIN)),
  'suggesting a dev port to a production deploy would be wrong advice'
);

// An empty allowlist must say so rather than printing a blank line.
const emptyRejection = explainOriginRejection('http://localhost:9999', { allowedOrigins: [], isProd: false });
check('empty allowlist is spelled out', emptyRejection.includes('none configured'));

// No arguments at all must not throw.
check('explainOriginRejection() with no args does not throw', typeof explainOriginRejection('http://x.test') === 'string');

/* ------------------------------------------------------------------ *
 * 4. The server actually uses these helpers
 * ------------------------------------------------------------------ */

const indexSrc = readCode('server', 'src', 'index.js');
check(
  'index.js imports isOriginAllowed',
  /import\s*\{[^}]*isOriginAllowed[^}]*\}\s*from\s*'\.\/config\/origins\.js'/.test(indexSrc)
);
check(
  'index.js imports explainOriginRejection',
  /import\s*\{[^}]*explainOriginRejection[^}]*\}\s*from\s*'\.\/config\/origins\.js'/.test(indexSrc)
);
check(
  'index.js delegates the decision to isOriginAllowed',
  /isOriginAllowed\(origin,\s*config\)/.test(indexSrc),
  'the allowlist must be consulted in exactly one place'
);

// The old inline checks are gone. If either reappears, two sources of truth exist.
check(
  'index.js no longer inlines the allowlist check',
  !/config\.allowedOrigins\.includes\(origin\)/.test(indexSrc),
  'a second copy of this rule would silently diverge from the tested one'
);
check(
  'index.js no longer inlines the empty-origin check',
  !/if\s*\(\s*!origin\s*\)\s*return\s*cb\(null,\s*true\)/.test(indexSrc),
  'the absent-Origin case now lives in isOriginAllowed'
);

// The rejection is logged. Asserted on the call, because the log is the only
// channel a developer has for a preflight.
check('index.js logs the rejection', /console\.warn\(\s*`\[cors\]/.test(indexSrc));
check(
  'the log includes the explanation helper',
  /explainOriginRejection\(/.test(indexSrc)
);

// The 403 branch keys off a substring of the Error message, so the message must
// still contain it. Deleting the phrase would turn every CORS refusal into a 500.
const throwsCORSError = /cb\(new Error\(`Origin \$\{origin\} is not allowed by CORS`\)\)/.test(indexSrc);
check('index.js still raises the CORS error', throwsCORSError);
check(
  'index.js still maps that error to a 403',
  /includes\('not allowed by CORS'\)/.test(indexSrc) && /CORS_REJECTED/.test(indexSrc),
  'the substring and the handler must stay in sync or refusals become 500s'
);

// Production hardening must remain in place.
//
// These run validateConfig() in a child process rather than grepping env.js for a
// pattern that merely looks right. The guards exist to stop a deployment, and the
// only question worth asking about a guard is whether it still fires — which a
// regex cannot answer, since it passes just as happily against a condition that
// has been inverted. Real credentials come from server/.env, which dotenv loads
// without overriding the explicit variables below.
const ENV_MODULE_URL = pathToFileURL(resolve(repo, 'server', 'src', 'config', 'env.js')).href;

function validateConfigWith(overrides) {
  const script =
    `import { validateConfig } from ${JSON.stringify(ENV_MODULE_URL)};\n` +
    'process.stdout.write(JSON.stringify(validateConfig()));';
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: resolve(repo, 'server'),
      env: { ...process.env, ...overrides },
      encoding: 'utf8',
    })
  );
}

function configProblems(label, overrides, expectedFragment, shouldAppear) {
  let problems;
  try {
    problems = validateConfigWith(overrides);
  } catch (err) {
    check(`${label} — validateConfig ran`, false, String(err.message).split('\n')[0]);
    return;
  }
  const appeared = problems.some((p) => p.includes(expectedFragment));
  check(
    `${label}`,
    appeared === shouldAppear,
    shouldAppear
      ? `expected a problem containing "${expectedFragment}", got: ${JSON.stringify(problems)}`
      : `expected no problem containing "${expectedFragment}", got: ${JSON.stringify(problems)}`
  );
}

// A wildcard in production is the single most dangerous CORS misconfiguration:
// it disables the check entirely. It must be a hard boot failure there.
configProblems('a wildcard origin is rejected in production', { NODE_ENV: 'production', CORS_ORIGIN: '*' }, 'must not be a wildcard', true);
configProblems('"null" is treated as a wildcard', { NODE_ENV: 'production', CORS_ORIGIN: 'null' }, 'must not be a wildcard', true);

// ...and must remain a convenience in development, or local work gets harder for
// no security gain.
configProblems('a wildcard origin is tolerated in development', { NODE_ENV: 'development', CORS_ORIGIN: '*' }, 'must not be a wildcard', false);

// Plaintext http is refused in production, with localhost exempted so that a
// misconfigured production deployment that happens to list localhost still gets
// told about the real problem.
configProblems('a plaintext http origin is rejected in production', { NODE_ENV: 'production', CORS_ORIGIN: 'http://example.com' }, 'plaintext http origins', true);
configProblems('https origins pass in production', { NODE_ENV: 'production', CORS_ORIGIN: 'https://app.example.com' }, 'plaintext http origins', false);
configProblems('localhost http is exempt from the https rule', { NODE_ENV: 'production', CORS_ORIGIN: 'http://localhost:5173' }, 'plaintext http origins', false);

// An allowlist that trims down to nothing would silently disable CORS for every
// browser while looking configured in the .env file.
configProblems('a whitespace-only allowlist is rejected', { NODE_ENV: 'production', CORS_ORIGIN: ' , ' }, 'CORS_ORIGIN is empty', true);
configProblems('an empty allowlist is rejected', { NODE_ENV: 'production', CORS_ORIGIN: '' }, 'CORS_ORIGIN is empty', true);

/* ------------------------------------------------------------------ *
 * 5. The client half: same-origin in development
 * ------------------------------------------------------------------ */

// resolveApiBase is pure and dependency-free precisely so it can be called here.
// The earlier version of this section asserted that the *name* LOCAL_API appeared
// in api.js, which a mutation satisfied by keeping the name and inverting the rule
// underneath it. Calling the function is the only version of this check that
// cannot be satisfied without the behaviour being correct.
const base = (raw, isDev) => resolveApiBase(raw, isDev);

eq('dev + local API uses the same-origin proxy', base('http://localhost:4000', true), '/api');
eq('dev + local API on another port still proxied', base('http://localhost:5000', true), '/api');
eq('dev + loopback IP proxied', base('http://127.0.0.1:4000', true), '/api');
eq('dev + IPv6 loopback proxied', base('http://[::1]:4000', true), '/api');
eq('dev + /api-terminated local URL proxied', base('http://localhost:4000/api', true), '/api');

// THE case that must not be "fixed" by widening the rule: a remote API in
// development. Redirecting it at localhost would send real credentials to
// whatever happens to be listening locally.
eq('dev + remote API stays absolute', base('https://api.staging.example.com', true), 'https://api.staging.example.com/api');
eq('dev + remote API with a port stays absolute', base('https://api.example.com:8443', true), 'https://api.example.com:8443/api');
eq('dev + remote API with /api is not doubled', base('https://api.example.com/api', true), 'https://api.example.com/api');

// Production always uses the absolute URL, whatever the host.
eq('prod + local-looking URL is still absolute', base('http://localhost:4000', false), 'http://localhost:4000/api');
eq('prod + remote URL is absolute', base('https://api.example.com', false), 'https://api.example.com/api');

// Unset means same-origin deployment: relative in both modes, which is the only
// reason a deploy with no VITE_API_URL works at all.
eq('dev + unset is relative', base(undefined, true), '/api');
eq('dev + empty string is relative', base('', true), '/api');
eq('prod + unset is relative (same-origin deploy)', base(undefined, false), '/api');

// Trailing-slash and whitespace tolerance, because .env files are hand-edited.
eq('trailing slash tolerated', base('https://api.example.com/', false), 'https://api.example.com/api');
eq('trailing slashes tolerated', base('https://api.example.com///', false), 'https://api.example.com/api');
eq('surrounding whitespace tolerated', base('  https://api.example.com  ', false), 'https://api.example.com/api');
eq('whitespace-only value counts as unset', base('   ', false), '/api');

// A near-miss host must not be treated as local, or the proxy would swallow a
// request meant for a real deployment.
check('localhost.evil.com is not local', !isLocalApiUrl('http://localhost.evil.com:4000'));
check('notlocalhost is not local', !isLocalApiUrl('http://notlocalhost:4000'));
check('a remote IP is not local', !isLocalApiUrl('http://192.168.1.10:4000'));
check('a non-URL is not local', !isLocalApiUrl('api.example.com'));
eq('a remote IP in dev stays absolute', base('http://192.168.1.10:4000', true), 'http://192.168.1.10:4000/api');

// Non-string inputs must not throw; a malformed .env should degrade, not white-screen.
for (const value of [null, undefined, 0, false, {}, []]) {
  check(`resolveApiBase survives ${JSON.stringify(value) ?? String(value)}`, typeof base(value, true) === 'string');
}

// The module must stay pure. If it ever reaches for import.meta.env, it can no
// longer be imported by a Node test, and the behavioural checks above silently
// stop being runnable by anyone.
const apiBaseSrc = readCode('client', 'src', 'lib', 'apiBase.js');
check(
  'apiBase.js does not read import.meta.env',
  !/import\.meta\.env/.test(apiBaseSrc),
  'that would make the module unimportable outside Vite and silently disable these tests'
);
check('apiBase.js imports nothing', !/^\s*import\s/m.test(apiBaseSrc), 'it must stay dependency-free to be testable');

// api.js must actually use the tested function rather than re-deriving the rule.
const apiSrc = readCode('client', 'src', 'lib', 'api.js');
check('api.js imports resolveApiBase', /import\s*\{\s*resolveApiBase\s*\}/.test(apiSrc));
check(
  'api.js derives its base from resolveApiBase',
  /resolveApiBase\(\s*import\.meta\.env\.VITE_API_URL\s*,\s*import\.meta\.env\.DEV\s*\)/.test(apiSrc),
  'an inline ternary here would be a second, untested copy of the rule'
);
check(
  'api.js no longer carries its own LOCAL_API regex',
  !/LOCAL_API/.test(apiSrc),
  'the rule belongs in apiBase.js, where the tests can reach it'
);

const viteSrc = readCode('client', 'vite.config.js');
check('vite.config.js sets strictPort: true', /strictPort:\s*true/.test(viteSrc));
check(
  'strictPort is inside the dev server block',
  /server:\s*\{[^}]*strictPort:\s*true/s.test(viteSrc),
  'strictPort under preview would not prevent a dev-server port shift'
);
check(
  'vite.config.js still proxies /api',
  /'\/api':\s*\{/.test(viteSrc),
  'the client now depends on this proxy in development'
);
check(
  'the proxy target is normalised',
  viteSrc.includes(".replace(/\\/api\\/?$/, '')"),
  'a /api-terminated VITE_API_URL would otherwise produce /api/api/*'
);

// .env.example is what a new developer copies. It must not push them into the
// cross-origin path this whole arrangement exists to avoid.
const envExample = readFileSync(resolve(repo, 'client', '.env.example'), 'utf8');
check(
  '.env.example sets VITE_API_URL to a local API',
  /VITE_API_URL=https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(envExample),
  'a deployed URL here would make dev cross-origin again'
);

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

if (failures.length) {
  console.error(`\ntest-cors-origins: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f}`);
  console.error('');
  process.exit(1);
}

console.log(`test-cors-origins: ${passed} assertions passed`);
