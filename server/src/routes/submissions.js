/**
 * The daily submission engine.
 *
 * POST /api/submissions
 *   1. Validate input
 *   2. Ask Gemini to judge it
 *   3. Persist atomically via submit_daily_log(), which branches:
 *
 *        ACCEPTED -> awards points + streak bonus, consumes the daily slot
 *        REJECTED -> deducts a 3-point penalty, slot STAYS OPEN so the user
 *                    can retry immediately
 *
 * GET /api/submissions/today
 *   Whether the daily slot is spent, plus today's rejected-attempt tally.
 *
 * DELETE /api/submissions/today
 *   Undoes today's ACCEPTED submission so a higher-impact one can replace it.
 *   The database verifies the log is still dated to the current UTC day; past
 *   days are permanently locked. Points and the streak bonus are given back and
 *   the slot reopens.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler, badRequest, translateDbError } from '../lib/errors.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { config } from '../config/env.js';
import { getSupabaseAdmin } from '../config/supabaseAdmin.js';
import { classifyJudgeFailure, evaluateSubmission } from '../services/gemini.js';
import {
  computeTierProgress,
  getTierForPoints,
  INVALID_PENALTY,
} from '../lib/tiers.js';

export const submissionRouter = Router();
submissionRouter.use(requireAuth);

const db = () => getSupabaseAdmin();

/** Re-exported so other modules can reference the single source of truth. */
export { INVALID_PENALTY };

const submitSchema = z.object({
  taskDescription: z
    .string()
    .trim()
    .min(15, 'Describe your work in at least 15 characters.')
    .max(1500, 'Keep your entry under 1500 characters.'),
});

/**
 * Rate limit on the submission endpoint, keyed per authenticated user.
 *
 * This is the abuse boundary that matters: POST /api/submissions spends a Gemini
 * call on every request that passes validation, so a loop (a shared script, a
 * stolen token, a runaway client retrying on network errors) would burn real money
 * and quota. The one-per-day rule for ACCEPTED entries is enforced by the database
 * and does not protect the judge — a rejected attempt is still a paid call, which
 * is precisely why `skipSuccessfulRequests` is NOT set here: a rejection returns
 * 201 and would otherwise be treated as success and exempted.
 *
 * Keyed on req.user.id rather than IP, so one office behind a single NAT is not
 * throttled as a unit. The ceiling is hourly and well above a day of honest use:
 * a legitimate user who gets several rejections in a row retries a handful of
 * times, and 30 leaves plenty of headroom while capping the cost of an attack.
 */
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id ?? req.ip,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many attempts. Wait a few minutes before trying again — your day is not lost.',
    },
  },
});

/**
 * Separate, tighter limit on the revoke endpoint.
 *
 * A revoke is a rare, deliberate action — once or twice a day at most. There is
 * no legitimate pattern of more than a handful, so a low ceiling here is pure
 * upside: it costs an honest user nothing and removes a cheap way to churn a
 * profile's points and streak.
 */
const revokeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip,
  // Safe here, unlike on submit: a revoke costs no Gemini call and no point
  // change when it fails, so exempting the 2xx case only spares an honest user
  // from ever hitting this ceiling.
  skipSuccessfulRequests: true,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many replacement attempts. Try again in a few minutes.',
    },
  },
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

submissionRouter.get(
  '/today',
  asyncHandler(async (req, res) => {
    const { data: status, error: statusErr } = await db().rpc('get_today_status', {
      p_self_id: req.user.id,
    });
    if (statusErr) throw statusErr;
    res.json({
      hasSubmitted: Boolean(status?.hasSubmitted),
      log: status?.completedLog ? serializeLog(status.completedLog) : null,
      revokedLog: status?.revokedLog ? serializeLog(status.revokedLog) : null,
      rejectedAttemptsToday: status?.rejectedAttemptsToday ?? 0,
      penaltyToday: status?.penaltyToday ?? 0,
      msUntilReset: status?.msUntilReset ?? 0,
    });
  })
);

/**
 * DELETE /api/submissions/today
 *
 * Takes back today's accepted submission so the user can log something better.
 * The whole operation lives in one database transaction (revoke_today_log):
 * the same-day guard, the row lock, the refund, the streak rebuild and the tier
 * recompute either all happen or none do.
 */
submissionRouter.delete(
  '/today',
  revokeLimiter,
  asyncHandler(async (req, res) => {
    const { data, error } = await db().rpc('revoke_today_log', { p_user_id: req.user.id });
    if (error) {
      const translated = translateDbError(error);
      if (translated) throw translated;
      throw error;
    }

    res.json(serializeRevoke(data ?? {}));
  })
);

