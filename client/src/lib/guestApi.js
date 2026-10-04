/**
 * Guest implementations of every API method.
 *
 * The contract this file has to keep is SHAPE, not behaviour: each function must
 * resolve to the same object the real endpoint returns, because every component
 * above it is unchanged and knows only the real shape. If a field drifts here,
 * the guest view breaks while the real view works -- which is exactly how a demo
 * mode starts lying about the product.
 *
 * Every response is built from the guest store. Nothing here performs a fetch,
 * which is what guarantees a guest cannot write to `profiles` or `daily_logs`:
 * there is no code path from this file to the network.
 */
import { ApiError } from './apiError.js';
import {
  INVALID_PENALTY,
  buildSampleBoard,
  deriveProfileState,
  guestStore,
  simulateEvaluation,
  utcDateString,
} from './guestSession.js';
import {
  DIFFICULTY_META,
  FALLBACK_TIERS,
  computeTierProgress,
  msUntilUtcMidnight,
  tierForPoints,
} from './tiers.js';

/** id used by the guest profile. Not a uuid, and never sent anywhere. */
const GUEST_ID = 'guest-explorer';

const today = () => utcDateString(Date.now());

/** Logs newest first, the order the history feed and the real endpoint both use. */
const byNewest = (a, b) =>
  a.loggedDate === b.loggedDate
    ? String(b.createdAt).localeCompare(String(a.createdAt))
    : b.loggedDate.localeCompare(a.loggedDate);

function requireState() {
  const state = guestStore.get();
  if (!state) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'You are not signed in.');
  }
  return state;
}

/** The tier table the guest session ranks against. */
const tierTable = () => FALLBACK_TIERS;

/**
 * Derives profile numbers for a guest state.
 *
 * `createdAt` is threaded through because a guest who has never submitted is
 * charged decay from signup — the same null branch apply_decay() takes — and
 * dropping it would silently exempt exactly the newest profiles from the rule.
 */
const deriveFrom = (state) => deriveProfileState(state.logs, { createdAt: state.createdAt });

/** The profile object, mirroring GET /api/profile's `profile` field. */
function buildProfile(state) {
  const { points, currentStreak, lastSubmissionDate } = deriveFrom(state);
  return {
    id: GUEST_ID,
    username: state.username,
    avatarUrl: state.avatarUrl,
    points,
    // Derived from points through the shared ladder, never read from a stored
    // label, so it cannot go stale.
    tier: tierForPoints(tierTable(), points).label,
    currentStreak,
    lastSubmissionDate,
    hasCompletedOnboarding: state.hasCompletedOnboarding,
    createdAt: state.createdAt,
  };
}



function buildTodayStatus(state) {
  const t = today();
  const forToday = state.logs.filter((l) => l.loggedDate === t);
  const completedLog = forToday.find((l) => l.isCompleted && !l.revokedAt) ?? null;
  const revokedLog = forToday.find((l) => l.revokedAt) ?? null;
  const rejected = forToday.filter((l) => !l.isCompleted && !l.revokedAt);

  return {
    hasSubmitted: Boolean(completedLog),
    completedLog,
    revokedLog,
    rejectedAttemptsToday: rejected.length,
    penaltyToday: rejected.reduce((sum, l) => sum + Math.abs(l.pointsAwarded), 0),
    utcNow: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    msUntilReset: msUntilUtcMidnight(),
  };
}

