/**
 * GET /api/logs?limit=50&offset=0
 * The history & analytics feed.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getSupabaseAdmin } from '../config/supabaseAdmin.js';

export const logsRouter = Router();
logsRouter.use(requireAuth);

const db = () => getSupabaseAdmin();

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

logsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest('Invalid query parameters', parsed.error.issues);
    const { limit, offset } = parsed.data;
    const userId = req.user.id;

    // Every query is scoped `.eq('user_id', userId)` where userId comes from the
    // verified JWT — never from a query parameter — so this endpoint cannot be
    // used to read another user's history.
    const [logsResult, countResult, statsResult] = await Promise.all([
      db()
        .from('daily_logs')
        .select('*')
        .eq('user_id', userId)
        .order('logged_date', { ascending: false })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1),
      db().from('daily_logs').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      db().rpc('get_profile_stats', { p_self_id: userId }),
    ]);

    if (logsResult.error) throw logsResult.error;

    res.json({
      logs: (logsResult.data ?? []).map(serializeLog),
      total: countResult.count ?? 0,
      stats: statsResult.data ?? null,
    });
  })
);

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


