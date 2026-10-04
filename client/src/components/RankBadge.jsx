import { m } from 'framer-motion';
import { Award, Building2, Compass, Crown, Flame, Sprout, Target, Wrench } from 'lucide-react';
import { rankFor } from '../lib/tiers.js';

/**
 * The canonical rank badge.
 *
 * Every surface that shows a user's rank — header pill, tier card, leaderboard
 * row, roadmap, promotion overlay — renders it through this component, so a
 * rank always looks the same everywhere and the icon ladder stays consistent.
 *
 * The icon map is keyed by `tier.id` (from the `tiers` table), with a neutral
 * fallback so an unrecognised or custom tier still renders cleanly instead of
 * crashing on `undefined`.
 */
const RANK_ICONS = {
  novice: Sprout,
  apprentice: Wrench,
  practitioner: Compass,
  specialist: Target,
  architect: Building2,
  grandmaster: Flame,
  apex: Crown,
};

const SIZES = {
  sm: { icon: 11, text: 'text-[10px]', pad: 'px-2 py-0.5', gap: 'gap-1' },
  md: { icon: 12, text: 'text-xs', pad: 'px-2.5 py-1', gap: 'gap-1.5' },
  lg: { icon: 15, text: 'text-sm', pad: 'px-3 py-1.5', gap: 'gap-2' },
};

export function rankIcon(tier) {
  return RANK_ICONS[tier?.id] ?? Award;
}

/**
 * @param {object} tier
 *   Either a label string or a tier object. Backwards compatible with the label
 *   the API sends.
 * @param {number} [points]
 *   The user's live score. When present this is what decides the rank, so a
 *   stale `current_tier` cannot pin someone to the rank they just left. Pass it
 *   anywhere the score is at hand — it is the fact; the label is a snapshot.
 */
export function RankBadge({
  tier,
  points,
  tierTable,
  size = 'md',
  showLabel = true,
  pulse = false,
  className = '',
}) {
  // Points win when we have them; the stored label is the fallback.
  const resolved = rankFor(tierTable, { points, tier });
  if (!resolved) return null;

  const Icon = rankIcon(resolved);
  const s = SIZES[size] ?? SIZES.md;
  const Wrapper = pulse ? m.span : 'span';
  const motionProps = pulse
    ? {
        initial: { scale: 0.9, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { type: 'spring', stiffness: 300, damping: 18 },
      }
    : {};

  return (
    <Wrapper
      {...motionProps}
      className={`inline-flex items-center rounded-full border font-semibold tracking-wide ${s.pad} ${s.gap} ${s.text} ${className}`}
      style={{
        borderColor: `${resolved.accent}44`,
        backgroundColor: `${resolved.accent}1a`,
        color: resolved.accent,
      }}
      title={`${resolved.label}${resolved.maxPoints == null ? '' : ` · up to ${resolved.maxPoints} pts`}`}
    >
      <Icon size={s.icon} strokeWidth={2.6} className="shrink-0" />
      {showLabel && <span className="whitespace-nowrap">{resolved.label}</span>}
    </Wrapper>
  );
}
