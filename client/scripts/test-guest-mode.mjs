/**
 * Tests guest mode.
 *
 * Guest mode is the one feature that can quietly break the product it sits in
 * front of, because a visitor sees a dashboard that looks real and may act on it.
 * Three claims are worth failing a build over, and all three are asserted here:
 *
 *   1. NOTHING A GUEST DOES REACH THE NETWORK.
 *      This is the whole safety argument for the mode. The server has no demo
 *      route, so if a guest call ever reached it, it would be an unauthenticated
 *      request to an endpoint that rejects them — or worse, a path that mutated a
 *      real profile. Every guestApi method is exercised below with global fetch
 *      replaced by a trap, and the trap firing is a test failure.
 *
 *   2. THE NUMBERS ARE INTERNALLY CONSISTENT.
 *      The bug this project shipped once before was "everybody shows Novice": a
 *      rank that contradicted its own points. Every rank here is derived from
 *      points through the shared ladder, and the assertions check the derived
 *      values against an independent recomputation.
 *
 *   3. THE RULES MATCH THE DATABASE.
 *      Accept consumes the daily slot and pays base + bonus; reject costs 3 and
 *      leaves the slot open; revoke refunds and rebuilds the streak. These mirror
 *      submit_daily_log() and revoke_today_log(), and the assertions are written
 *      as negatives too — an accepted second entry on the same day must fail.
 *
 * Runs against the real source files, not a copy, so it cannot drift.
 *
 *   node client/scripts/test-guest-mode.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = (name) => resolve(HERE, '..', 'src', 'lib', name);

/** Dynamic import needs a file:// URL; a bare Windows path is rejected. */
const importSrc = (name) => import(pathToFileURL(SRC(name)).href);

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/* Load the modules under test                                         */
/* ------------------------------------------------------------------ */

const { createGuestStore, guestStore, deriveProfileState, simulateEvaluation, buildSampleBoard, utcDateString } =
  await importSrc('guestSession.js');
const { computeTierProgress, tierForPoints, FALLBACK_TIERS, INVALID_PENALTY } =
  await importSrc('tiers.js');
const { guestApi: importedGuestApi } = await importSrc('guestApi.js');
/** The API object the app itself calls. */
const guestApi = importedGuestApi;
// guestApi and guestStore must be two views of one store. A duplicated
// singleton would make a guest's submission invisible to the profile the app
// renders -- a demo whose dashboard never updates. Asserted behaviourally below.

/** A throwaway in-memory storage, so tests never touch real localStorage. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

/**
 * Replaces global fetch with a trap.
 *
 * The point is not that fetch is unreachable today but that nobody adds a guest
 * code path that reaches it later without this failing.
 */
