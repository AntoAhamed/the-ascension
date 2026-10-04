import { m } from 'framer-motion';
import { ArrowRight, Crown, TrendingUp } from 'lucide-react';
import { Panel } from './ui/Panel.jsx';
import { RankBadge } from './RankBadge.jsx';
import { ViewRanksButton } from './ViewRanksButton.jsx';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber.js';
import { formatNumber, tierForPoints } from '../lib/tiers.js';

/**
 * The hero card: total points, current rank, and progress toward the next rank.
 *
 * This is the app's permanent anchor for the rank system — it sits above the
 * fold on the dashboard, so it is the first thing a user sees every session.
 * The point counter animates rather than snapping, because that roll-up is the
 * single most satisfying moment in the product.
 */
export function TierCard({ profile, tierProgress, tierTable, onOpenRanks, delay = 0 }) {
  // Hooks run before the early return, unconditionally. The guard used to sit
  // above this call, which meant the hook count for this component depended on
  // whether the profile had arrived: React records the hook count on the first
  // render and throws "Rendered more hooks than during the previous render" the
  // moment a mount that returned early starts calling one. `?? 0` gives the
  // counter a value to settle on while there is nothing to show, and the guard
  // below still decides whether any of it is painted.
  const animatedPoints = useAnimatedNumber(profile?.points ?? 0);

  if (!profile || !tierProgress) return null;

  const { current, next, percent, pointsToNext, pointsIntoTier, spanOfTier, isMaxTier } = tierProgress;

  // Guard against a payload whose stored rank has drifted from the score. The
  // server already derives `current` from live points, so these agree; but if a
  // cached or partially-refreshed payload ever disagreed, the score is the fact
  // and the stored label is only a snapshot. Deriving here means the card can
  // never show a rank the user has already outgrown.
  const shown = tierForPoints(tierTable, profile.points) ?? current;
  const accent = shown.accent;

  return (
    <Panel className="overflow-hidden" delay={delay}>
      {/* Accent wash keyed to the tier's colour. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.14]"
        style={{
          background: `radial-gradient(120% 90% at 15% 0%, ${accent}55, transparent 60%)`,
        }}
      />

      <div className="relative p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">
              Total Points
            </p>

            <div className="mt-1 flex items-baseline gap-3">
              <m.span
                key={profile.points}
                initial={{ scale: 1.18, filter: 'brightness(1.6)' }}
                animate={{ scale: 1, filter: 'brightness(1)' }}
                transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
                className="tabular font-display text-5xl font-black leading-none text-white"
              >
                {formatNumber(animatedPoints)}
              </m.span>
              {profile.points > 0 && (
                <TrendingUp size={20} style={{ color: accent }} className="self-center" />
              )}
            </div>

            {/* Rank badge + roadmap trigger, side by side. */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <RankBadge
                tier={shown}
                points={profile.points}
                tierTable={tierTable}
                size="md"
                pulse
              />
              {isMaxTier && <Crown size={13} className="text-neon-gold" />}
              {onOpenRanks && <ViewRanksButton onClick={onOpenRanks} accent={accent} />}
              {!isMaxTier && (
                <span className="text-xs text-slate-500">
                  {formatNumber(pointsIntoTier)} / {formatNumber(spanOfTier)} into rank
                </span>
              )}
            </div>
          </div>

          <TierEmblem accent={accent} label={shown.label} />
        </div>

        {/* Explicit "you are here ➔ next threshold" statement.
            Written out rather than implied by the bar, so the two numbers a
            user actually cares about are readable without measuring pixels. */}
        <div className="mt-5 flex flex-wrap items-center gap-2.5 rounded-xl border border-white/[0.07] bg-void-900/50 px-4 py-3 text-xs">
          <span className="text-slate-500">Current</span>
          <span className="font-semibold" style={{ color: accent }}>
            {shown.label}
          </span>
          <span className="tabular font-bold text-slate-200">
            {formatNumber(profile.points)} pts
          </span>

          <ArrowRight size={13} className="mx-0.5 text-slate-600" />

          {next ? (
            <>
              <span className="text-slate-500">Next rank</span>
              <span className="font-semibold" style={{ color: next.accent }}>
                {next.label}
              </span>
              <span className="tabular font-bold text-slate-200">
                {formatNumber(next.minPoints)} pts
              </span>
              <span className="ml-auto tabular text-slate-500">
                {formatNumber(pointsToNext)} to go
              </span>
            </>
          ) : (
            <>
              <span className="font-semibold text-neon-gold">Apex rank reached</span>
              <span className="ml-auto text-slate-500">no rank above this one</span>
            </>
          )}
        </div>

        {/* Progress rail to the next rank. */}
        {!isMaxTier && next && (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-400">Progress to {next.label}</span>
              <span className="tabular font-bold" style={{ color: next.accent }}>
                {formatNumber(pointsToNext)} pts to go
              </span>
            </div>

            <div className="progress-rail">
              <m.div
                className="progress-fill"
                style={{
                  background: `linear-gradient(90deg, ${accent}, ${next.accent})`,
                  boxShadow: `0 0 14px -2px ${next.accent}`,
                }}
                initial={{ width: 0 }}
                animate={{ width: `${percent}%` }}
                transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1], delay: delay + 0.15 }}
              />
              {/* Travelling sheen so the bar feels alive. */}
              <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
                <div className="h-full w-1/3 animate-shimmer bg-gradient-to-r from-transparent via-white/25 to-transparent bg-[length:200%_100%]" />
              </div>
            </div>
          </div>
        )}

        {isMaxTier && (
          <div className="mt-5 rounded-xl border border-neon-gold/25 bg-neon-gold/[0.07] px-4 py-3 text-center">
            <p className="text-sm font-semibold text-neon-gold">
              Apex rank reached. You are among the top Luminaries.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * Animated hexagonal emblem. SVG keeps it crisp and lets the accent colour
 * drive both the stroke and the glow.
 */
function TierEmblem({ accent, label }) {
  return (
    <m.div
      initial={{ scale: 0.6, rotate: -25, opacity: 0 }}
      animate={{ scale: 1, rotate: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 16, delay: 0.15 }}
      className="relative grid h-20 w-20 shrink-0 place-items-center"
    >
      {/* Pulsing halo */}
      <m.div
        className="absolute inset-0 rounded-2xl"
        style={{ background: `${accent}22`, filter: 'blur(14px)' }}
        animate={{ scale: [1, 1.18, 1], opacity: [0.55, 0.85, 0.55] }}
        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
      />

      <svg viewBox="0 0 100 100" className="relative h-full w-full">
        <defs>
          <linearGradient id="emblem-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={accent} />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        {/* Outer hexagon */}
        <polygon
          points="50,3 92,27 92,73 50,97 8,73 8,27"
          fill="none"
          stroke="url(#emblem-grad)"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        {/* Inner hexagon */}
        <polygon
          points="50,20 78,35 78,65 50,80 22,65 22,35"
          fill={`${accent}12`}
          stroke={`${accent}55`}
          strokeWidth="1.5"
        />
      </svg>

      <span
        className="absolute font-display text-[9px] font-black uppercase tracking-widest"
        style={{ color: accent }}
      >
        {label.split(' ')[0].slice(0, 7)}
      </span>
    </m.div>
  );
}