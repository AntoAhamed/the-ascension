/**
 * Profile, dashboard and stats endpoints.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getSupabaseAdmin } from '../config/supabaseAdmin.js';
import { reconcileUser } from '../services/decay.js';
import { computeTierProgress, getTierForPoints, getTierTable } from '../lib/tiers.js';

export const profileRouter = Router();
profileRouter.use(requireAuth);

const db = () => getSupabaseAdmin();

/**
 * The rank label the API reports for a score.
 *
 * Derived from points rather than read from profiles.current_tier. The column is
 * maintained correctly by a BEFORE trigger on profiles (see the profiles_sync_tier
 * trigger in schema.sql), but it is still a denormalised snapshot. Recomputing
 * here costs one pass over seven rows and means the API cannot emit a rank its own
 * points contradict.
 */
const tierFor = (points) => getTierForPoints(points).label;

/**
 * GET /api/profile
 * The dashboard's single source of truth. Runs a lazy decay reconcile first so
 * the numbers the user sees are always current.
 */
profileRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    // Lazy reconcile — settles any missed days since this user's last visit.
    // A failure here must not block the dashboard: the numbers below are still
    // correct, they are just not yet penalised. Decay is also settled by the
    // nightly job, so this is a convenience, not the guarantee.
    let decayInfo = null;
    try {
      decayInfo = await reconcileUser(userId);
    } catch (err) {
      console.error('[profile] reconcile failed:', err.message);
    }

    const { data: profile, error } = await db()
      .from('profiles')
      .select('id, username, avatar_url, points, current_streak, last_submission_date, has_completed_onboarding, created_at')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!profile) throw notFound('Profile not found');

    const tierProgress = computeTierProgress(profile.points);
    const tierTable = getTierTable();

    const [statsResult, statusResult] = await Promise.all([
      db().rpc('get_profile_stats', { p_self_id: userId }),
      db().rpc('get_today_status', { p_self_id: userId }),
    ]);

    const stats = statsResult.data ?? null;
    const todayStatus = statusResult.data ?? {
      hasSubmitted: false,
      revokedLog: null,
      msUntilReset: 0,
    };

    res.json({
      profile: {
        id: profile.id,
        username: profile.username,
        avatarUrl: profile.avatar_url,
        points: profile.points,
        tier: tierFor(profile.points),
        currentStreak: profile.current_streak,
        lastSubmissionDate: profile.last_submission_date,
        hasCompletedOnboarding: profile.has_completed_onboarding,
        createdAt: profile.created_at,
      },
      tierProgress,
      tierTable,
      stats,
      todayStatus,
      decay: decayInfo ? { applied: decayInfo.decayed, points: decayInfo.points } : null,
    });
  })
);

/**
 * PATCH /api/profile
 * Lets onboarding set the username and dismiss the modal.
 */
const patchSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3, 'Username must be at least 3 characters')
      .max(20)
      .regex(/^[a-zA-Z0-9_]+$/, 'Use letters, numbers and underscores only')
      .optional(),
    hasCompletedOnboarding: z.boolean().optional(),
  })
  // zod strips unknown keys, so an empty body has to be caught explicitly —
  // otherwise PATCH /api/profile with {} silently succeeds and looks like a bug.
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

profileRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        parsed.error.issues.map((i) => i.message).join('; '),
        parsed.error.issues
      );
    }

    // Build the update from the validated shape only. The `{...patch}` spread
    // below is safe because `patch` is assembled key by key rather than copied
    // from req.body — no client-supplied key can reach the database, including
    // `points`, `current_streak` or `current_tier`.
    const patch = {};
    if (parsed.data.username) patch.username = parsed.data.username;
    if (parsed.data.hasCompletedOnboarding !== undefined) {
      patch.has_completed_onboarding = parsed.data.hasCompletedOnboarding;
    }

    const { data, error } = await db()
      .from('profiles')
      .update(patch)
      .eq('id', req.user.id)
      .select('id, username, avatar_url, points, current_streak, has_completed_onboarding')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        throw badRequest('That username is already taken. Try another.');
      }
      throw error;
    }
    if (!data) throw notFound('Profile not found');

    res.json({
      profile: {
        id: data.id,
        username: data.username,
        avatarUrl: data.avatar_url,
        points: data.points,
        tier: tierFor(data.points),
        currentStreak: data.current_streak,
        hasCompletedOnboarding: data.has_completed_onboarding,
      },
    });
  })
);

/**
 * DELETE /api/profile
 * Delete the authenticated user's account and all associated data.
 * This cascades to profiles, daily_logs etc. via foreign keys.
 */
profileRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const admin = getSupabaseAdmin();
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      throw error;
    }
    res.status(204).end();
  })
);