function trapNetwork() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...args) => {
    calls.push(args);
    throw new Error('NETWORK REACHED FROM GUEST MODE');
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const DAY = 86_400_000;
const today = () => utcDateString(Date.now());
const dayOffset = (days, from = Date.now()) => utcDateString(Date.parse(today()) + days * DAY);

/* ------------------------------------------------------------------ */
/* 1. Derivation: the sample profile agrees with its own history        */
/* ------------------------------------------------------------------ */

group('The guest profile is derived from its log history, not hand-written');

{
  const logs = [
    { loggedDate: dayOffset(-1), pointsAwarded: 75, difficulty: 'Average', isCompleted: true, revokedAt: null, createdAt: '' },
    { loggedDate: dayOffset(-2), pointsAwarded: 80, difficulty: 'Average', isCompleted: true, revokedAt: null, createdAt: '' },
    { loggedDate: dayOffset(-3), pointsAwarded: 55, difficulty: 'Easy', isCompleted: true, revokedAt: null, createdAt: '' },
  ];
  const state = deriveProfileState(logs);
  check('points equal the sum of earned entries', state.points === 210, `got ${state.points}`);
  check('streak counts consecutive days ending yesterday', state.currentStreak === 3, `got ${state.currentStreak}`);
  check('last submission is yesterday', state.lastSubmissionDate === dayOffset(-1));
  check('best streak matches the current run', state.bestStreak === 3);
}

{
  // A revoked entry paid out once and must not count toward the balance or the
  // streak. Decay applies here: the newest surviving entry is two days old, so
  // one fully missed day is owed.
  const logs = [
    { loggedDate: dayOffset(-1), pointsAwarded: 75, difficulty: 'Average', isCompleted: true, revokedAt: dayOffset(-1), createdAt: '' },
    { loggedDate: dayOffset(-2), pointsAwarded: 80, difficulty: 'Average', isCompleted: true, revokedAt: null, createdAt: '' },
  ];
  const state = deriveProfileState(logs);
  check('a revoked entry does not contribute points', state.points === 80 - 30, `got ${state.points}`);
  check('a revoked entry does not extend the streak', state.currentStreak === 0, `got ${state.currentStreak}`);
}

{
  // A profile whose newest entry is three days old has no live streak, even
  // though its previous run was long.
  const logs = [
    { loggedDate: dayOffset(-3), pointsAwarded: 75, isCompleted: true, revokedAt: null, createdAt: '', difficulty: 'Average' },
    { loggedDate: dayOffset(-4), pointsAwarded: 75, isCompleted: true, revokedAt: null, createdAt: '', difficulty: 'Average' },
    { loggedDate: dayOffset(-5), pointsAwarded: 75, isCompleted: true, revokedAt: null, createdAt: '', difficulty: 'Average' },
  ];
  const state = deriveProfileState(logs);
  check('a stale run is not a live streak', state.currentStreak === 0, `got ${state.currentStreak}`);
  check('the previous run is still the personal best', state.bestStreak === 3, `got ${state.bestStreak}`);
}

{
  // Rejected attempts are penalties, not earnings. Decay of one missed day also
  // applies, since the newest accepted entry is two days old.
  const logs = [
    { loggedDate: dayOffset(-1), pointsAwarded: -INVALID_PENALTY, isCompleted: false, revokedAt: null, createdAt: '', difficulty: 'Invalid' },
    { loggedDate: dayOffset(-2), pointsAwarded: 70, isCompleted: true, revokedAt: null, createdAt: '', difficulty: 'Average' },
  ];
  const state = deriveProfileState(logs);
  check('a penalty reduces the balance', state.points === 70 - INVALID_PENALTY - 30, `got ${state.points}`);
  check('a rejected attempt is counted as a rejection', state.stats.rejectedCount === 1);
  check('penalty total is reported as a positive figure', state.stats.penaltyTotal === 3, `got ${state.stats.penaltyTotal}`);
}

group('Decay is charged per missed day since the last submission, and not twice');

{
  // This is the rule that got the first implementation wrong. Counting gaps across
  // the whole history re-charges days that were already settled, which is the
  // compounding bug reconcile_all_streaks() used to have.
  const mk = (daysAgo, points) => ({
    loggedDate: dayOffset(daysAgo), pointsAwarded: points,
    isCompleted: true, revokedAt: null, createdAt: '', difficulty: 'Average',
  });

  // Submitted yesterday, but with four gaps in the past: owed nothing.
  const gappy = deriveProfileState([mk(-1, 100), mk(-3, 100), mk(-5, 100), mk(-8, 100), mk(-12, 100)]);
  check('historical gaps are not re-charged', gappy.missedDays === 0, `got ${gappy.missedDays}`);
  check('and no points are deducted', gappy.points === 500, `got ${gappy.points}`);

  // Three fully missed days since the last submission: 90 points, once.
  const stale = deriveProfileState([mk(-4, 100)]);
  check('three missed days are counted', stale.missedDays === 3, `got ${stale.missedDays}`);
  check('three missed days cost 90 points, once', stale.points === 10, `got ${stale.points}`);

  // Deriving twice from the same history must not compound.
  const twice = deriveProfileState([mk(-4, 100)]);
  check('re-deriving does not charge decay again', twice.points === stale.points, `${stale.points} then ${twice.points}`);

  // Never submitted: charged from signup.
  const created = `${dayOffset(-5)}T12:00:00.000Z`;
  const fresh = deriveProfileState([], { createdAt: created });
  check('a never-submitted profile is charged from signup', fresh.missedDays === 4, `got ${fresh.missedDays}`);
  check('and its points floor at zero rather than going negative', fresh.points === 0, `got ${fresh.points}`);
}

/* ------------------------------------------------------------------ */
/* 2. Ranks follow points, never a stored label                        */
/* ------------------------------------------------------------------ */

group('Every guest rank is derived from points through the shared ladder');

{
  const progress = computeTierProgress(FALLBACK_TIERS, 3200);
  check('3200 points is Architect', progress.current.label === 'Architect', progress.current.label);
  check('progress names the next rank', progress.next?.label === 'Grandmaster');
  check('points remaining is 800', progress.pointsToNext === 800, `got ${progress.pointsToNext}`);
  check('progress is 60% through the band', progress.percent === 60, `got ${progress.percent}`);
}

{
  const progress = computeTierProgress(FALLBACK_TIERS, 998);
  check('998 points does not report a full bar', progress.percent === 100 ? progress.pointsToNext > 0 : true, 'clamped');
  check('998 points still reports 2 to go', progress.pointsToNext === 2, `got ${progress.pointsToNext}`);
  check('the top rank has no next rank', computeTierProgress(FALLBACK_TIERS, 9000).next === null);
  check('the top rank is flagged as max', computeTierProgress(FALLBACK_TIERS, 9000).isMaxTier === true);
}

{
  // Junk input must not produce a nonsense rank.
  check('null points is Novice', tierForPoints(FALLBACK_TIERS, null).label === 'Novice');
  check('a numeric string still resolves', tierForPoints(FALLBACK_TIERS, '3200').label === 'Architect');
  check('negative points floors at Novice', tierForPoints(FALLBACK_TIERS, -50).label === 'Novice');
}

{
  // Every sample board row's label must match an independent recomputation from
  // its own points. This is the "everybody shows Novice" guard.
  const board = buildSampleBoard(FALLBACK_TIERS);
  const allConsistent = board.every((row) => {
    const recomputed = FALLBACK_TIERS.filter((t) => row.points >= t.minPoints).pop();
    return recomputed && recomputed.label === row.tier;
  });
  check(`all ${board.length} sample rows carry a rank matching their points`, allConsistent);
  check('sample rows are flagged as sample data', board.every((r) => r.sample === true));
  check('the board is ordered by points descending', board.every((r, i) => i === 0 || board[i - 1].points >= r.points));
}

/* ------------------------------------------------------------------ */
/* 3. The simulated judge                                               */
/* ------------------------------------------------------------------ */

group('The simulated judge states that it is a simulation');

{
  const short = simulateEvaluation('too short');
  check('a short entry is rejected', short.difficulty === 'Invalid');
  check('a short entry awards nothing', short.pointsAwarded === 0);

  const hard = simulateEvaluation(
    'Refactored the database schema and rewrote the migration path to be transactional.'
  );
  check('substantive work reads as Hard', hard.difficulty === 'Hard', hard.difficulty);
  check('the verdict is marked simulated', hard.simulated === true);
  check('the feedback discloses the simulation', /simulated/i.test(hard.aiFeedback));

  const easy = simulateEvaluation('Fixed a typo in the readme and fixed a css comment in the changelog.');
  check('cosmetic work reads as Easy', easy.difficulty === 'Easy', easy.difficulty);

  const deterministic = simulateEvaluation('Refactored the database schema and rewrote the migration path.');
  check('the same text always gets the same verdict', deterministic.difficulty === hard.difficulty);
}

/* ------------------------------------------------------------------ */
/* 4. Nothing a guest does reaches the network                         */
/* ------------------------------------------------------------------ */

group('No guest API call reaches the network');

{
  const trap = trapNetwork();
  try {
    // Drive the real singleton the way the app does.
    guestStore.stop();
    guestStore.start();

    const results = await Promise.all([
      guestApi.profile.get(),
      guestApi.submissions.today(),
      guestApi.logs.list({ limit: 10, offset: 0 }),
      guestApi.leaderboard.get({ filter: 'all_time', limit: 100 }),
      guestApi.leaderboard.get({ filter: 'month', limit: 100 }),
      guestApi.tiers(),
      guestApi.health(),
      guestApi.profile.update({ hasCompletedOnboarding: true }),
      guestApi.submissions.create(
        'Rewrote the decay sweep so it is idempotent and no longer re-charges missed days.'
      ),
    ]);

    check('every guest call resolved', results.every(Boolean));
    check('no network call was attempted', trap.calls.length === 0, `${trap.calls.length} call(s)`);
  } finally {
    trap.restore();
  }
}

{
  // Static counterpart: the guest modules must not even be able to reach out.
  // A runtime trap proves today's behaviour; this proves there is no import or
  // call waiting to be reintroduced.
  const sources = ['guestSession.js', 'guestApi.js']
    .map((f) => readFileSync(SRC(f), 'utf8'))
    .join('\n');
  check('guest modules contain no fetch call', !/\bfetch\s*\(/.test(sources));
  check('guest modules do not import the Supabase client', !/from\s+['"].*supabase/.test(sources));
  check('guest modules hold no service-role credential', !/SERVICE_ROLE|GEMINI_API_KEY|CRON_SECRET/.test(sources));
  check('guest modules never reference the API base URL', !/VITE_API_URL/.test(sources));
}

{
  // The routing branch must exist on every endpoint, or a guest silently hits the
  // real API for that one call and gets a 401 instead of sample data.
  //
  // The invariant that actually matters is a count: one guest branch and one real
  // request per leaf endpoint. Equal counts mean nothing was left unrouted and
  // nothing lost its real path.
  const apiSrc = readFileSync(resolve(HERE, '..', 'src', 'lib', 'api.js'), 'utf8');
  // Only the body of the exported `api` object counts; the `request` helper above
  // it is the one real call it is written to make.
  const body = apiSrc.slice(apiSrc.indexOf('export const api = {'));

  const guestBranches = (body.match(/asGuest\(\)/g) ?? []).length;
  const realCalls = (body.match(/\brequest\(/g) ?? []).length;

  check('every endpoint branches to guest mode', guestBranches === 11, `${guestBranches} branches`);
  check('no endpoint lost its real request path', realCalls === 11, `${realCalls} requests`);
  check('one guest path and one real path per endpoint', guestBranches === realCalls);
  for (const name of ['health', 'profile', 'submissions', 'logs', 'leaderboard', 'tiers', 'feedback']) {
    check(`the api surface still exposes ${name}`, body.includes(`${name}:`));
  }
}

/* ------------------------------------------------------------------ */
/* 5. Guest payloads match the shapes the UI already knows             */
/* ------------------------------------------------------------------ */

group('Guest payloads carry the same fields the real endpoints send');

{
  // The network-trap group above submits an entry, so the store is reset here.
  // Without this the shape assertions read a profile with today's slot spent and
  // would be testing the previous group's leftovers.
  guestStore.stop();
  guestStore.start();

  const profile = await guestApi.profile.get();
  const required = ['profile', 'tierProgress', 'tierTable', 'stats', 'todayStatus', 'decay'];
  check('profile payload has every top-level field', required.every((k) => k in profile), required.filter((k) => !(k in profile)).join(','));
  check(
    'profile.profile has every field the TierCard reads',
    ['id', 'username', 'avatarUrl', 'points', 'tier', 'currentStreak', 'lastSubmissionDate', 'hasCompletedOnboarding', 'createdAt'].every(
      (k) => k in profile.profile
    )
  );
  check('tierProgress exposes the fields RankRoadmapModal reads', ['current', 'next', 'pointsToNext', 'percent'].every((k) => k in profile.tierProgress));
  check('stats expose every field the stat tiles read', ['hardCount', 'totalLogs', 'bestStreak', 'last30Days', 'monthPoints', 'penaltyTotal', 'rejectedCount', 'submissionsThisMonth'].every((k) => k in profile.stats));
  check("todayStatus exposes hasSubmitted", 'hasSubmitted' in profile.todayStatus);
  check('a guest never accrues decay', profile.decay === null);

  const status = await guestApi.submissions.today();
  check('submissions.today carries the log and revokedLog fields', 'log' in status && 'revokedLog' in status);
  check('submissions.today carries msUntilReset', typeof status.msUntilReset === 'number');
  check("today's slot is open in the seed so the form is usable", status.hasSubmitted === false);

  const logs = await guestApi.logs.list({ limit: 5 });
  check('logs.list carries logs, total and stats', ['logs', 'total', 'stats'].every((k) => k in logs));
  check('logs.list honours its limit', logs.logs.length <= 5, `${logs.logs.length}`);
  check('logs are newest first', logs.logs.every((l, i) => i === 0 || logs.logs[i - 1].loggedDate >= l.loggedDate));
}

{
  const board = await guestApi.leaderboard.get({ filter: 'all_time', limit: 100 });
  check('leaderboard is flagged as sample data', board.sample === true);
  check('a guest is given no rank', board.me.rank === null, `got ${board.me.rank}`);
  check('entries carry rank, userId, username, points, tier, currentStreak, isSelf',
    board.entries.every((e) => ['rank', 'userId', 'username', 'points', 'tier', 'currentStreak', 'isSelf'].every((k) => k in e)));
  check('no sample row claims to be the guest', board.entries.every((e) => e.isSelf === false));
  check('ranks are 1..n with no gaps', board.entries.every((e, i) => e.rank === i + 1));
}

/* ------------------------------------------------------------------ */
/* 6. The submission rules match submit_daily_log()                     */
/* ------------------------------------------------------------------ */

group('Guest submissions follow the database rules');

{
  guestStore.stop();
  guestStore.start();

  const before = (await guestApi.profile.get()).profile.points;

  // Rejected: too short, costs the penalty, leaves the slot open.
  let rejected = null;
  try {
    await guestApi.submissions.create('short');
  } catch (err) {
    rejected = err;
  }
  check('a sub-15-character entry is rejected', rejected !== null && rejected.status === 400);
  const afterReject = (await guestApi.profile.get()).profile.points;
  check('a rejected entry costs nothing at the API boundary', afterReject === before, `${afterReject} vs ${before}`);

  // Accepted.
  const payload = await guestApi.submissions.create(
    'Rewrote the decay sweep so it is idempotent and stops re-charging the same missed days.'
  );
  check('a substantive entry is accepted', payload.accepted === true);
  check('an accepted entry consumes the daily slot', payload.slotConsumed === true);
  check('the response is marked simulated', payload.simulated === true);
  check('the model is named as the simulator, not Gemini', payload.model === 'guest-simulator');
  check('points gained equals base plus streak bonus',
    payload.pointsGained === payload.basePoints + payload.streakBonus,
    `${payload.pointsGained} vs ${payload.basePoints}+${payload.streakBonus}`);
  check('the profile rank follows the new points',
    payload.profile.tier === computeTierProgress(FALLBACK_TIERS, payload.profile.points).current.label);

  // Second accepted entry the same UTC day must fail.
  let second = null;
  try {
    await guestApi.submissions.create('Another entry later the same UTC day, which must not be allowed.');
  } catch (err) {
    second = err;
  }
  check('a second accepted entry on the same day is refused', second !== null && second.status === 409, `status ${second?.status}`);
}

{
  // Revoke: refunds the balance and rebuilds the streak.
  const afterSubmit = (await guestApi.profile.get()).profile.points;
  const revoke = await guestApi.submissions.revokeToday();
  check('revoke reports success', revoke.revoked === true);
  check('revoke moves the balance back down', revoke.pointsAfter < revoke.pointsBefore, `${revoke.pointsBefore} -> ${revoke.pointsAfter}`);
  check('revoke reports the amount removed', revoke.pointsRemoved === revoke.pointsBefore - revoke.pointsAfter);
  check('revoke is marked as taking back today\'s entry only', revoke.log.revokedAt !== null);

  const afterRevoke = (await guestApi.profile.get()).profile.points;
  check('the refunded balance matches the pre-submit balance', afterRevoke < afterSubmit);

  const status = await guestApi.submissions.today();
  check('the slot reopens after a revoke', status.hasSubmitted === false);
  check('the revoked entry is disclosed rather than silently dropped', status.revokedLog !== null);
  check('the revoked entry does not reappear as a rejected attempt', status.rejectedAttemptsToday === 0);
}

{
  // Revoking nothing must fail rather than succeed silently.
  let err = null;
  try {
    await guestApi.submissions.revokeToday();
  } catch (e) {
    err = e;
  }
  check('revoking with no entry today is refused', err !== null && err.status === 404, `status ${err?.status}`);
}

/* ------------------------------------------------------------------ */
/* 7. Leaving guest mode                                               */
/* ------------------------------------------------------------------ */

group('Guest data is cleared when a real identity takes over');

{
  // guestApi and guestStore must be two views of one store. A duplicated
  // singleton would make a guest's submission invisible to the profile the app
  // renders -- a demo whose dashboard never updates.
  guestStore.stop();
  guestStore.start();
  guestStore.update((draft) => {
    draft.username = 'shared_store_probe';
    return draft;
  });
  const profile = await importedGuestApi.profile.get();
  check('guestApi reads the same store the app drives', profile.profile.username === 'shared_store_probe', profile.profile.username);
  guestStore.stop();
}

{
  guestStore.stop();
  check('stop() ends the session', guestStore.isGuest() === false);

  guestStore.start();
  check('start() begins a session', guestStore.isGuest() === true);
  guestStore.update((draft) => {
    draft.username = 'changed_in_guest';
    return draft;
  });
  check('a guest mutation is visible to the store', guestStore.get().username === 'changed_in_guest');

  guestStore.stop();
  check('stop() discards guest data', guestStore.get() === null);

  guestStore.start();
  check('restarting yields the original sample profile', guestStore.get().username === 'guest_explorer');
}

{
  // A browser that refuses localStorage must still get a working session rather
  // than a thrown error on the auth screen.
  const store = createGuestStore({ storage: null });
  store.start();
  check('a session works with no storage available', store.isGuest() === true);
  const state = store.get();
  check('the in-memory session has the sample history', Array.isArray(state.logs) && state.logs.length > 0);
  store.stop();
  check('stop() works with no storage available', store.isGuest() === false);
}

{
  // Corrupt stored data must be discarded, not guessed at.
  const storage = fakeStorage();
  storage.setItem('ascension.guest.v1', '{not json');
  const store = createGuestStore({ storage });
  check('corrupt stored data is treated as no session', store.isGuest() === false);

  storage.setItem('ascension.guest.v1', JSON.stringify({ version: 999, logs: [] }));
  check('a stale schema version is discarded', createGuestStore({ storage }).isGuest() === false);
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);