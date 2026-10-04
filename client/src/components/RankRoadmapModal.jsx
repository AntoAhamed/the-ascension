import { useEffect } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { Check, Crown, Lock, X } from 'lucide-react';
import { RankBadge, rankIcon } from './RankBadge.jsx';
import { formatNumber, rankFor, sortTiers, tierRange } from '../lib/tiers.js';

/**
 * "The Ranks of Ascension" — the full ladder.
 *
 * The point of this modal is not information (the numbers are simple) but
 * *visibility of distance*: seeing six locked rungs above you is what makes the
 * next one feel reachable. So the current rank is expanded and highlighted, and
 * every rank above it shows exactly how many points stand between you and it.
 *
 * Thresholds come from the `tierTable` the server ships, so the ladder can never
 * disagree with the scoring engine.
 */

/** One line of flavour per rank. Purely presentational. */
const RANK_NOTES = {
  novice: 'Where everyone starts. Show up and the ladder begins.',
  apprentice: 'You are building the habit. Consistency is the real skill here.',
  practitioner: 'Real, repeatable output. This is where the work starts compounding.',
  specialist: 'Deep work, done well. Most people never arrive.',
  architect: 'You are designing systems, not just finishing tasks.',
  grandmaster: 'Elite output, sustained. Decay is the only thing that can stop you.',
  apex: 'The ceiling. Nothing above this — only the maintenance of what you built.',
};