export const guestApi = {
  health: () => Promise.resolve({ ok: true, time: new Date().toISOString() }),

  tiers: () => Promise.resolve({ tiers: tierTable() }),

  profile: {
    get: () => {
      const state = requireState();
      const { points, stats } = deriveFrom(state);
      return Promise.resolve({
        profile: buildProfile(state),
        tierProgress: computeTierProgress(tierTable(), points),
        tierTable: tierTable(),
        stats,
        todayStatus: buildTodayStatus(state),
        // A guest never accrues decay: there is no calendar to fall behind on.
        decay: null,
      });
    },

    update: (patch) => {
      const state = requireState();
      // The real endpoint rejects an empty body rather than silently succeeding.
      if (!patch || Object.keys(patch).length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Nothing to update');
      }
      if (patch.username !== undefined) {
        const username = String(patch.username).trim();
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            'Use 3-20 letters, numbers and underscores only'
          );
        }
      }

      const next = guestStore.update((draft) => {
        if (patch.username !== undefined) draft.username = String(patch.username).trim();
        if (patch.hasCompletedOnboarding !== undefined) {
          draft.hasCompletedOnboarding = Boolean(patch.hasCompletedOnboarding);
        }
        return draft;
      });

      return Promise.resolve({ profile: buildProfile(next) });
    },
    delete: () => {
      return Promise.reject(new ApiError(400, 'GUEST', 'Cannot delete guest account.'));
    },
  },

  submissions: {
    today: () => {
      const state = requireState();
      const status = buildTodayStatus(state);
      return Promise.resolve({
        hasSubmitted: status.hasSubmitted,
        log: status.completedLog,
        revokedLog: status.revokedLog,
        rejectedAttemptsToday: status.rejectedAttemptsToday,
        penaltyToday: status.penaltyToday,
        msUntilReset: status.msUntilReset,
      });
    },

    /**
     * The simulated submission.
     *
     * Mirrors submit_daily_log()'s two outcomes: an accepted entry consumes the
     * daily slot and pays base + streak bonus, a rejected one costs a flat
     * penalty and leaves the slot open so it can be retried.
     */
    create: (taskDescription) => {
      const state = requireState();
      const text = String(taskDescription ?? '').trim();

      if (text.length < 15) {
        throw new ApiError(400, 'BAD_REQUEST', 'Describe your work in at least 15 characters.');
      }

      const status = buildTodayStatus(state);
      if (status.hasSubmitted) {
        throw new ApiError(
          409,
          'SLOT_COMPLETED',
          `You already logged today. Revoke it first to submit a replacement.`
        );
      }

      const before = deriveFrom(state);
      const evaluation = simulateEvaluation(text, { streak: before.currentStreak });
      const accepted = evaluation.difficulty !== 'Invalid';
      const t = today();

      const next = guestStore.update((draft) => {
        const log = {
          id: `guest-log-${t}-${draft.logs.length}`,
          taskDescription: text,
          difficulty: evaluation.difficulty,
          pointsAwarded: accepted
            ? evaluation.basePoints + evaluation.streakBonus
            : -INVALID_PENALTY,
          basePoints: accepted ? evaluation.basePoints : 0,
          streakBonus: accepted ? evaluation.streakBonus : 0,
          penaltyPoints: accepted ? 0 : INVALID_PENALTY,
          isCompleted: accepted,
          revokedAt: null,
          aiFeedback: evaluation.aiFeedback,
          reasoning: evaluation.reasoning,
          loggedDate: t,
          createdAt: new Date().toISOString(),
        };
        // A revoke earlier today already logged something, so this is a
        // replacement rather than a first attempt.
        draft.logs = draft.logs.map((l) =>
          l.loggedDate === t && l.revokedAt === null && l.isCompleted
            ? { ...l, revokedAt: new Date().toISOString() }
            : l
        );
        draft.logs.push(log);
        draft.logs.sort(byNewest);
        return draft;
      });

      const after = deriveFrom(next);
      const delta = after.points - before.points;

      return Promise.resolve({
        accepted,
        slotConsumed: accepted,
        evaluation,
        log: next.logs.find((l) => l.loggedDate === t && l.isCompleted && !l.revokedAt) ?? null,
        profile: buildProfile(next),
        pointsGained: delta,
        basePoints: accepted ? evaluation.basePoints : 0,
        streakBonus: accepted ? evaluation.streakBonus : 0,
        penaltyPoints: accepted ? 0 : INVALID_PENALTY,
        pointsBefore: before.points,
        tierProgress: computeTierProgress(tierTable(), after.points),
        model: 'guest-simulator',
        latencyMs: 0,
        simulated: true,
      });
    },

    revokeToday: () => {
      const state = requireState();
      const t = today();
      const target = state.logs.find(
        (l) => l.loggedDate === t && l.isCompleted && !l.revokedAt
      );
      if (!target) {
        throw new ApiError(404, 'NO_LOG', "There is no accepted entry to revoke today.");
      }

      const before = deriveFrom(state);

      const next = guestStore.update((draft) => {
        draft.logs = draft.logs.map((l) =>
          l.id === target.id ? { ...l, revokedAt: new Date().toISOString() } : l
        );
        return draft;
      });

      const after = deriveFrom(next);
      const tierBefore = tierForPoints(tierTable(), before.points).label;
      const tierAfter = tierForPoints(tierTable(), after.points).label;

      return Promise.resolve({
        revoked: true,
        log: { ...target, revokedAt: next.logs.find((l) => l.id === target.id).revokedAt },
        profile: buildProfile(next),
        // What the balance actually moved by, which is not always what the entry
        // paid -- the same distinction the real endpoint draws.
        pointsRemoved: before.points - after.points,
        pointsBefore: before.points,
        pointsAfter: after.points,
        streakBefore: before.currentStreak,
        streakAfter: after.currentStreak,
        streakBroken: after.currentStreak < before.currentStreak,
        tierBefore,
        tierAfter,
        tierChanged: tierBefore !== tierAfter,
        tierProgress: computeTierProgress(tierTable(), after.points),
      });
    },
  },

  logs: {
    list: ({ limit = 50, offset = 0 } = {}) => {
      const state = requireState();
      const { stats } = deriveFrom(state);
      const all = state.logs.slice().sort(byNewest);
      return Promise.resolve({
        logs: all.slice(offset, offset + limit),
        total: all.length,
        stats,
      });
    },
  },

  /**
   * A clearly-labelled sample board.
   *
   * `sample: true` is the flag the UI keys off to show the "not the live board"
   * notice. The guest gets `rank: null` rather than a position: they are not on a
   * real leaderboard, and showing them a rank would imply otherwise.
   */
  leaderboard: {
    get: ({ filter = 'all_time', limit = 100 } = {}) => {
      const state = requireState();
      const { points, currentStreak } = deriveFrom(state);
      const board = buildSampleBoard(tierTable());

      const ranked = board.map((row, i) => ({
        rank: i + 1,
        userId: row.userId,
        username: row.username,
        avatarUrl: row.avatarUrl,
        score: filter === 'month' ? row.points : row.points,
        points: row.points,
        // Same rule as the real serializer: rank follows all-time points, even on
        // a monthly board.
        tier: tierForPoints(tierTable(), row.points).label,
        currentStreak: row.currentStreak,
        isSelf: false,
        sample: true,
      }));

      return Promise.resolve({
        filter,
        entries: ranked.slice(0, limit),
        me: { rank: null, score: points, totalPlayers: ranked.length, currentStreak },
        tierTable: tierTable(),
        sample: true,
      });
    },
  },
  profile: {
    get: () => {
      const state = requireState();
      const { points, stats } = deriveFrom(state);
      return Promise.resolve({
        profile: buildProfile(state),
        tierProgress: computeTierProgress(tierTable(), points),
        tierTable: tierTable(),
        stats,
        todayStatus: buildTodayStatus(state),
        decay: null,
      });
    },
    update: (patch) => {
      if (!patch || Object.keys(patch).length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Nothing to update');
      }
      if (patch.username !== undefined) {
        const username = String(patch.username).trim();
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
          throw new ApiError(400, 'INVALID', 'Username must be 3-20 chars, letters/numbers/underscore');
        }
      }
      const next = guestStore.update((draft) => {
        if (patch.username !== undefined) {
          draft.username = String(patch.username).trim();
        }
        if (patch.hasCompletedOnboarding !== undefined) {
          draft.hasCompletedOnboarding = Boolean(patch.hasCompletedOnboarding);
        }
        return draft;
      });
      if (!next) return Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Not signed in'));
      const after = deriveFrom(next);
      return Promise.resolve({
        profile: buildProfile(next),
        tierProgress: computeTierProgress(tierTable(), after.points),
        tierTable: tierTable(),
      });
    },
    delete: () => {
      return Promise.reject(new ApiError(400, 'GUEST', 'Cannot delete guest account.'));
    },
  },
  feedback: {
    submit: () => Promise.reject(new ApiError(400, 'GUEST', 'Feedback not available in guest mode.')),
  },
};

export { DIFFICULTY_META };
