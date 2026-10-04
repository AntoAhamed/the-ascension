/**
 * Tier utilities.
 *
 * The authoritative tier thresholds live in the `tiers` Postgres table, not
 * here. These helpers operate on whatever table the server has loaded, and
 * `computeTierProgress` is used to build the "progress to next level" bar.
 *
 * Scoring deliberately lives elsewhere, in exactly one place each: the
 * difficulty-to-points table in services/gemini.js (the judge's own number is
 * never trusted), and the streak bonus inside public.submit_daily_log(). A
 * mirror of either used to sit here; it was unused, and two reward tables that
 * can silently disagree are worse than one.
 */

/**
 * Flat penalty deducted for a rejected (Invalid) attempt.
 * Mirrors the v_penalty constant inside public.submit_daily_log().
 */
export const INVALID_PENALTY = 3;

export const FALLBACK_TIERS = [
  { id: 'novice', label: 'Novice', minPoints: 0, maxPoints: 199, accent: '#94a3b8' },
  { id: 'apprentice', label: 'Apprentice', minPoints: 200, maxPoints: 499, accent: '#34d399' },
  { id: 'practitioner', label: 'Practitioner', minPoints: 500, maxPoints: 999, accent: '#38bdf8' },
  { id: 'specialist', label: 'Specialist', minPoints: 1000, maxPoints: 1999, accent: '#a78bfa' },
  { id: 'architect', label: 'Architect', minPoints: 2000, maxPoints: 3999, accent: '#fbbf24' },
  { id: 'grandmaster', label: 'Grandmaster', minPoints: 4000, maxPoints: 6999, accent: '#fb7185' },
  { id: 'apex', label: 'Apex Luminary', minPoints: 7000, maxPoints: null, accent: '#ffd166' },
];

/** Runtime tier table, refreshed from the DB on boot. */
let table = FALLBACK_TIERS;

export function setTierTable(tiers) {
  if (Array.isArray(tiers) && tiers.length > 0) {
    table = [...tiers].sort((a, b) => a.minPoints - b.minPoints);
  }
}

export function getTierTable() {
  return table;
}

/**
 * Coerces a points value to a non-negative integer.
 *
 * The database column is an integer, so this is belt-and-braces — but points also
 * arrive straight from the Gemini judge and from request bodies, and an
 * uncoerced "7000" makes `p >= tier.minPoints` behave inconsistently with the
 * arithmetic around it. Mirrors the client-side toPoints() in lib/tiers.js and
 * the greatest(coalesce(p_points, 0), 0) in public.tier_for_points().
 */
export function toPoints(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * The rank a score earns, by bounds.
 *
 * Mirrors public.tier_for_points(): the highest tier whose floor has been
 * reached. Upper bounds (maxPoints) are deliberately not tested — they are
 * implied by the next tier's floor, and testing both would leave a gap at every
 * boundary if the table were ever edited inconsistently.
 */
export function getTierForPoints(points) {
  const p = toPoints(points);
  let match = table[0];
  for (const tier of table) {
    if (p >= toPoints(tier.minPoints)) match = tier;
    else break;
  }
  return match;
}

export function getNextTierForPoints(points) {
  const p = toPoints(points);
  const current = getTierForPoints(p);
  return table.find((t) => toPoints(t.minPoints) > toPoints(current.minPoints)) ?? null;
}

/**
 * Everything the TierCard needs to render itself.
 */
export function computeTierProgress(points) {
  const p = toPoints(points);
  const current = getTierForPoints(p);
  const next = getNextTierForPoints(p);

  if (!next) {
    return {
      current,
      next: null,
      pointsIntoTier: Math.max(0, p - toPoints(current.minPoints)),
      spanOfTier: null,
      percent: 100,
      pointsToNext: 0,
      isMaxTier: true,
    };
  }

  const currentMin = toPoints(current.minPoints);
  const nextMin = toPoints(next.minPoints);
  const span = nextMin - currentMin;
  const into = Math.max(0, p - currentMin);
  // Clamped, not just rounded. At 998 of 500-999 the raw ratio is 99.6%, which
  // rounds to 100% — correct, but only because of the clamp. Without it the bar
  // would read full two points while the card still said "2 pts to go".
  const percent = span > 0 ? Math.min(100, Math.max(0, Math.round((into / span) * 100))) : 100;

  return {
    current,
    next,
    pointsIntoTier: into,
    spanOfTier: span,
    percent,
    pointsToNext: Math.max(0, nextMin - p),
    isMaxTier: false,
  };
}