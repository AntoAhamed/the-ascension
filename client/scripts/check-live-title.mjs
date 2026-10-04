/**
 * End-to-end check of the tab title against the live API.
 *
 * The unit tests pin the precedence rules; this confirms the fields the hook is
 * actually handed from /api/profile produce the right title for a real user.
 * It reads only — no state is mutated.
 *
 * ## Authentication
 *
 * There is no demo session any more, so this needs a real Supabase access token.
 * Sign in to your deployed app, then in the browser console run:
 *
 *     (await supabase.auth.getSession()).data.session.access_token
 *
 * and:
 *
 *     ASCENSION_TOKEN=<jwt> npm run test:title:live
 *     ASCENSION_TOKEN=<jwt> API_BASE=https://api.example.com npm run test:title:live
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = (process.env.API_BASE ?? 'http://localhost:4000').replace(/\/+$/, '');
const TOKEN = process.env.ASCENSION_TOKEN ?? '';

if (!TOKEN) {
  console.error(
    '\n  ASCENSION_TOKEN is required.\n\n' +
      '  Sign in to your deployed app, then in the browser console run:\n\n' +
      '    (await supabase.auth.getSession()).data.session.access_token\n\n' +
      '  and re-run with:\n\n' +
      '    ASCENSION_TOKEN=<that jwt> npm run test:title:live\n'
  );
  process.exit(2);
}

// The title rules are evaluated by the very module the app imports, read from
// disk and stripped of its ESM syntax. Sharing the source rather than a copy
// means this test cannot drift from the implementation it is checking.
const src = readFileSync(resolve(HERE, '..', 'src', 'lib', 'documentTitle.js'), 'utf8');
const body = src
  .replace(/^export /gm, '')
  .replace(/\/\*\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
// eslint-disable-next-line no-new-func
const { resolveTitle } = new Function(`${body}\nreturn { resolveTitle };`)();

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  -> ${detail}`);
  }
};

console.log(`  querying ${ORIGIN} (read-only)\n`);
console.log('  user                 pts  streak  submitted  title');
console.log('  -------------------  ----  ------  ---------  ------------------------------');

const res = await fetch(`${ORIGIN}/api/profile`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
if (res.status === 401) {
  console.error('\n  HTTP 401 — the token was rejected. It may be expired; copy a fresh one.\n');
  process.exit(2);
}
if (!res.ok) {
  console.error(`\n  GET /api/profile -> ${res.status}\n`);
  process.exit(2);
}
const p = await res.json();

// Exactly what Dashboard passes to useDocumentTitle.
const title = resolveTitle({
  hasSubmitted: p.todayStatus?.hasSubmitted,
  currentStreak: p.profile?.currentStreak ?? 0,
});

const name = p.profile?.username ?? 'unknown';
console.log(
  `  ${name.padEnd(19)}  ${String(p.profile?.points ?? '?').padStart(4)}  ` +
    `${String(p.profile?.currentStreak ?? '?').padStart(6)}  ${String(p.todayStatus?.hasSubmitted).padStart(9)}  ${title}`
);

// Invariants that must hold for any real user.
check(
  `${name}: title reflects the server's hasSubmitted`,
  p.todayStatus?.hasSubmitted ? title.startsWith('✓') : !title.startsWith('✓'),
  `hasSubmitted=${p.todayStatus?.hasSubmitted} but title was "${title}"`
);
check(`${name}: title ends with the app name`, title.endsWith('The Ascension'), title);
check(
  `${name}: no stray whitespace or double spaces`,
  !/\s{2,}|^\s|\s$/.test(title),
  JSON.stringify(title)
);

// A streak of 0 with work already logged is the state a fresh account lands in
// after its very first submission, and it is the case most likely to pick up a
// stray separator between two suppressed segments. Assert the exact string so a
// regression names the shape it produced.
check(
  `${name}: logged with no streak -> exact "Work Logged" string`,
  p.profile?.currentStreak > 0 || !p.todayStatus?.hasSubmitted
    ? true
    : title === '\u2713 Work Logged - The Ascension',
  JSON.stringify(title)
);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