submissionRouter.post(
  '/',
  submitLimiter,
  asyncHandler(async (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        parsed.error.issues.map((i) => i.message).join('; '),
        parsed.error.issues
      );
    }

    const { taskDescription } = parsed.data;
    const userId = req.user.id;

    // Load just enough context to give the judge a better picture.
    const { data: profile } = await db()
      .from('profiles')
      .select('username, current_streak')
      .eq('id', userId)
      .maybeSingle();

    // 1. Judge
    let judgement;
    try {
      judgement = await evaluateSubmission(taskDescription, {
        username: profile?.username,
        streak: profile?.current_streak ?? 0,
      });
    } catch (err) {
      // Classification is for the operator, not the caller: both outcomes are
      // reported identically because both leave the day untouched, but "rate
      // limited, retry" and "API key is invalid, fix it" need different
      // responses from whoever is watching the logs at 3am.
      const { transient, reason } = classifyJudgeFailure(err);
      console.error(
        `[gemini] evaluation failed (${transient ? 'transient' : 'permanent'}): ${reason}`
      );

      // Fail loud but provably not destructive. The judge runs BEFORE
      // submit_daily_log(), so on this path nothing has been written: no
      // daily_logs row, no points, no penalty, and the user's daily slot is
      // exactly as open as it was when they pressed submit. The message says so
      // explicitly because a user who just lost a day to an outage needs to know
      // this before they retry, not discover it when the entry is rejected.
      return res.status(502).json({
        error: {
          code: 'AI_SERVICE_UNAVAILABLE',
          message:
            'AI evaluation service is temporarily busy. Your daily attempt has NOT been used. Please try again in a few moments.',
          // Lets the client tell an infrastructure blip apart from a genuine
          // "your entry was bad" verdict without matching on prose.
          retryable: true,
          slotConsumed: false,
          pointsChanged: false,
        },
      });
    }

    const { evaluation } = judgement;

    // 2. Persist atomically. submit_daily_log decides the outcome:
    //      accepted -> points + streak bonus, daily slot consumed
    //      rejected -> -3 penalty, daily slot left OPEN for a retry
    const { data, error } = await db().rpc('submit_daily_log', {
      p_user_id: userId,
      p_task_description: taskDescription,
      p_difficulty: evaluation.difficulty,
      p_points_awarded: evaluation.pointsAwarded,
      p_ai_feedback: evaluation.aiFeedback,
      p_reasoning: evaluation.reasoning,
    });

    if (error) {
      const translated = translateDbError(error);
      if (translated) throw translated;
      throw error;
    }

    const payload = data ?? {};
    const newProfile = payload.profile ?? {};
    const newPoints = newProfile.points ?? 0;
    const accepted = Boolean(payload.accepted);

    res.status(201).json({
      accepted,
      slotConsumed: Boolean(payload.slotConsumed),
      evaluation,
      log: payload.log ? serializeLog(payload.log) : null,
      profile: {
        id: newProfile.id,
        username: newProfile.username,
        points: newPoints,
        // The rank comes from the score, not from the RPC's returned
        // current_tier. This is the payload that drives the promotion overlay,
        // so it must agree with tierProgress below by construction — both read
        // the same points through the same lookup.
        tier: computeTierProgress(newPoints).current.label,
        currentStreak: newProfile.current_streak,
        lastSubmissionDate: newProfile.last_submission_date,
      },
      pointsGained: payload.pointsGained ?? 0,
      basePoints: payload.basePoints ?? 0,
      streakBonus: payload.streakBonus ?? 0,
      penaltyPoints: payload.penaltyPoints ?? (accepted ? 0 : INVALID_PENALTY),
      pointsBefore: payload.pointsBefore ?? newPoints,
      tierProgress: computeTierProgress(newPoints),
      model: judgement.model,
      latencyMs: judgement.latencyMs,
    });
  })
);

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** snake_case row -> camelCase API shape */
function serializeLog(row) {
  return {
    id: row.id,
    taskDescription: row.task_description,
    difficulty: row.difficulty,
    pointsAwarded: row.points_awarded,
    basePoints: row.base_points,
    streakBonus: row.streak_bonus,
    penaltyPoints: row.penalty_points ?? 0,
    isCompleted: row.is_completed !== false,
    revokedAt: row.revoked_at ?? null,
    aiFeedback: row.ai_feedback,
    reasoning: row.reasoning,
    loggedDate: row.logged_date,
    createdAt: row.created_at,
  };
}

/**
 * revoke_today_log() response -> API shape.
 *
 * `pointsRemoved` is what the user actually lost, which is NOT always
 * `log.pointsAwarded`: the refund is floored at zero, so a profile that has
 * since been decayed below the awarded amount refunds less. The UI shows
 * pointsRemoved because that is the number their balance moved by.
 */
function serializeRevoke(payload) {
  const profile = payload.profile ?? {};
  const pointsAfter = payload.pointsAfter ?? profile.points ?? 0;
  const pointsBefore = payload.pointsBefore ?? pointsAfter;

  return {
    revoked: true,
    log: payload.log ? serializeLog(payload.log) : null,
    profile: {
      id: profile.id,
      username: profile.username,
      points: pointsAfter,
      // Revoking is exactly when a rank goes stale: the score drops, so the
      // label must be re-derived. Reading it off the RPC payload here is what
      // made a 7,000-point demotion to 6,400 keep showing "Apex Luminary".
      tier: computeTierProgress(pointsAfter).current.label,
      currentStreak: profile.current_streak ?? 0,
      lastSubmissionDate: profile.last_submission_date ?? null,
    },
    pointsRemoved: payload.pointsRemoved ?? 0,
    pointsBefore,
    pointsAfter,
    streakBefore: payload.streakBefore ?? 0,
    streakAfter: payload.streakAfter ?? 0,
    streakBroken: payload.streakBroken ?? false,
    // The before/after pair is recomputed from both scores rather than trusted
    // from the RPC. These two drive the demotion notice, so they have to agree
    // with `profile.tier` above — deriving all three from points is the only way
    // to guarantee that.
    tierBefore: getTierForPoints(pointsBefore).label,
    tierAfter: getTierForPoints(pointsAfter).label,
    tierChanged: getTierForPoints(pointsBefore).label !== getTierForPoints(pointsAfter).label,
    tierProgress: computeTierProgress(pointsAfter),
  };
}

