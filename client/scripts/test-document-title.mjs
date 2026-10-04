/**
 * Tests the tab-title precedence rules.
 *
 * The rules encode product judgement — chiefly that a length-1 streak is not
 * worth nagging about — so they are worth pinning down rather than eyeballing.
 * Importable and dependency-free, so this runs under plain node.
 *
 *   node client/scripts/test-document-title.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, '..', 'src', 'lib', 'documentTitle.js'), 'utf8');

// Strip the ESM export keywords so the module body can run in this script's own
// scope, rather than standing up a build step or a DOM to import it.
const body = src
  .replace(/^export /gm, '')
  .replace(/\/\*\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// eslint-disable-next-line no-new-func
const mod = new Function(`${body}\nreturn { resolveTitle, resolveTitleState, titleFor, DEFAULT_TITLE, APP_NAME, STREAK_AT_RISK_MIN, TITLE_STATES, TITLE_STATE_DEFAULT };`)();
const { resolveTitle, resolveTitleState, DEFAULT_TITLE, STREAK_AT_RISK_MIN, TITLE_STATES } = mod;

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  if (actual === expected) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}\n          expected: ${expected}\n          actual:   ${actual}`);
  }
};

console.log('  exact strings');
check(
  'pending',
  resolveTitle({ hasSubmitted: false, currentStreak: 0 }),
  "(1) Today's Work Pending - The Ascension"
);
check(
  'logged',
  resolveTitle({ hasSubmitted: true, currentStreak: 9 }),
  '✓ Work Logged - The Ascension'
);
check(
  'streak at risk',
  resolveTitle({ hasSubmitted: false, currentStreak: 4 }),
  '🔥 Streak Active - The Ascension'
);
check(
  'signed out falls back to the marketing title',
  resolveTitle({ authenticated: false, hasSubmitted: true, currentStreak: 12 }),
  DEFAULT_TITLE
);

console.log('\n  precedence');
check(
  'logged beats a live streak (nothing at stake once the day is done)',
  resolveTitleState({ hasSubmitted: true, currentStreak: 30 }),
  TITLE_STATES.LOGGED
);
check(
  'a long streak outranks a plain reminder',
  resolveTitleState({ hasSubmitted: false, currentStreak: 7 }),
  TITLE_STATES.STREAK
);
check(
  'a streak of 1 is not treated as at risk',
  resolveTitleState({ hasSubmitted: false, currentStreak: 1 }),
  TITLE_STATES.PENDING
);
check(
  `streak of ${STREAK_AT_RISK_MIN} is the threshold`,
  resolveTitleState({ hasSubmitted: false, currentStreak: STREAK_AT_RISK_MIN }),
  TITLE_STATES.STREAK
);
check(
  'unknown submission state never claims the day is done',
  resolveTitleState({ currentStreak: 5 }),
  TITLE_STATES.STREAK
);
check(
  'a revoked entry reads as pending again',
  resolveTitleState({ hasSubmitted: false, currentStreak: 3 }),
  TITLE_STATES.STREAK
);

console.log('\n  every live state ends with the app name');
// The signed-out default is excluded on purpose: it is the marketing title, not
// a status line, and its job is to read as a page title rather than a status.
for (const input of [
  { hasSubmitted: false, currentStreak: 0 },
  { hasSubmitted: false, currentStreak: 6 },
  { hasSubmitted: true, currentStreak: 0 },
]) {
  const t = resolveTitle(input);
  check(`"${t}"`, t.endsWith('The Ascension'), true);
}
check('signed-out default still names the app', DEFAULT_TITLE, 'The Ascension | Gamified Productivity');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
