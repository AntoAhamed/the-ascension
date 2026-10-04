/**
 * Guest ("explore without an account") session state.
 *
 * SCOPE, deliberately narrow
 *   Everything here is browser-side. The server has no demo mode, no seeded users
 *   and no auth bypass, so there is no code path by which a guest reaches a real
 *   profile or writes a row to `profiles` or `daily_logs`. Guest state is built
 *   here and kept under a single localStorage key.
 *
 * WHY A PLAIN MODULE AND NOT REACT STATE
 *   lib/api.js has to know whether a call is a guest call, and AuthContext
 *   imports lib/api.js. Reading the flag from a module that AuthContext also
 *   imports keeps the dependency one-way; reading it from context would make
 *   api.js import AuthContext and close a cycle.
 *
 * WHY THE SEED IS DERIVED, NOT HAND-WRITTEN
 *   Points, streak, best streak and stats are all computed from the sample log
 *   history using the same rules the database applies. Hard-coding a plausible
 *   looking number for each would let the sample profile contradict itself --
 *   a 3,200-point profile labelled Novice is exactly the class of bug that is
 *   invisible until a user notices it.
 */
import {
  DECAY_PER_DAY,
  DIFFICULTY_META,
  FALLBACK_TIERS,
  INVALID_PENALTY,
  streakBonusFor,
  tierForPoints,
} from './tiers.js';

export const GUEST_STORAGE_KEY = 'ascension.guest.v1';

/** Bumped when the stored shape changes so old guest data is discarded, not misread. */
const GUEST_SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Dates -- UTC everywhere, to match the database                      */
/* ------------------------------------------------------------------ */

export function utcDateString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

/** Whole UTC days between two YYYY-MM-DD strings. */
function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

/* ------------------------------------------------------------------ */
/* Seed history                                                        */
/* ------------------------------------------------------------------ */

/**
 * The sample history, newest first. `daysAgo` is relative to the day the guest
 * opens the app, so the demo never looks stale.
 *
 * Today is intentionally absent: the daily entry form has to be usable, which
 * means today's slot must be open. The streak therefore runs up to yesterday,
 * which is the same state a real user is in every morning.
 */
const SEED_HISTORY = [
  [1, 'Hard', 'Rewrote the leaderboard query as a single set-based statement instead of a per-row loop.'],
  [2, 'Average', 'Traced a memory leak to an un-cleared interval in the polling hook and removed it.'],
  [3, 'Easy', 'Fixed a typo in the deployment documentation.'],
  [4, 'Hard', 'Added a transaction around the submission path so a partial write can no longer leave a profile and its log disagreeing.'],
  [5, 'Average', 'Wrote regression tests for the points-to-rank lookup at every tier boundary.'],
  [6, 'Average', 'Replaced a hand-rolled debounce with a real one and fixed the stale-closure bug it was hiding.'],
  [8, 'Hard', 'Designed the streak decay rules and wrote down the edge cases before implementing them.'],
  [9, 'Easy', 'Tidied the CSS and removed twelve unused utility classes.'],
  [10, 'Average', 'Added rate limiting to the submission endpoint so a runaway loop cannot burn the API budget.'],
  [12, 'Hard', 'Migrated the auth layer to JWT verification and removed the mock bypass entirely.'],
  [13, 'Average', 'Profiled the dashboard render and cut the redundant refetch on tab switch.'],
  [14, 'Easy', 'Wrote the changelog entry for the previous release.'],
  [15, 'Average', 'Fixed a timezone bug where the daily window rolled over at local midnight instead of UTC.'],
  [16, 'Hard', 'Built the schema migration for tier thresholds with rollback steps documented.'],
  [18, 'Average', 'Reviewed an old pull request and left comments on the error handling.'],
  [20, 'Easy', 'Cleaned up unused dependencies and re-checked the bundle size.'],
  [21, 'Average', 'Set up the CI pipeline for lint and tests.'],
];

/* ------------------------------------------------------------------ */
/* Deriving profile state from the log history                         */
/* ------------------------------------------------------------------ */

/**
 * Longest run of consecutive logged days ending at the newest entry, but only
 * while that entry is today or yesterday.
 *
 * Mirrors the database, where a streak survives "today not submitted yet" but
 * dies once a whole day is missed. A profile whose newest entry is three days old
 * has a streak of 0 no matter how long its previous run was.
 *
 * Revoked entries are excluded: revoke_today_log() rebuilds the streak from the
 * completed logs that survive, so an entry the user took back must not keep
 * extending it.
 */
