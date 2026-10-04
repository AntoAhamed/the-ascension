/**
 * Server build gate.
 *
 * The server is plain ESM JavaScript — there is no transpile step and no bundler,
 * so "does it build" reduces to three questions that are all answerable without
 * starting the process or touching a database:
 *
 *   1. Does every source file parse?            -> `node --check` per file
 *   2. Does every import resolve?               -> bare specifiers against
 *                                                 node_modules, relative ones
 *                                                 against the filesystem
 *   3. Would a production boot pass validation? -> run validateConfig() with a
 *                                                 synthetic, fully-populated
 *                                                 environment
 *   4. Is every /api route authenticated?       -> static audit of index.js and
 *                                                 the router files
 *
 * The third question is the one that actually earns its place. `assertValidConfig()`
 * calls process.exit(1) on a bad environment, so in practice it has only ever run
 * against a developer's local .env. This exercises it with a realistic production
 * environment, which catches a rule that is too strict (a deployment that boots
 * locally and dies on Render) without needing the deployment.
 *
 * The fourth is a property that is trivial to break with a one-line reordering and
 * impossible to notice in review. See audit-auth.mjs.
 *
 * What this does NOT do: execute route handlers or touch Postgres. Integration
 * coverage for those is a separate concern and needs real credentials.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { auditAuth } from './audit-auth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolvePath(HERE, '..', 'src');
const require = createRequire(join(HERE, '..', 'package.json'));

const problems = [];
const note = (msg) => problems.push(msg);

/* ------------------------------------------------------------------ */
/* 1. every file parses                                                */
/* ------------------------------------------------------------------ */

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = jsFiles(SRC).sort();

for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    note(`syntax error in ${relative(process.cwd(), file)}\n${(r.stderr || '').trim()}`);
  }
}

/* ------------------------------------------------------------------ */
/* 2. every import resolves                                            */
/* ------------------------------------------------------------------ */

// Two patterns, both anchored to real import syntax.
//
// A naive /\bfrom\s*['"]/ also matches Supabase's query builder — `.from('profiles')`
// — and reports a Postgres table as an uninstalled npm package. Static imports
// must start a line with `import`/`export`, and a dynamic import is always the
// bare keyword `import(`.
const STATIC_IMPORT_RE = /^[ \t]*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /^[ \t]*import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

