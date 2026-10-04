/**
 * Presentation helpers for tiers and difficulty.
 *
 * Thresholds themselves are NOT hardcoded here — the server loads them from the
 * `tiers` Postgres table and sends them with the profile payload, so the UI and
 * the database can never disagree. FALLBACK_TIERS mirrors the seed data in
 * supabase/schema.sql and is only used before the first payload lands.
 */

export const FALLBACK_TIERS = [
  { id: 'novice', label: 'Novice', minPoints: 0, maxPoints: 199, accent: '#94a3b8' },
  { id: 'apprentice', label: 'Apprentice', minPoints: 200, maxPoints: 499, accent: '#34d399' },
  { id: 'practitioner', label: 'Practitioner', minPoints: 500, maxPoints: 999, accent: '#38bdf8' },
  { id: 'specialist', label: 'Specialist', minPoints: 1000, maxPoints: 1999, accent: '#a78bfa' },
  { id: 'architect', label: 'Architect', minPoints: 2000, maxPoints: 3999, accent: '#fbbf24' },
  { id: 'grandmaster', label: 'Grandmaster', minPoints: 4000, maxPoints: 6999, accent: '#fb7185' },
  { id: 'apex', label: 'Apex Luminary', minPoints: 7000, maxPoints: null, accent: '#ffd166' },
];

/** Used when nothing better is known. Also the colour of the fallback badge. */
export const UNKNOWN_ACCENT = '#94a3b8';

function activeTable(tierTable) {
  return Array.isArray(tierTable) && tierTable.length ? tierTable : FALLBACK_TIERS;
}

/**
 * Coerces a points value to a non-negative integer.
 *
 * Points reach the client from several places — the profile row, a leaderboard
 * entry, a promotion payload — and JSON does not stop any of them from being a
 * string, null, or NaN. Without this, `"7000" >= 7000` is still true but
 * `7000 - "7000"` is 0, and a comparison against a numeric `minPoints` can fail
 * in ways that quietly fall through to the lowest rank.
 */
