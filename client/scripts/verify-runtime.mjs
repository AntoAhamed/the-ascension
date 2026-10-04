/**
 * Runtime verification for the production bundle.
 *
 * WHY THIS EXISTS
 *   Everything else in this repo's gate chain is static: the schema checker reads
 *   SQL as text, the credential audit reads the emitted files as text, and
 *   `vite build` reports whether the graph resolves. None of them observe the
 *   bundle running. That gap is not hypothetical — splitting a vendor chunk or
 *   introducing a lazy boundary produces a bundle that builds perfectly clean and
 *   then throws "Cannot access 'X' before initialization" in the browser, because
 *   a cycle that was previously internal to one chunk is now split across two and
 *   evaluated in a different order. The failure is also invisible to a build log
 *   and to a static reader.
 *
 *   So this loads the real emitted output in a real browser and checks three
 *   things: React mounts, nothing throws, and every deferred chunk is fetchable
 *   and evaluates.
 *
 * WHAT IT DOES NOT DO
 *   It does not exercise the API or Supabase. It asserts the app renders its
 *   Dashboard against seeded local guest data, which is the branch that exercises
 *   the lazy boundaries, TierCard's hook order, and the list components.
 *   It also does not click anything — that is verify-interactions.mjs, which this
 *   one hands off to. The split is deliberate: "did it mount" and "does it respond"
 *   fail for different reasons and diagnosing them together muddies both.
 *
 * HOW IT LOADS THE PAGE
 *   Through lib/gate.mjs, over the DevTools protocol. It used to shell out to
 *   `chrome --dump-dom` against `vite preview`, and that turned out to depend on
 *   network egress, on the developer's default browser profile, and on virtual
 *   time. Each of those fails as an empty result rather than an error, so each read
 *   as "your build is broken" when the build was fine. See lib/gate.mjs.
 *
 * SKIPPING
 *   If no Chrome/Edge binary is found it prints a skip notice and exits 0, so a
 *   machine without a browser (a bare CI container) does not fail the chain.
 *   Pass --require-browser to turn that skip into a failure.
 */
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findBrowser, serveDir, withPage } from './lib/gate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist');
const ASSETS = resolve(DIST, 'assets');
const PORT = 4178;
const PAGE = '__runtime_check.html';

const requireBrowser = process.argv.includes('--require-browser');

const ok = (label) => console.log(`  PASS  ${label}`);
const bad = (label) => {
  console.log(`  FAIL  ${label}`);
  failures++;
};
let failures = 0;

const browser = findBrowser();
if (!browser) {
  console.log(
    requireBrowser
      ? '  FAIL  no Chrome/Edge binary found and --require-browser was passed'
      : '  SKIP  no Chrome/Edge binary found — runtime check skipped (pass --require-browser to enforce)'
  );
  process.exit(requireBrowser ? 1 : 0);
}

/* ---------------- locate the chunks ---------------- */

if (!existsSync(ASSETS)) {
  console.log('  FAIL  client/dist/assets does not exist. Run `npm run build:client` first.');
  process.exit(1);
}

const js = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
const css = readdirSync(ASSETS).find((f) => f.endsWith('.css')) ?? null;

const pick = (re, what) => {
  const f = js.find((n) => re.test(n));
  if (!f) {
    console.log(`  FAIL  could not find a ${what} chunk in dist/assets`);
    process.exit(1);
  }
  return f;
};

const entry = pick(/^index-.*\.js$/, 'entry');
const react = pick(/^react-.*\.js$/, 'react');
const vendor = pick(/^vendor-.*\.js$/, 'vendor');
const supabase = pick(/^supabase-.*\.js$/, 'supabase');
const icons = pick(/^icons-.*\.js$/, 'icons');
const motion = pick(/^motion-.*\.js$/, 'motion');

/** Deferred chunks are named after the module they carry. */
const DEFERRED = [
  'Guidelines',
  'AuthScreen',
  'OnboardingModal',
  'RankRoadmapModal',
  'TierPromotionOverlay',
  'SubmissionEngine',
  'StreakCard',
];
const deferred = {};
for (const name of DEFERRED) {
  const f = js.find((n) => n.startsWith(`${name}-`) || n.startsWith(`${name}.`));
  if (f) deferred[name] = f;
}

console.log('  chunk map:');
for (const [k, v] of Object.entries({ entry, react, vendor, supabase, icons, motion })) {
  console.log(`    ${k.padEnd(10)} ${v}`);
}
console.log(`  deferred  : ${Object.keys(deferred).length} found (${Object.keys(deferred).join(', ')})`);

if (Object.keys(deferred).length === 0) {
  console.log('  FAIL  no deferred chunks — React.lazy boundaries appear to be gone');
  process.exit(1);
}

/* ---------------- build the probe page ---------------- */