let importCount = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const from = relative(process.cwd(), file);

  const specifiers = [
    ...[...src.matchAll(STATIC_IMPORT_RE)].map((m) => m[1]),
    ...[...src.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1]),
  ];

  for (const spec of specifiers) {
    if (spec.startsWith('node:')) continue; // builtin, always available
    importCount++;

    if (spec.startsWith('.')) {
      // Relative specifiers in this codebase are written with the explicit .js
      // extension, which is mandatory for Node ESM. A missing one is a runtime
      // ERR_MODULE_NOT_FOUND that nothing else would catch before deploy.
      if (!spec.endsWith('.js')) {
        note(`${from}: relative import "${spec}" is missing the .js extension`);
        continue;
      }
      const target = resolvePath(dirname(file), spec);
      if (!existsSync(target)) note(`${from}: import "${spec}" does not exist`);
      continue;
    }

    try {
      require.resolve(spec);
    } catch {
      note(`${from}: package "${spec}" is not installed (run npm install)`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. a production boot would pass config validation                    */
/* ------------------------------------------------------------------ */

// Re-import env.js with a synthetic environment. dotenv does not overwrite
// variables that are already set, so seeding the real process env here is enough
// to make the module read exactly these values.
const ORIGINAL_ENV = { ...process.env };

/** A plausible, fully-populated production environment. */
const SYNTHETIC_PROD_ENV = {
  NODE_ENV: 'production',
  PORT: '4000',
  SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anonymous.key',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service.role.key',
  GEMINI_API_KEY: 'AIzaSyA-synthetic-key-for-the-build-gate-only',
  CORS_ORIGIN: 'https://ascension.example.com',
  CRON_SECRET: 'a'.repeat(64),
};

function restoreEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

/** Re-seeds the synthetic environment so each case starts from the same baseline. */
const seedProdEnv = () => Object.assign(process.env, SYNTHETIC_PROD_ENV);

try {
  seedProdEnv();
  // Fresh module registry so env.js re-reads the environment we just seeded.
  const env = await import(`${pathToFileURL(resolvePath(SRC, 'config', 'env.js')).href}?build=${Date.now()}`);

  const prodProblems = env.validateConfig();
  if (prodProblems.length) {
    note(
      'a complete production environment still fails validation:\n' +
        prodProblems.map((p) => `      - ${p}`).join('\n')
    );
  }

  // And the negative case: the same environment with the service-role key removed
  // must be rejected. A validator that accepts everything is as broken as one that
  // rejects everything, and only the positive case is ever exercised by running the
  // app.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = await import(
    `${pathToFileURL(resolvePath(SRC, 'config', 'env.js')).href}?build=${Date.now()}-b`
  );
  const missingProblems = missing.validateConfig();
  if (!missingProblems.some((p) => p.includes('SERVICE_ROLE'))) {
    note('validateConfig() does not reject a missing SUPABASE_SERVICE_ROLE_KEY');
  }

  // A wildcard CORS origin must be refused in production, and the plaintext-http
  // rule must let http://localhost through so local development still works.
  seedProdEnv();
  process.env.CORS_ORIGIN = '*';
  const wildcard = await import(
    `${pathToFileURL(resolvePath(SRC, 'config', 'env.js')).href}?build=${Date.now()}-c`
  );
  if (!wildcard.validateConfig().some((p) => p.includes('wildcard'))) {
    note('validateConfig() allows CORS_ORIGIN=* in production');
  }

  seedProdEnv();
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  const dev = await import(
    `${pathToFileURL(resolvePath(SRC, 'config', 'env.js')).href}?build=${Date.now()}-d`
  );
  const devProblems = dev.validateConfig();
  if (devProblems.length) {
    note(
      'validateConfig() rejects a legitimate production CORS origin:\n' +
        devProblems.map((p) => `      - ${p}`).join('\n')
    );
  }

  // Same origin in development, where wildcard http is the local convenience.
  // Guarded by the mode check, so a production deployment never sees this.
  seedProdEnv();
  process.env.NODE_ENV = 'development';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  const devMode = await import(
    `${pathToFileURL(resolvePath(SRC, 'config', 'env.js')).href}?build=${Date.now()}-e`
  );
  if (devMode.validateConfig().length) {
    note(
      'validateConfig() rejects a legitimate local development environment:\n' +
        devMode.validateConfig().map((p) => `      - ${p}`).join('\n')
    );
  }
} catch (err) {
  note(`config validation could not be exercised: ${err.message}`);
} finally {
  restoreEnv();
}

/* ------------------------------------------------------------------ */
/* 4. every /api route is authenticated                                */
/* ------------------------------------------------------------------ */
let routerCount = 0;
auditAuth((msg) => note(msg));
routerCount = (() => {
  const idx = readFileSync(resolvePath(SRC, 'index.js'), 'utf8');
  return (idx.match(/app\.use\(\s*'\/api[^']*'\s*,\s*[A-Za-z_$][\w$]*\s*\)/g) ?? []).length;
})();

/* ------------------------------------------------------------------ */
/* report                                                             */
/* ------------------------------------------------------------------ */

if (problems.length) {
  console.error(`\n  SERVER BUILD FAILED — ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  x ${p}`);
  console.error('');
  process.exit(1);
}

console.log(
  `\n  server build ok — ${files.length} files parsed, ${importCount} imports resolved, ` +
    `${routerCount} routers audited for authentication, production config validation exercised\n`
);
