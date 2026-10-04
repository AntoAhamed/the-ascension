/**
 * Tests rank assignment from points.
 *
 * The reported symptom was "everybody shows Novice". The ladder maths was
 * never the problem — public.tier_for_points() in Postgres and getTierForPoints()
 * on the server both evaluate bounds correctly. The failure lived in the client's
 * resolveTier(), which matched on an exact label string and fell back to table[0]
 * (Novice) on any mismatch: an id passed where a label was expected, a stray
 * space, different casing, or a null profile. Every one of those rendered as
 * Novice, indistinguishable from a genuinely new player.
 *
 * So the fix has two halves, and both are asserted here:
 *   1. the lookup is points-first, and coerces junk input;
 *   2. the label fallback tolerates id/case/whitespace instead of collapsing.
 *
 * Runs against the real source files, not a copy, so it cannot drift.
 *
 *   node client/scripts/test-tier-assignment.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Loads an ES module's body into this scope so it can be called directly. */
function load(path, names) {
  const src = readFileSync(path, 'utf8');
  const body = src
    .replace(/^export /gm, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

const client = load(resolve(HERE, '..', 'src', 'lib', 'tiers.js'), [
  'FALLBACK_TIERS',
  'UNKNOWN_ACCENT',
  'toPoints',
  'tierForPoints',
  'resolveTier',
  'rankFor',
  'accentFor',
  'accentForRank',
]);
const server = load(resolve(HERE, '..', '..', 'server', 'src', 'lib', 'tiers.js'), [
  'getTierForPoints',
  'computeTierProgress',
  'getNextTierForPoints',
  'toPoints',
]);

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

const table = client.FALLBACK_TIERS.map((t) => ({ ...t }));

// The canonical ladder, exactly as specified.
const LADDER = [
  [0, 'Novice'],
  [1, 'Novice'],
  [199, 'Novice'],
  [200, 'Apprentice'],
  [499, 'Apprentice'],
  [500, 'Practitioner'],
  [999, 'Practitioner'],
  [1000, 'Specialist'],
  [1999, 'Specialist'],
  [2000, 'Architect'],
  [3999, 'Architect'],
  [4000, 'Grandmaster'],
  [6999, 'Grandmaster'],
  [7000, 'Apex Luminary'],
  [99999, 'Apex Luminary'],
];

console.log('  client tierForPoints() — every boundary in the ladder');
for (const [points, label] of LADDER) {
  check(`${points} pts -> ${label}`, client.tierForPoints(table, points)?.label, label);
}

console.log('\n  server getTierForPoints() — same boundaries, independently');
for (const [points, label] of LADDER) {
  check(`${points} pts -> ${label}`, server.getTierForPoints(points)?.label, label);
}

console.log('\n  no gap between consecutive floors');
// Each tier's floor must be exactly one point above the previous tier's ceiling.
// A gap here is how "everyone is Novice" would start: a score landing in a hole
// falls through to the bottom of the loop.
for (let i = 1; i < table.length; i++) {
  const prevMax = table[i - 1].maxPoints;
  const thisMin = table[i].minPoints;
  check(
    `${table[i - 1].label} ceiling (${prevMax}) meets ${table[i].label} floor (${thisMin})`,
    thisMin,
    prevMax + 1
  );
}
check('top tier is unbounded', table[table.length - 1].maxPoints, null);

console.log('\n  junk input is coerced, not silently zeroed');
const junk = [
  ['"7000" (string)', '7000', 7000],
  ['7000 with spaces', '  7000 ', 7000],
  ['null', null, 0],
  ['undefined', undefined, 0],
  ['empty string', '', 0],
  ['-500 (negative)', -500, 0],
  ['1.9 (float)', 1.9, 1],
  ['"abc" (NaN)', 'abc', 0],
  ['NaN', NaN, 0],
];
for (const [desc, input, expected] of junk) {
  check(`toPoints ${desc}`, client.toPoints(input), expected);
  check(`toPoints ${desc} (server)`, server.toPoints(input), expected);
}

console.log('\n  a string score still resolves to the right rank');
check('"760" -> Practitioner', client.tierForPoints(table, '760')?.label, 'Practitioner');
check('"8400" -> Apex Luminary', client.tierForPoints(table, '8400')?.label, 'Apex Luminary');

console.log('\n  resolveTier() no longer collapses to Novice on a shape mismatch');
// These are the inputs that used to render as "Novice" no matter the real rank.
const mismatches = [
  ['lowercase label', 'apex luminary', 'Apex Luminary'],
  ['uppercase label', 'APEX LUMINARY', 'Apex Luminary'],
  ['trailing space', 'Apex Luminary ', 'Apex Luminary'],
  ['id instead of label', 'apex', 'Apex Luminary'],
  ['id for a mid rank', 'grandmaster', 'Grandmaster'],
];
for (const [desc, input, expected] of mismatches) {
  check(`${desc} -> ${expected}`, client.resolveTier(table, input)?.label, expected);
}

console.log('\n  rankFor() prefers live points over a stale label');
// The exact failure mode from the report: a user whose score has outgrown the
// stored label must not keep seeing the old rank.
check(
  '3200 pts with a stale "Novice" label -> Architect',
  client.rankFor(table, { points: 3200, tier: 'Novice' })?.label,
  'Architect'
);
check(
  '8400 pts with a stale "Apprentice" label -> Apex Luminary',
  client.rankFor(table, { points: 8400, tier: 'Apprentice' })?.label,
  'Apex Luminary'
);
check(
  'a correct label is preserved when points agree',
  client.rankFor(table, { points: 760, tier: 'Practitioner' })?.label,
  'Practitioner'
);
check(
  'no points -> falls back to the label',
  client.rankFor(table, { tier: 'Grandmaster' })?.label,
  'Grandmaster'
);
check(
  'no points and no label -> bottom of the ladder',
  client.rankFor(table, {})?.label,
  'Novice'
);
check(
  'a tier object works as the fallback',
  client.rankFor(table, { tier: { id: 'specialist' } })?.label,
  'Specialist'
);

console.log('\n  accent follows the rank');
check('Apex accent', client.accentForRank(table, { points: 7000, tier: 'Novice' }), '#ffd166');
check('Novice accent', client.accentForRank(table, { points: 0, tier: 'Apex Luminary' }), '#94a3b8');
check('accentFor by id', client.accentFor(table, 'apex'), '#ffd166');
check('unknown ref uses the neutral accent', client.accentFor(table, 'not-a-rank'), client.UNKNOWN_ACCENT);

console.log('\n  progress maths at a boundary');
{
  const p = server.computeTierProgress(500);
  check('500 pts is Practitioner', p.current.label, 'Practitioner');
  check('next is Specialist', p.next.label, 'Specialist');
  check('0 pts into the rank', p.pointsIntoTier, 0);
  check('500 pts to go', p.pointsToNext, 500);
  check('0% progress', p.percent, 0);
}
{
  // Halfway through the 500-999 band.
  const p = server.computeTierProgress(750);
  check('750 pts is 50% through Practitioner', p.percent, 50);
  check('750 pts is 250 into the rank', p.pointsIntoTier, 250);
  check('750 pts has 250 to go', p.pointsToNext, 250);
}
{
  // The interesting edge: 998/500 is 99.6%, which rounds to 100% and pins the bar
  // full two points before the promotion actually lands. Clamping is correct —
  // a full bar while the card still reads "250 pts to go" would look broken.
  const p = server.computeTierProgress(998);
  check('998 pts clamps to 100% rather than overflowing', p.percent, 100);
  check('998 pts still reports 2 to go', p.pointsToNext, 2);
  check('percent never exceeds 100', p.percent <= 100, true);
}
{
  const p = server.computeTierProgress(7000);
  check('7000 pts is Apex', p.current.label, 'Apex Luminary');
  check('Apex has no next rank', p.next, null);
  check('Apex is flagged as max tier', p.isMaxTier, true);
  check('Apex progress is 100%', p.percent, 100);
}
{
  // Regression: progress must not blow up on a string score.
  const p = server.computeTierProgress('500');
  check('string "500" still reports Practitioner', p.current.label, 'Practitioner');
  check('string "500" still reports 500 to go', p.pointsToNext, 500);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