function deriveStreaks(logs) {
  const dates = new Set(
    logs.filter((l) => l.isCompleted && !l.revokedAt).map((l) => l.loggedDate)
  );

  let best = 0;
  for (const date of dates) {
    let cursor = utcDateString(Date.parse(`${date}T00:00:00Z`) + DAY_MS);
    let run = 1;
    while (dates.has(cursor)) {
      run += 1;
      cursor = utcDateString(Date.parse(`${cursor}T00:00:00Z`) + DAY_MS);
    }
    best = Math.max(best, run);
  }

  const today = utcDateString(Date.now());
  const yesterday = utcDateString(Date.parse(`${today}T00:00:00Z`) - DAY_MS);
  let current = 0;
  if (dates.has(today) || dates.has(yesterday)) {
    let cursor = dates.has(today) ? today : yesterday;
    while (dates.has(cursor)) {
      current += 1;
      cursor = utcDateString(Date.parse(`${cursor}T00:00:00Z`) - DAY_MS);
    }
  }

  return { currentStreak: current, bestStreak: best };
}

/**
 * Rebuilds everything the profile card and stats panel read from a log list.
 *
 * This is the single place guest numbers are produced, so the dashboard, the
 * history feed and the leaderboard can never disagree with each other.
 *
 * DECAY, and why it is measured from the newest entry rather than across the
 * whole history. The database charges 30 points per fully missed day, settled
 * lazily on every read, so someone who submitted yesterday has missed nothing no
 * matter how many gaps sit further back — those days were charged already and the
 * settlement cursor has moved past them. Counting historical gaps instead would
 * re-charge every past gap on every load, which is exactly the compounding bug
 * that lived in reconcile_all_streaks() before it was fixed.
 */