export function RankRoadmapModal({ open, onClose, profile, tierProgress, tierTable }) {
  const points = profile?.points ?? 0;
  // Points decide the rank here, so the "you are here" marker cannot land on a
  // stale row after a promotion that has not been refetched yet.
  const current =
    rankFor(tierTable, { points: profile?.points, tier: profile?.tier }) ?? tierProgress?.current;
  const ranks = sortTiers(tierTable);
  const currentIdx = ranks.findIndex((t) => t.id === current?.id);

  // Escape to close, and stop the page scrolling behind the sheet.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-[9997] flex cursor-pointer items-start justify-center overflow-y-auto bg-void-950/90 p-4 backdrop-blur-lg sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ranks-title"
        >
          <m.div
            initial={{ scale: 0.95, y: 24, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 250, damping: 26 }}
            onClick={(e) => e.stopPropagation()}
            className="panel relative my-auto w-full max-w-2xl overflow-hidden"
          >
            {/* Ambient edge light, keyed to the user's current rank. */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-px"
              style={{
                background: `linear-gradient(90deg, transparent, ${current?.accent ?? '#22d3ee'}aa, transparent)`,
              }}
            />

            {/* ------------------------------------------------- Header */}
            <div className="flex items-start justify-between gap-4 p-6 pb-4">
              <div className="flex items-center gap-3">
                <span
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border"
                  style={{
                    borderColor: `${current?.accent ?? '#22d3ee'}33`,
                    backgroundColor: `${current?.accent ?? '#22d3ee'}14`,
                  }}
                >
                  <Crown size={20} style={{ color: current?.accent ?? '#22d3ee' }} />
                </span>
                <div>
                  <h2
                    id="ranks-title"
                    className="font-display text-xl font-black text-white sm:text-2xl"
                  >
                    The Ranks of Ascension
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Seven rungs. Points never expire, but they do decay if you disappear.
                  </p>
                </div>
              </div>

              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-white/[0.07] hover:text-white"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            {/* ------------------------------------------------- Where I am */}
            <div className="mx-6 mb-5 rounded-xl border border-white/[0.07] bg-void-900/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    You are here
                  </span>
                  <RankBadge tier={current} points={points} tierTable={tierTable} size="md" />
                </div>
                <span className="tabular font-display text-lg font-black text-white">
                  {formatNumber(points)}{' '}
                  <span className="text-xs font-semibold text-slate-500">pts</span>
                </span>
              </div>

              {tierProgress?.next && (
                <>
                  <p className="mt-3 text-xs text-slate-400">
                    <span className="font-semibold text-slate-300">
                      {formatNumber(tierProgress.pointsToNext)} points
                    </span>{' '}
                    to{' '}
                    <span className="font-semibold" style={{ color: tierProgress.next.accent }}>
                      {tierProgress.next.label}
                    </span>
                    , which opens at{' '}
                    <span className="tabular font-semibold text-slate-300">
                      {formatNumber(tierProgress.next.minPoints)} pts
                    </span>
                    .
                  </p>
                  <div className="progress-rail mt-2.5">
                    <m.div
                      className="progress-fill"
                      style={{
                        background: `linear-gradient(90deg, ${current?.accent}, ${tierProgress.next.accent})`,
                        boxShadow: `0 0 14px -2px ${tierProgress.next.accent}`,
                      }}
                      initial={{ width: 0 }}
                      animate={{ width: `${tierProgress.percent}%` }}
                      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
                    />
                  </div>
                </>
              )}

              {!tierProgress?.next && (
                <p className="mt-3 text-xs text-neon-gold">
                  The apex rank is reached. There is nothing above it — only the defence of what
                  you have built.
                </p>
              )}
            </div>

            {/* ------------------------------------------------- The ladder */}
            <div className="max-h-[46vh] space-y-2 overflow-y-auto px-6 pb-6">
              {ranks.map((tier, i) => (
                <RankRow
                  key={tier.id}
                  tier={tier}
                  index={i}
                  isLast={i === ranks.length - 1}
                  points={points}
                  isCurrent={tier.id === current?.id}
                  isUnlocked={points >= tier.minPoints}
                  currentIdx={currentIdx}
                />
              ))}
            </div>

            <div className="border-t border-white/[0.06] bg-void-900/40 px-6 py-3.5">
              <p className="text-center text-[11px] text-slate-600">
                Thresholds are loaded from the database and applied by the server — the ladder
                above is exactly what the scoring engine will use.
              </p>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/** One rung. Locked rungs stay legible (you need to see the distance) but recede. */
function RankRow({ tier, index, isLast, points, isCurrent, isUnlocked, currentIdx }) {
  const Icon = rankIcon(tier);
  const gap = isUnlocked ? 0 : tier.minPoints - points;
  const isNext = !isUnlocked && currentIdx >= 0 && index === currentIdx + 1;

  return (
    <m.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.06 + index * 0.05 }}
      className="relative flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors"
      style={{
        borderColor: isCurrent ? `${tier.accent}55` : 'rgba(255,255,255,0.05)',
        background: isCurrent
          ? `linear-gradient(90deg, ${tier.accent}1a, rgba(8,10,22,0.4) 70%)`
          : 'rgba(8,10,22,0.4)',
      }}
    >
      {/* Connector to the next rung, so the list reads as a ladder. */}
      {!isLast && (
        <span
          className="absolute left-[1.85rem] top-full h-2 w-px"
          style={{ background: isUnlocked ? `${tier.accent}44` : 'rgba(255,255,255,0.07)' }}
        />
      )}

      <span
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${
          isUnlocked ? '' : 'border-white/[0.07] bg-void-900/60'
        }`}
        style={{
          borderColor: isUnlocked ? `${tier.accent}33` : undefined,
          backgroundColor: isUnlocked ? `${tier.accent}14` : undefined,
        }}
      >
        <Icon
          size={16}
          strokeWidth={2.4}
          style={{ color: isUnlocked ? tier.accent : '#475569' }}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`font-display text-sm font-black ${
              isUnlocked ? 'text-white' : 'text-slate-500'
            }`}
          >
            {tier.label}
          </span>

          {isCurrent && (
            <span
              className="chip px-2 py-0.5 text-[10px]"
              style={{
                borderColor: `${tier.accent}44`,
                backgroundColor: `${tier.accent}1a`,
                color: tier.accent,
              }}
            >
              <Check size={10} strokeWidth={3} />
              You
            </span>
          )}

          {isNext && (
            <span className="chip border-neon-cyan/30 bg-neon-cyan/10 px-2 py-0.5 text-[10px] text-neon-cyan">
              Next up
            </span>
          )}
        </div>

        <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
          {RANK_NOTES[tier.id] ?? 'Earn your way up.'}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p
          className={`tabular text-xs font-bold ${isUnlocked ? 'text-slate-300' : 'text-slate-500'}`}
        >
          {tierRange(tier)}
        </p>
        {!isUnlocked && gap > 0 && (
          <p className="tabular mt-0.5 text-[10px] font-semibold text-slate-600">
            {formatNumber(gap)} to go
          </p>
        )}
      </div>

      {isUnlocked && !isCurrent && (
        <Check size={14} className="hidden shrink-0 text-emerald-400/70 sm:block" />
      )}
      {!isUnlocked && <Lock size={13} className="hidden shrink-0 text-slate-700 sm:block" />}
    </m.div>
  );
}

// ViewRanksButton used to live here and be re-exported. It now has its own
// module (./ViewRanksButton.jsx) so this file can be lazy-loaded; see the note
// there.