export function toPoints(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * The authoritative rank lookup: points in, rank out.
 *
 * This mirrors public.tier_for_points() in Postgres exactly — take the highest
 * tier whose floor the score has reached — so the client cannot disagree with
 * the database about which rank someone holds. Bounds come from the table
 * rather than a switch, so editing the `tiers` table moves the ladder on both
 * sides at once.
 *
 * Callers should prefer this over matching on a stored label. A label is a
 * snapshot that can go stale between a points change and the next refetch; the
 * points are the fact.
 */
export function tierForPoints(tierTable, points) {
  const table = activeTable(tierTable);
  const p = toPoints(points);

  // Sorted ascending, so the last match is the highest floor reached.
  let match = table[0];
  for (const tier of table) {
    if (p >= toPoints(tier.minPoints)) match = tier;
    else break;
  }
  return match;
}

/**
 * Looks a tier up by label or id, tolerating case and surrounding whitespace.
 *
 * Matching is exact otherwise. It previously compared `t.label === ref` and
 * returned table[0] — Novice — on any miss, so an id where a label was expected,
 * a stray space, or different casing all rendered as Novice no matter the real
 * score. That silent collapse is what made this class of bug invisible.
 *
 * Note this returns table[0] for a genuinely unknown ref rather than null, so it
 * stays safe to call directly from render code. Nothing should route a user's
 * rank through it when points are known; use rankFor() below.
 */
export function resolveTier(tierTable, ref) {
  const table = activeTable(tierTable);
  if (!ref) return table[0];
  if (typeof ref === 'object') {
    return (
      table.find((t) => t.id === ref.id) ??
      table.find((t) => t.label === ref.label) ??
      table[0]
    );
  }
  const key = String(ref).trim().toLowerCase();
  if (!key) return table[0];
  return (
    table.find((t) => String(t.label).trim().toLowerCase() === key) ??
    table.find((t) => String(t.id).trim().toLowerCase() === key) ??
    table[0]
  );
}

/**
 * The one function surfaces should call to get a user's rank.
 *
 * Prefers the live points and falls back to the stored label, so a stale
 * `current_tier` is corrected the moment the points are known. Only if neither
 * is usable does it reach for the bottom of the ladder — the one case where
 * showing "Novice" is the right answer, because there is nothing else to show.
 *
 * Note that a score of 0 takes the points branch and correctly yields Novice;
 * the label is only consulted when there is no score at all.
 */
export function rankFor(tierTable, { points, tier } = {}) {
  const table = activeTable(tierTable);
  if (points !== null && points !== undefined && points !== '') {
    return tierForPoints(table, points);
  }
  return resolveTier(table, tier) ?? table[0];
}

export function accentFor(tierTable, ref) {
  const resolved = resolveTier(tierTable, ref);
  return resolved?.accent ?? UNKNOWN_ACCENT;
}

/** Convenience for the common "colour for this user's rank" case. */
export function accentForRank(tierTable, { points, tier } = {}) {
  return rankFor(tierTable, { points, tier })?.accent ?? UNKNOWN_ACCENT;
}

/**
 * The tier table sorted ascending by floor.
 *
 * tierForPoints() walks the table and stops at the first floor the score has not
 * reached, so it -- and everything built on it -- assumes ascending order. That
 * is true of the table the server sends, but a caller assembling tiers by hand
 * should not have to know it. Sorting a copy keeps the input untouched.
 */
function orderedTable(tierTable) {
  return activeTable(tierTable)
    .slice()
    .sort((a, b) => toPoints(a.minPoints) - toPoints(b.minPoints));
}

/** The tier above the given score, or null at the top of the ladder. */
function nextTierForPoints(tierTable, points) {
  const p = toPoints(points);
  return orderedTable(tierTable).find((t) => toPoints(t.minPoints) > p) ?? null;
}

/**
 * Progress toward the next rank — the shape the API sends as `tierProgress`.
 *
 * This mirrors computeTierProgress() in server/src/lib/tiers.js exactly, field
 * for field, so a component cannot tell a guest payload from a real one. It
 * exists here because guest mode has to produce a tierProgress object without an
 * API to ask, and reimplementing the ladder was the alternative -- two ladders
 * that drift apart, which is how "everyone shows Novice" bugs happen.
 */
export function computeTierProgress(tierTable, points) {
  const p = toPoints(points);
  const current = tierForPoints(tierTable, p);
  const next = nextTierForPoints(tierTable, p);

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
  // Clamped, not just rounded: at 998 of a 500-999 band the raw ratio is 99.6%,
  // which rounds to 100% and would show a full bar while the card still says
  // "2 pts to go".
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

/* ------------------------------------------------------------------ */
/* Difficulty                                                          */
/* ------------------------------------------------------------------ */

export const DIFFICULTY_META = {
  Hard: {
    label: 'Hard',
    basePoints: 100,
    accent: '#fb7185',
    chip: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
    bar: 'from-rose-500 to-rose-300',
  },
  Average: {
    label: 'Average',
    basePoints: 70,
    accent: '#fbbf24',
    chip: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
    bar: 'from-amber-500 to-amber-300',
  },
  Easy: {
    label: 'Easy',
    basePoints: 50,
    accent: '#34d399',
    chip: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
    bar: 'from-emerald-500 to-emerald-300',
  },
  Invalid: {
    label: 'Not approved',
    basePoints: 0,
    accent: '#64748b',
    chip: 'border-slate-400/30 bg-slate-400/10 text-slate-400',
    bar: 'from-slate-600 to-slate-500',
  },
};

export const difficultyMeta = (d) => DIFFICULTY_META[d] ?? DIFFICULTY_META.Invalid;

/* ------------------------------------------------------------------ */
/* Scoring mechanics                                                   */
/* ------------------------------------------------------------------ */

/**
 * Flat penalty for a rejected (Invalid) entry. Mirrors INVALID_PENALTY on the
 * server and v_penalty inside submit_daily_log().
 */
export const INVALID_PENALTY = 3;

/** Points lost per fully missed UTC day. Mirrors apply_decay() in SQL. */
export const DECAY_PER_DAY = 30;

/** Streak bonus: +5 per consecutive day, hard capped at +50. */
export const streakBonusFor = (streak) => Math.min(Math.max(0, streak ?? 0) * 5, 50);

/** Highest streak day at which the bonus still increases (day 11+ is the cap). */
export const STREAK_BONUS_CAP_DAY = 10;

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export const formatNumber = (n) =>
  typeof n === 'number' ? n.toLocaleString('en-US') : '0';

export function formatPoints(n) {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return formatNumber(n);
}

/**
 * Human-readable point range for a tier: "0 – 199 pts", "7,000+ pts".
 *
 * The top tier has a null max, which is what makes it the ceiling rather than
 * just another bracket.
 */
export function tierRange(tier) {
  if (!tier) return '';
  if (tier.maxPoints === null || tier.maxPoints === undefined) {
    return `${formatNumber(tier.minPoints)}+ pts`;
  }
  return `${formatNumber(tier.minPoints)} – ${formatNumber(tier.maxPoints)} pts`;
}

/** Sort a tier table ascending by threshold. The DB does not guarantee order. */
export const sortTiers = (table) =>
  (table?.length ? table : FALLBACK_TIERS)
    .slice()
    .sort((a, b) => a.minPoints - b.minPoints);

/** "3 days ago", "today", "yesterday" — relative to the UTC day string. */
export function formatRelativeDay(loggedDate) {
  if (!loggedDate) return '';
  const today = new Date().toISOString().slice(0, 10);
  if (loggedDate === today) return 'Today';

  const diff = Math.round(
    (new Date(`${today}T00:00:00Z`) - new Date(`${loggedDate}T00:00:00Z`)) / 86_400_000
  );
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff} days ago`;
  if (diff < 14) return 'Last week';
  return new Date(`${loggedDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** ms until the next UTC midnight. */
export function msUntilUtcMidnight(from = Date.now()) {
  const d = new Date(from);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - from;
}