export function deriveProfileState(logs, { now = Date.now(), createdAt = null } = {}) {
  const today = utcDateString(now);
  const completed = logs.filter((l) => l.isCompleted && !l.revokedAt);

  // The balance is the NET of every entry that still stands, not just the wins.
  // A rejected attempt carries a negative points_awarded and is a real deduction
  // from the profile, so summing accepted entries alone would quietly forgive
  // every penalty a guest had collected.
  const earned = logs
    .filter((l) => !l.revokedAt)
    .reduce((sum, l) => sum + l.pointsAwarded, 0);

  const newest = completed.length
    ? completed.map((l) => l.loggedDate).sort().pop()
    : null;

  // Never submitted: charge from signup, which is apply_decay()'s null branch.
  const missedDays = newest
    ? Math.max(0, daysBetween(newest, today) - 1)
    : createdAt
      ? Math.max(0, daysBetween(utcDateString(Date.parse(createdAt)), today) - 1)
      : 0;

  const { currentStreak, bestStreak } = deriveStreaks(logs);
  const points = Math.max(0, earned - missedDays * DECAY_PER_DAY);

  return {
    points,
    currentStreak,
    bestStreak,
    lastSubmissionDate: newest,
    missedDays,
    stats: {
      hardCount: completed.filter((l) => l.difficulty === 'Hard').length,
      totalLogs: logs.length,
      bestStreak,
      last30Days: logs
        .filter((l) => !l.revokedAt && daysBetween(l.loggedDate, today) <= 30)
        .reduce((sum, l) => sum + l.pointsAwarded, 0),
      monthPoints: logs
        .filter((l) => !l.revokedAt && l.loggedDate.slice(0, 7) === today.slice(0, 7))
        .reduce((sum, l) => sum + l.pointsAwarded, 0),
      penaltyTotal: logs
        .filter((l) => !l.isCompleted)
        .reduce((sum, l) => sum + Math.abs(l.pointsAwarded), 0),
      rejectedCount: logs.filter((l) => !l.isCompleted).length,
      submissionsThisMonth: logs.filter((l) => l.loggedDate.slice(0, 7) === today.slice(0, 7)).length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

function safeStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Private-mode Safari and locked-down browsers throw on access, not on use.
    return null;
  }
}

function makeLogId(seed) {
  return `guest-log-${seed}`;
}

/**
 * Builds the initial sample state. Deterministic on purpose: the same day always
 * produces the same demo, so a bug report that says "the leaderboard shows
 * Architect" can be reproduced.
 */
function buildSeedState({ now = Date.now() } = {}) {
  const today = utcDateString(now);
  const todayMs = Date.parse(`${today}T00:00:00Z`);

  const logs = SEED_HISTORY.map(([daysAgo, difficulty, taskDescription]) => {
    const loggedDate = utcDateString(todayMs - daysAgo * DAY_MS);
    const basePoints = DIFFICULTY_META[difficulty].basePoints;
    // Streak bonus is illustrative here; the real number comes from the server.
    const streakBonus = streakBonusFor(Math.max(1, 21 - daysAgo));
    return {
      id: makeLogId(loggedDate),
      taskDescription,
      difficulty,
      pointsAwarded: basePoints + streakBonus,
      basePoints,
      streakBonus,
      penaltyPoints: 0,
      isCompleted: true,
      revokedAt: null,
      aiFeedback:
        'Clear and specific. Naming the system you changed and the effect it had is exactly what makes an entry strong.',
      reasoning: 'Guest sample entry.',
      loggedDate,
      createdAt: new Date(todayMs - daysAgo * DAY_MS + 18 * 3600_000).toISOString(),
    };
  });

  return {
    version: GUEST_SCHEMA_VERSION,
    username: 'guest_explorer',
    avatarUrl: null,
    // Set so the onboarding modal -- which writes a real username -- never opens
    // for a guest, who has nowhere to save one.
    hasCompletedOnboarding: true,
    createdAt: new Date(todayMs - 21 * DAY_MS).toISOString(),
    logs,
    /** Bumped on every mutation so React consumers can resync. */
    revision: 0,
  };
}

/**
 * The store.
 *
 * `storage` is injectable so tests can run without a DOM, and so a browser that
 * refuses localStorage degrades to an in-memory session instead of throwing.
 */
export function createGuestStore({ storage = safeStorage(), now = () => Date.now() } = {}) {
  const memory = { value: null };
  const listeners = new Set();

  const readRaw = () => {
    try {
      return storage ? storage.getItem(GUEST_STORAGE_KEY) : null;
    } catch {
      return null;
    }
  };

  const writeRaw = (value) => {
    memory.value = value;
    try {
      if (storage) storage.setItem(GUEST_STORAGE_KEY, value);
    } catch {
      // Quota or a locked-down browser. The in-memory copy above still works for
      // this tab, which is all a guest needs.
    }
  };

  const clearRaw = () => {
    memory.value = null;
    try {
      if (storage) storage.removeItem(GUEST_STORAGE_KEY);
    } catch {
      /* nothing useful to do */
    }
  };

  const emit = (state) => {
    for (const listener of listeners) listener(state);
  };

  const load = () => {
    const raw = readRaw() ?? memory.value;
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt or hand-edited. Dropping it is safer than guessing at a shape.
      clearRaw();
      return null;
    }
    if (parsed?.version !== GUEST_SCHEMA_VERSION || !Array.isArray(parsed.logs)) {
      clearRaw();
      return null;
    }
    return parsed;
  };

  const save = (state) => {
    const next = { ...state, revision: (state.revision ?? 0) + 1 };
    writeRaw(JSON.stringify(next));
    emit(next);
    return next;
  };

  return {
    /** True when a guest session exists. Cheap enough to call per request. */
    isGuest() {
      return load() !== null;
    },

    get() {
      return load();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      const existing = load();
      const state = existing ?? buildSeedState({ now: now() });
      writeRaw(JSON.stringify(state));
      emit(state);
      return state;
    },

    stop() {
      clearRaw();
      emit(null);
    },

    /** Applies a mutation to the current state and persists the result. */
    update(mutator) {
      const current = load();
      if (!current) return null;
      const next = mutator(structuredClone(current));
      if (!next) return null;
      return save(next);
    },

    /** Discards guest data and returns a fresh sample session. */
    reset() {
      const state = buildSeedState({ now: now() });
      writeRaw(JSON.stringify(state));
      emit(state);
      return state;
    },
  };
}

/** The store the app uses. */
export const guestStore = createGuestStore();

/* ------------------------------------------------------------------ */
/* The simulated judge                                                 */
/* ------------------------------------------------------------------ */

/**
 * A stand-in for the Gemini judge, for guest sessions only.
 *
 * This is a SIMULATION, and the payload it returns says so via `simulated: true`.
 * It exists because a guest has no account to authenticate with, so there is no
 * request the server would accept; there is no way to run the real model here
 * that would not require the auth path this mode deliberately does not touch.
 *
 * It reads the same keywords and the same minimum length as the real evaluator's
 * contract so the UI is exercised realistically -- but a real user will get
 * different verdicts for the same text, and that difference is the point.
 */
