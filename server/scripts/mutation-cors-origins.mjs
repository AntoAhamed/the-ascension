/**
 * Mutation harness: prove that server/scripts/test-cors-origins.mjs actually fails
 * when the behaviour it guards is broken. Not part of any npm script — run by hand.
 *
 * A test that has never been seen to fail is not evidence of anything. This applies
 * a specific defect to each file, runs the gate, and restores the original
 * byte-for-byte. Any mutation reported as surviving is a hole in the gate.
 *
 * Files are restored from a byte copy, never round-tripped through PowerShell's
 * text cmdlets, because a restore that differs by an encoding or line-ending
 * detail leaves the next run testing something other than what is on disk.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// scripts/ -> server/ -> repo root.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = resolve(repo, 'server');
const gate = resolve(server, 'scripts', 'test-cors-origins.mjs');

const MUTATIONS = [
  {
    label: 'dev-origin fallback leaks into production',
    file: 'server/src/config/origins.js',
    from: 'return !isProd && isDevClientOrigin(origin);',
    to: 'return isDevClientOrigin(origin);',
  },
  {
    label: 'host check becomes a substring test (localhost.evil.com accepted)',
    file: 'server/src/config/origins.js',
    from: "!LOOPBACK_HOSTS.has(url.hostname)",
    to: "!url.hostname.includes('localhost')",
  },
  {
    label: 'dev port range widened to include any port',
    file: 'server/src/config/origins.js',
    from: 'return port >= DEV_CLIENT_PORT_MIN && port <= DEV_CLIENT_PORT_MAX;',
    to: 'return Number.isInteger(port);',
  },
  {
    label: 'canonical-origin requirement dropped (paths accepted)',
    file: 'server/src/config/origins.js',
    from: 'if (url.origin !== origin) return false;',
    to: 'if (false) return false;',
  },
  {
    label: 'https accepted on the dev port',
    file: 'server/src/config/origins.js',
    from: "if (url.protocol !== 'http:') return false;",
    to: "if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;",
  },
  {
    label: 'absent-Origin requests refused',
    file: 'server/src/config/origins.js',
    from: 'if (!origin) return true;',
    to: 'if (!origin) return false;',
  },
  {
    label: 'production wildcard guard removed',
    file: 'server/src/config/env.js',
    from: 'if (wildcards.length) {',
    to: 'if (false) {',
  },
  {
    label: 'plaintext-http production guard removed',
    file: 'server/src/config/env.js',
    from: 'if (insecure.length) {',
    to: 'if (false) {',
  },
  {
    label: 'empty-allowlist guard removed',
    file: 'server/src/config/env.js',
    from: 'if (config.allowedOrigins.length === 0) {',
    to: 'if (false) {',
  },
  {
    label: 'origin decision inlined again (two sources of truth)',
    file: 'server/src/index.js',
    from: 'if (isOriginAllowed(origin, config)) return cb(null, true);',
    to: "if (!origin || config.allowedOrigins.includes(origin)) return cb(null, true);",
  },
  {
    label: 'rejection no longer logged',
    file: 'server/src/index.js',
    from: 'console.warn(',
    to: 'void (',
  },
  {
    label: '403 branch removed, refusals become 500s',
    file: 'server/src/index.js',
    from: "if (err?.message?.includes('not allowed by CORS')) {",
    to: 'if (false) {',
  },
  {
    label: 'strictPort disabled (silent port shift returns)',
    file: 'client/vite.config.js',
    from: 'strictPort: true,',
    to: 'strictPort: false,',
  },
  {
    label: '/api proxy removed (client now depends on a proxy that is gone)',
    file: 'client/vite.config.js',
    from: "'/api': {",
    to: "'/nope': {",
  },
  {
    label: 'proxy target no longer normalised (/api/api/*)',
    file: 'client/vite.config.js',
    from: ".replace(/\\/api\\/?$/, '')",
    to: '',
  },
  {
    label: 'api.js hardcodes the absolute base (dev proxy defeated)',
    file: 'client/src/lib/api.js',
    from: 'const BASE = resolveApiBase(import.meta.env.VITE_API_URL, import.meta.env.DEV);',
    to: "const BASE = normalizeApiBase(import.meta.env.VITE_API_URL) || '/api';",
  },
  {
    label: 'api.js re-derives the rule inline (second untested copy)',
    file: 'client/src/lib/api.js',
    from: 'const BASE = resolveApiBase(import.meta.env.VITE_API_URL, import.meta.env.DEV);',
    to: "const BASE = import.meta.env.DEV ? '/api' : (normalizeApiBase(import.meta.env.VITE_API_URL) || '/api');",
  },
  {
    label: 'local-API check inverted (proxies a remote API at localhost)',
    file: 'client/src/lib/apiBase.js',
    from: "const LOCAL_API = /^https?:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::\\d+)?(?:\\/api)?$/i;",
    to: 'const LOCAL_API = /^$/;',
  },
  {
    label: 'local-API check matches any host (localhost.evil.com)',
    file: 'client/src/lib/apiBase.js',
    from: '(?:localhost|127\\.0\\.0\\.1|\\[::1\\])',
    to: "'[^']*'",
  },
  {
    label: 'dev proxy branch removed from resolveApiBase',
    file: 'client/src/lib/apiBase.js',
    from: 'if (isDev && isLocalApiUrl(rawBase)) return \'/api\';',
    to: 'if (false) return \'/api\';',
  },
  {
    label: 'same-origin fallback removed',
    file: 'client/src/lib/apiBase.js',
    from: "return absolute || '/api';",
    to: 'return absolute;',
  },
  {
    label: 'trailing /api normalisation removed (double /api)',
    file: 'client/src/lib/apiBase.js',
    from: "trimmed.replace(/\\/api$/, '')",
    to: 'trimmed',
  },
  {
    label: 'apiBase.js reads import.meta.env (no longer testable)',
    file: 'client/src/lib/apiBase.js',
    from: 'export function resolveApiBase(rawBase, isDev) {',
    to: 'export function resolveApiBase(rawBase, isDev = import.meta.env.DEV) {',
  },
];

function gatePasses() {
  try {
    execFileSync(process.execPath, [gate], { cwd: server, stdio: 'pipe', encoding: 'utf8' });
    return { passed: true, output: '' };
  } catch (err) {
    return { passed: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const baseline = gatePasses();
if (!baseline.passed) {
  console.error('Baseline gate does not pass; fix that before trusting any mutation result.');
  console.error(baseline.output);
  process.exit(1);
}

let survived = 0;
console.log('mutation                                             result\n' + '-'.repeat(62));

for (const m of MUTATIONS) {
  const path = resolve(repo, m.file);
  const original = readFileSync(path);

  if (!original.toString('utf8').includes(m.from)) {
    console.log(`${m.label.padEnd(53)} SKIPPED (anchor text not found)`);
    survived += 1;
    continue;
  }

  writeFileSync(path, original.toString('utf8').replace(m.from, m.to));
  try {
    const result = gatePasses();
    if (result.passed) {
      console.log(`${m.label.padEnd(53)} SURVIVED  <-- gate has a hole`);
      survived += 1;
    } else {
      const count = (result.output.match(/^ {2}x /gm) ?? []).length;
      console.log(`${m.label.padEnd(53)} killed (${count})`);
    }
  } finally {
    writeFileSync(path, original);
  }
}

// The restore must be exact, or every result above describes a file that no longer
// exists. Verify rather than assume.
const after = gatePasses();
console.log('-'.repeat(62));
if (!after.passed) {
  console.error('Gate fails after restoring every file. A mutation was not reverted.');
  console.error(after.output);
  process.exit(1);
}
console.log(`baseline green before and after; ${MUTATIONS.length - survived}/${MUTATIONS.length} mutations killed`);
process.exit(survived === 0 ? 0 : 1);
