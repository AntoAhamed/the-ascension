/**
 * GET /api/leaderboard?filter=all_time|month&limit=100
 *
 * Also returns the caller's own rank so the UI can show "you are #47 of 128"
 * without a second round trip.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getSupabaseAdmin } from '../config/supabaseAdmin.js';
import { getTierForPoints, getTierTable } from '../lib/tiers.js';

export const leaderboardRouter = Router();
leaderboardRouter.use(requireAuth);

const db = () => getSupabaseAdmin();

const querySchema = z.object({
  filter: z.enum(['all_time', 'month']).default('all_time'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

leaderboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('Invalid query parameters', parsed.error.issues);
    }
    const { filter, limit } = parsed.data;
    const userId = req.user.id;

    const [boardResult, rankResult] = await Promise.all([
      db().rpc('get_leaderboard', { p_filter: filter, p_limit: limit, p_self_id: userId }),
      db().rpc('get_my_rank', { p_filter: filter, p_self_id: userId }),
    ]);

    if (boardResult.error) throw boardResult.error;
    if (rankResult.error) throw rankResult.error;

    const entries = (boardResult.data ?? []).map(serializeEntry);
    const meRow = (rankResult.data ?? [])[0] ?? null;

    res.json({
      filter,
      entries,
      me: meRow
        ? { rank: Number(meRow.rank), score: meRow.score, totalPlayers: Number(meRow.total_players) }
        : { rank: null, score: 0, totalPlayers: 0 },
      // Threshold data rides along so the client can render badges without a
      // second request. Purely in-memory — it falls back to the built-in copy if
      // the RPC was unavailable at boot, so there is no error path here.
      tierTable: getTierTable(),
    });
  })
);

function serializeEntry(row) {
  return {
    rank: Number(row.rank),
    userId: row.user_id,
    username: row.username,
    avatarUrl: row.avatar_url,
    score: row.score,
    points: row.points,
    // Derived from the score, not read from the stored current_tier column — see
    // the note in routes/profile.js. On a monthly board `score` and `points`
    // differ (score is the month, points is all-time), and the rank follows the
    // all-time total so a leaderboard row can never outrank the card on the
    // same page.
    tier: getTierForPoints(row.points).label,
    currentStreak: row.current_streak,
    isSelf: row.is_self,
  };
}