const probe = `<!doctype html>
<html lang="en" class="dark"><head><meta charset="UTF-8">
<script>
// Seed a guest session before the deferred module graph evaluates, so the app
// takes the Dashboard branch rather than the auth screen. A guest session is
// browser-local, which is exactly why it works with no API and no identity.
try { localStorage.setItem('ascension.guest.v1', JSON.stringify({ version: 1, logs: [] })); } catch (e) {}
</script>
<script type="module" crossorigin src="/assets/${entry}"></script>
<script type="module" crossorigin src="/assets/${react}"></script>
<script type="module" crossorigin src="/assets/${vendor}"></script>
<script type="module" crossorigin src="/assets/${supabase}"></script>
<script type="module" crossorigin src="/assets/${icons}"></script>
<script type="module" crossorigin src="/assets/${motion}"></script>
${css ? `<link rel="stylesheet" crossorigin href="/assets/${css}">` : ''}
</head><body><div id="root"></div><pre id="__rc">pending</pre>
<script type="module">
const problems = [];
window.addEventListener('error', (e) => problems.push('error: ' + (e.message ?? e.type)));
window.addEventListener('unhandledrejection', (e) =>
  problems.push('rejection: ' + ((e.reason && e.reason.message) || String(e.reason))));

const MAP = ${JSON.stringify(deferred)};
const chunks = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Long enough for React to mount, the auth check to settle and guestApi to
// build its sample dataset. Not an arbitrary "looks fine" number: it is the
// point at which every probe below is expected to have something to inspect.
await sleep(5000);

const html = document.getElementById('root').innerHTML;

for (const [name, file] of Object.entries(MAP)) {
  try {
    const mod = await import('/assets/' + file);
    chunks[name] = 'ok (' + Object.keys(mod).join(',') + ')';
  } catch (err) {
    chunks[name] = 'FAILED: ' + ((err && err.message) || String(err));
  }
}

document.getElementById('__rc').textContent = JSON.stringify({
  problems,
  rootLength: html.length,
  sawDashboard: /Welcome back|Log the one thing|Task .*Codex/.test(html),
  sawTierCard: /View all ranks/.test(html),
  sawLeaderboard: /Leaderboard/i.test(html),
  sawHistory: /History/i.test(html),
  chunks,
});
</script></body></html>`;

writeFileSync(resolve(DIST, PAGE), probe);

/* ---------------- serve and load ---------------- */

// The built output is served by a plain static server rather than `vite preview`,
// and the browser is driven over the DevTools protocol rather than
// `chrome --dump-dom`. Both swaps exist for the same reason, and lib/gate.mjs
// spells it out in full: the old pair depended on network egress, on the
// developer's default browser profile, and on virtual time, and each failure
// looked like "your build is broken". A gate whose answer depends on the machine
// is not a gate.
const stopServer = await serveDir(DIST, PORT);

let result = null;
try {
  result = await withPage(browser, PORT, `/${PAGE}`, async ({ evaluate, waitUntil }) => {
    // Poll rather than sleep. The probe waits five seconds inside the page and
    // then imports five chunks, so completion is not knowable in advance — which
    // is exactly why a fixed wait was the wrong tool and why it was flaky.
    const raw = await waitUntil(
      async () => {
        const read = await evaluate(`document.getElementById('__rc')?.textContent`);
        const text = read.value;
        return typeof text === 'string' && text !== 'pending' ? text : false;
      },
      { timeout: 90000, interval: 250 }
    );

    if (typeof raw !== 'string') {
      bad('the probe script never reported');
      return null;
    }
    // The probe assigns to textContent, so this is raw JSON — no entity
    // unescaping. That is deliberate: with --dump-dom the value came back as
    // innerHTML and had to be decoded by hand.
    return JSON.parse(raw);
  });
} catch (err) {
  bad(`the browser could not be driven: ${err.message}`);
} finally {
  stopServer();
  try {
    rmSync(resolve(DIST, PAGE), { force: true });
  } catch {
    /* already gone */
  }
}

if (!result) {
  console.log('  FAIL  no probe result — the page did not render, so nothing below can be trusted');
  process.exit(1);
}

/* ---------------- assert ---------------- */

console.log('');
console.log(`  uncaught problems : ${result.problems.length ? result.problems.join(' | ') : 'none'}`);
console.log(`  #root size        : ${result.rootLength} chars`);
for (const [k, v] of Object.entries(result.chunks)) {
  console.log(`  deferred ${k.padEnd(22)} ${v}`);
}
console.log('');

if (result.problems.length === 0) ok('nothing threw while the bundle booted');
else bad(`uncaught errors: ${result.problems.join(' | ')}`);

if (result.rootLength > 400) ok(`React mounted real content (${result.rootLength} chars)`);
else bad(`#root is nearly empty (${result.rootLength} chars) — React probably crashed`);

if (result.sawDashboard) ok('the Dashboard branch rendered');
else bad('the Dashboard branch did not render');

if (result.sawTierCard) ok('TierCard rendered, so its hook order held');
else bad('TierCard did not render');

if (result.sawLeaderboard) ok('Leaderboard rendered');
else bad('Leaderboard did not render');

if (result.sawHistory) ok('HistoryFeed rendered');
else bad('HistoryFeed did not render');

const brokenChunks = Object.entries(result.chunks).filter(([, v]) => !v.startsWith('ok'));
if (brokenChunks.length === 0) {
  ok(`all ${Object.keys(result.chunks).length} deferred chunks imported and evaluated`);
} else {
  bad(`deferred chunks failed: ${brokenChunks.map(([k, v]) => `${k} -> ${v}`).join('; ')}`);
}

process.exit(failures ? 1 : 0);