export function simulateEvaluation(taskDescription, { streak = 0 } = {}) {
  const text = String(taskDescription ?? '').trim();

  // Same 15-character floor the API enforces, so the form's own validation and
  // this agree about what counts as an entry.
  if (text.length < 15) {
    return {
      difficulty: 'Invalid',
      pointsAwarded: 0,
      aiFeedback:
        'That is too short to judge. Describe one concrete thing you finished today: what it was, and what changed because of it.',
      reasoning: 'Entry below the 15-character minimum.',
      simulated: true,
    };
  }

  const HARD_HINTS = [
    'refactor', 'migrat', 'architect', 'schema', 'transaction', 'performance',
    'profil', 'rewrite', 'redesign', 'optimis', 'optimiz', 'security', 'race condition',
  ];
  const EASY_HINTS = ['typo', 'rename', 'comment', 'format', 'css', 'copy', 'readme', 'changelog'];

  const lower = text.toLowerCase();
  const score = (hints) => hints.reduce((n, h) => (lower.includes(h) ? n + 1 : n), 0);

  let difficulty = 'Average';
  if (score(EASY_HINTS) >= 2) difficulty = 'Easy';
  if (score(HARD_HINTS) >= 2) difficulty = 'Hard';

  const basePoints = DIFFICULTY_META[difficulty].basePoints;
  const streakBonus = streakBonusFor(streak + 1);

  const feedback = {
    Hard: 'This is the kind of entry the ladder rewards: a specific, bounded change with real consequences behind it.',
    Average: 'Solid, concrete work. Pushing the detail further — what broke before, and what the change made possible — would put this in Hard territory.',
    Easy: 'A small but genuine task. Worth logging: consistency is what the streak bonus is actually paying for.',
  }[difficulty];

  return {
    difficulty,
    pointsAwarded: basePoints,
    aiFeedback: `${feedback} (Simulated judgement — guest mode does not call the real model.)`,
    reasoning: 'Deterministic keyword heuristic used for guest preview.',
    simulated: true,
    basePoints,
    streakBonus,
  };
}

/**
 * Sample rivals for the guest leaderboard.
 *
 * Fabricated and labelled as such wherever it is displayed. The guest's own row
 * is included so the board is not a list of strangers, but they are never given a
 * rank: there is no live board for them to be on. Module-private: the board is
 * only consumed through buildSampleBoard().
 */
const SAMPLE_RIVALS = [
  { username: 'nova_builds', days: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], difficulty: 'Hard' },
  { username: 'quiet_hours', days: [1, 2, 3, 5, 6, 7, 9, 10, 12], difficulty: 'Average' },
  { username: 'ship_it_daily', days: [1, 2, 3, 4, 5, 7, 8, 9], difficulty: 'Average' },
  { username: 'mira_writes', days: [1, 3, 4, 6, 7, 8], difficulty: 'Easy' },
  { username: 'deep_work_dan', days: [1, 2, 4, 5, 6, 8], difficulty: 'Hard' },
  { username: 'small_steps', days: [2, 3, 5, 6, 9], difficulty: 'Easy' },
  { username: 'arc_second', days: [1, 2, 4], difficulty: 'Hard' },
];

export function buildSampleBoard(tierTable = FALLBACK_TIERS, { now = Date.now() } = {}) {
  const todayMs = Date.parse(`${utcDateString(now)}T00:00:00Z`);

  const rows = SAMPLE_RIVALS.map((rival) => {
    const points = rival.days.reduce(
      (sum, daysAgo) => sum + DIFFICULTY_META[rival.difficulty].basePoints + 10,
      0
    );
    return {
      userId: `sample-${rival.username}`,
      username: rival.username,
      avatarUrl: null,
      points,
      // Derived through the same lookup the real API uses, so a sample row can
      // never carry a rank its own points contradict.
      tier: tierForPoints(tierTable, points).label,
      currentStreak: Math.max(...rival.days.map((d) => 21 - d)),
      loggedToday: rival.days.includes(1),
      lastSubmissionDate: utcDateString(todayMs - Math.min(...rival.days) * DAY_MS),
      sample: true,
    };
  });

  return rows.sort((a, b) => b.points - a.points || b.currentStreak - a.currentStreak);
}

export { INVALID_PENALTY };