/**
 * Guards two deliberate bundle decisions that a single careless import would
 * silently undo:
 *
 *   1. framer-motion loads through LazyMotion + the `m` component. One file
 *      importing `motion` instead pulls the full animation runtime back into
 *      the initial chunk — a regression of roughly 40 KB raw that no test would
 *      fail on, because everything still works. The `strict` prop in main.jsx
 *      makes it loud in development, but only once somebody runs the app;
 *      this makes it loud in CI instead.
 *
 *   2. canvas-confetti is dynamically imported on the first celebration. A
 *      static `import ... from 'canvas-confetti'` anywhere, or the loss of its
 *      manualChunks rule in vite.config.js, puts it back into the initial
 *      download. The second of those is the trap: manualChunks assigns by
 *      package, so the catch-all vendor bucket swallows dynamic boundaries
 *      without anyone writing a new import.
 *
 * Both scans run on comment-stripped source via scripts/lib/strip-js-comments.mjs,
 * because these files discuss `motion` and canvas-confetti in their doc comments
 * and a naive scan passes against the prose.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { stripJsComments } from '../../scripts/lib/strip-js-comments.mjs';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const VITE_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vite.config.js');

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

/** Every client source file as comment-free code, keyed by relative path. */
function sourceFiles(dir = SRC, prefix = '') {
  const out = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of sourceFiles(full, rel)) out.set(k, v);
    } else if (/\.(js|jsx)$/.test(entry.name)) {
      out.set(rel, stripJsComments(readFileSync(full, 'utf8')));
    }
  }
  return out;
}

const files = sourceFiles();

/* ------------------------------------------------------------------ *
 * 1. Nobody imports the heavy `motion` component
 * ------------------------------------------------------------------ */

// Capture the braces of every named framer-motion import and word-test the
// contents. An earlier version tried to match the whole import in one pattern
// and could not match `{ motion }` at all — the braces consumed the name before
// the alternation reached it — so the mutation it existed to catch passed. The
// braces-first form cannot make that mistake.
//
// `\bmotion\b` does not match the names that legitimately appear in these
// braces: `m` (no), `LazyMotion` and `domAnimation` (word-internal), and
// `AnimatePresence` (no). It does match `{ motion }`, `{ motion as m }` and
// `{ AnimatePresence, motion }` — every spelling of the regression.
const FM_NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]framer-motion['"]/g;

function importsHeavyMotion(code) {
  for (const match of code.matchAll(FM_NAMED_IMPORT)) {
    if (/\bmotion\b/.test(match[1])) return true;
  }
  // A default import spelling, for completeness: framer-motion has no default
  // export, so this can only ever be the mistake.
  return /import\s+motion\s+from\s*['"]framer-motion['"]/.test(code);
}

for (const [rel, code] of files) {
  check(`${rel} does not import \`motion\``, !importsHeavyMotion(code));
}

// A JSX tag <motion.div or a component reference motion.span (both seen in the
// wild — the badge components used the second form, and it sailed through the
// first conversion, which only looked at tags).
for (const [rel, code] of files) {
  check(`${rel} has no <motion.*> tags`, !/<\/?motion\./.test(code));
  check(`${rel} has no motion.* component references`, !/\bmotion\.[a-zA-Z]/.test(code));
}

/* ------------------------------------------------------------------ *
 * 2. The LazyMotion provider exists and is strict
 * ------------------------------------------------------------------ */

const main = files.get('main.jsx') ?? '';
check('main.jsx imports LazyMotion and domAnimation', /import\s*\{\s*LazyMotion\s*,\s*domAnimation\s*\}\s*from\s*['"]framer-motion['"]/.test(main));
check('main.jsx loads the domAnimation feature set', /features=\{\s*domAnimation\s*\}/.test(main));
check(
  'LazyMotion is strict, so a straggler fails loudly in dev',
  /<LazyMotion\s+features=\{domAnimation\}\s+strict>/.test(main) || /<LazyMotion[^>]*strict[^>]*>/.test(main)
);
check(
  'LazyMotion wraps the app tree',
  /<LazyMotion[^>]*>[\s\S]*<App\s*\/>/.test(main),
  'a provider that does not wrap App covers nothing'
);

/* ------------------------------------------------------------------ *
 * 3. canvas-confetti stays out of the initial bundle
 * ------------------------------------------------------------------ */

for (const [rel, code] of files) {
  check(
    `${rel} has no static canvas-confetti import`,
    !/import\s+[\w{][^;]*from\s*['"]canvas-confetti['"]/.test(code),
    'confetti is a celebration; it must arrive after the first win, not at boot'
  );
}

const confettiLib = files.get('lib/confetti.js') ?? '';
check(
  'lib/confetti.js loads the library dynamically',
  /import\(\s*['"]canvas-confetti['"]\s*\)/.test(confettiLib)
);
check(
  'the dynamic import is cached, not re-fetched per celebration',
  /confettiPromise\s*\?\?=/.test(confettiLib),
  'an uncached import() would re-request the chunk on every fire'
);

const viteSrc = stripJsComments(readFileSync(VITE_CONFIG, 'utf8'));
check(
  'vite.config.js gives canvas-confetti its own chunk',
  /canvas-confetti/.test(viteSrc) && /return\s+['"]confetti['"]/.test(viteSrc),
  'without this, the catch-all vendor bucket swallows the dynamic boundary'
);
check(
  'the confetti rule comes before the vendor catch-all',
  viteSrc.indexOf("return 'confetti'") !== -1 &&
    viteSrc.indexOf("return 'confetti'") < viteSrc.indexOf("return 'vendor'"),
  'order is the whole mechanism: the first matching rule wins'
);

/* ------------------------------------------------------------------ */

if (failures.length) {
  console.error(`\ntest-slim-bundle: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f}`);
  console.error('');
  process.exit(1);
}

console.log(`test-slim-bundle: ${passed} assertions passed`);
