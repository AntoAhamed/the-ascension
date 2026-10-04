/**
 * Decay reconciliation.
 *
 * Two independent paths run the same rule (-30 points and a streak reset per
 * missed UTC day), so one failing does not leave stale numbers on screen:
 *
 *   1. the in-process node-cron job at 00:00 UTC, for everyone at once
 *   2. this lazy per-user reconcile, called on every profile read
 *
 * The lazy path is what makes the system self-healing — a user who was offline
 * across a missed day is corrected the moment they return, whether or not the
 * process was alive at midnight.
 *
 * Both delegate the arithmetic to apply_decay() in Postgres, so the rule exists
 * in exactly one place and cannot disagree with itself.
 */
import { getSupabaseAdmin } from '../config/supabaseAdmin.js';

const db = () => getSupabaseAdmin();

/**
 * Settle decay for a single user. Called at the top of GET /api/profile.
 *
 * Never throws: a failure here would otherwise turn a cosmetic background job
 * into a failed page load. The user still sees correct (if not yet penalised)
 * numbers, and the nightly job or their next visit will retry.
 */
export async function reconcileUser(userId) {
  try {
    const { data, error } = await db().rpc('apply_decay', { p_user_id: userId });
    if (error) throw error;
    const applied = Boolean(data?.applied);
    const points = data?.profile?.points ?? null;
    return { decayed: applied, points };
  } catch (err) {
    console.error('[decay] reconcileUser failed:', err.message);
    return { decayed: false, points: null };
  }
}

/**
 * Settle decay for every profile. Called by the nightly job and by
 * POST /api/cron/decay.
 *
 * Batched by the database (reconcile_all_streaks / the sweep in apply_decay),
 * not row-by-row from Node, so this stays a single round trip regardless of how
 * many profiles exist.
 */
export async function reconcileAll() {
  const { data, error } = await db().rpc('reconcile_all_streaks');
  if (error) throw error;
  return Number(data ?? 0);
}
