/**
 * End-to-end check that every rank the API reports matches its own points.
 *
 * Read-only: it issues two GETs and nothing else, so a run cannot change anyone's
 * score, streak, or history.
 *
 * The assertion is deliberately independent of the server's own lookup. It
 * recomputes the expected rank from the tierTable the API itself returned, so a
 * bug in getTierForPoints() cannot make this pass — that is the whole point of
 * the "everyone shows Novice" class of bug, where one wrong helper ends up
 * checking itself.
 *
 * ## Authentication
 *
 * There is no demo session any more, so this needs a real Supabase access token
 * for a signed-in user. Get one from the browser devtools console on your
 * deployed app:
 *
 *     (await supabase.auth.getSession()).data.session.access_token
 *
 * or from the Supabase dashboard -> Authentication -> API Keys -> generate a JWT.
 * Then:
 *
 *     ASCENSION_TOKEN=<jwt> npm run test:tiers:live
 *     ASCENSION_TOKEN=<jwt> API_BASE=https://api.example.com npm run test:tiers:live
 *
 * The leaderboard leg still covers every other user in the project, so this
 * remains a multi-row check even though only one profile is readable with a
 * single token.
 */
const BASE = (process.env.API_BASE ?? 'http://localhost:4000').replace(/\/+$/, '');
const TOKEN = process.env.ASCENSION_TOKEN ?? '';

if (!TOKEN) {
  console.error(
    '\n  ASCENSION_TOKEN is required.\n\n' +
      '  This check talks to a real API, so it needs a real Supabase access token.\n' +
      '  Sign in to your deployed app, then in the browser console run:\n\n' +
      '    (await supabase.auth.getSession()).data.session.access_token\n\n' +
      '  and re-run with:\n\n' +
      '    ASCENSION_TOKEN=<that jwt> npm run test:tiers:live\n'
  );
  process.exit(2);
}

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

/** Highest floor the score has reached. Deliberately naive, no shared code. */
function expectedRank(table, points) {
  const p = Number.parseInt(String(points ?? 0), 10) || 0;
  let match = null;
  for (const t of table) {
    if (p >= Number(t.minPoints)) match = t;
  }
  return match ? match.label : null;
}

const authHeaders = { Authorization: `Bearer ${TOKEN}` };

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders });
  if (res.status === 401) {
    throw new Error(
      'HTTP 401 — the token was rejected. It may be expired; sign in again and copy a fresh one.'
    );
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text().catch(() => '')}`.trim());
  return res.json();
}

console.log(`  checking ${BASE} (read-only)\n`);

// ---- profile payload -------------------------------------------------------
console.log('  GET /api/profile — tier and tierProgress both agree with points');
const data = await getJson('/api/profile');
{
  const expect = expectedRank(data.tierTable, data.profile.points);
  const who = `${data.profile.username} (${data.profile.points} pts)`;

  check(`${who}: profile.tier`, data.profile.tier, expect);
  check(`${who}: tierProgress.current.label`, data.tierProgress.current.label, expect);
  // Both must be the same string, not merely two individually plausible values:
  // a header pill that disagrees with the tier card is the visible half of this
  // bug, and it is invisible in a points-only assertion.
  check(
    `${who}: tier and tierProgress.current are one value`,
    data.profile.tier,
    data.tierProgress.current.label
  );
}

// ---- progress bar ----------------------------------------------------------
console.log('\n  tierProgress arithmetic');
{
  const { tierProgress: tp, profile } = data;
  const pts = Number(profile.points);
  const who = profile.username;

  if (tp.isMaxTier) {
    check(`${who}: max tier reports 100%`, tp.percent, 100);
    check(`${who}: max tier has no next rank`, tp.next, null);
  } else {
    const span = tp.next.minPoints - tp.current.minPoints;
    const into = Math.max(0, pts - tp.current.minPoints);
    check(`${who}: percent is within 0-100`, tp.percent >= 0 && tp.percent <= 100, true);
    check(
      `${who}: percent matches into/span`,
      tp.percent,
      Math.min(100, Math.round((into / span) * 100))
    );
    check(`${who}: pointsToNext`, tp.pointsToNext, Math.max(0, tp.next.minPoints - pts));
    check(
      `${who}: current rank sits below the next one`,
      tp.current.minPoints < tp.next.minPoints,
      true
    );
  }
}

// ---- leaderboard -----------------------------------------------------------
// Reads other people's rows, so this leg is what keeps the check multi-user.
console.log('\n  GET /api/leaderboard — every row');
const lb = await getJson('/api/leaderboard?filter=all_time&limit=100');

for (const e of lb.entries) {
  const expect = expectedRank(lb.tierTable, e.points);
  check(`${e.username} (${e.points} pts): row tier`, e.tier, expect);
}

// The reported symptom was "everybody is Novice". If the ladder still works,
// the board must span at least two ranks — a single distinct label across the
// whole board is the bug reproducing. With a fresh production database there is
// only ever one real user, so a one-row board is a legitimate result and this
// assertion is skipped rather than reported as a false failure.
if (lb.entries.length > 1) {
  const distinct = [...new Set(lb.entries.map((e) => e.tier))];
  check('leaderboard spans more than one rank', distinct.length > 1, true);
  console.log(`        ranks on the board: ${distinct.join(' | ')}`);
} else {
  console.log(
    '  SKIP  multi-rank spread — only one profile exists. Sign more users up to exercise this.'
  );
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
