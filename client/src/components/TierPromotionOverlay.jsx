import { AnimatePresence, m } from 'framer-motion';
import { Crown, Sparkles, TrendingUp } from 'lucide-react';
import { rankIcon } from './RankBadge.jsx';
import { formatNumber } from '../lib/tiers.js';

/**
 * Full-screen rank promotion celebration — the "RANK UP!" moment.
 *
 * Triggered when a submission pushes the user into a new rank. This is the
 * emotional peak of the loop, so it gets a dedicated takeover rather than being
 * buried in a toast. Confetti and the fanfare are fired by the caller
 * (`celebrateTierUp()` / `sound.playTierUp()`) so this component stays purely
 * presentational.
 *
 * The deliberate design choice: the new rank name is the largest thing on
 * screen and everything else is supporting text. A user who just crossed a
 * threshold should not have to read to find out what happened.
 */
export function TierPromotionOverlay({
  show,
  fromTier,
  toTier,
  accent = '#ffd166',
  points,
  pointsBefore,
  onDismiss,
  onViewRanks,
}) {
  const Icon = rankIcon({ id: toTierId(toTier) });

  return (
    <AnimatePresence>
      {show && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onDismiss}
          className="fixed inset-0 z-[9998] flex cursor-pointer items-center justify-center overflow-y-auto bg-void-950/90 p-6 backdrop-blur-lg"
          role="dialog"
          aria-modal="true"
          aria-label="Rank up"
        >
          {/* Radiating rays */}
          <m.div
            className="pointer-events-none absolute h-[140vmax] w-[140vmax] opacity-30"
            style={{
              background: `conic-gradient(from 0deg, transparent 0deg, ${accent}22 20deg, transparent 40deg, ${accent}22 60deg, transparent 80deg)`,
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: 28, repeat: Infinity, ease: 'linear' }}
          />

          {/* Expanding shockwave rings, fired on entry. */}
          {[0, 0.25, 0.5].map((delay) => (
            <m.div
              key={delay}
              className="pointer-events-none absolute h-40 w-40 rounded-full border"
              style={{ borderColor: `${accent}55` }}
              initial={{ scale: 0.3, opacity: 0.7 }}
              animate={{ scale: 5, opacity: 0 }}
              transition={{ duration: 2, delay: 0.2 + delay, ease: 'easeOut' }}
            />
          ))}

          <m.div
            initial={{ scale: 0.8, y: 30, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.92, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 180, damping: 18, delay: 0.1 }}
            className="relative my-auto max-w-lg text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <m.div
              initial={{ scale: 0, rotate: -180 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 200, damping: 14, delay: 0.25 }}
              className="mx-auto grid h-24 w-24 place-items-center rounded-3xl border-2"
              style={{
                borderColor: accent,
                backgroundColor: `${accent}1a`,
                boxShadow: `0 0 60px -6px ${accent}`,
              }}
            >
              <Icon size={44} style={{ color: accent }} />
            </m.div>

            <m.p
              initial={{ opacity: 0, y: 12, letterSpacing: '0.9em' }}
              animate={{ opacity: 1, y: 0, letterSpacing: '0.35em' }}
              transition={{ delay: 0.4 }}
              className="mt-7 text-xs font-bold uppercase text-slate-300"
            >
              Rank Up
            </m.p>

            <m.h2
              initial={{ opacity: 0, y: 16, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ delay: 0.5, duration: 0.5 }}
              className="mt-2 font-display text-4xl font-black leading-tight sm:text-6xl"
              style={{ color: accent, textShadow: `0 0 50px ${accent}66` }}
            >
              {toTier}
            </m.h2>

            {/* The number that did it. Concrete cause, concrete effect. */}
            {points !== undefined && points !== null && (
              <m.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.62 }}
                className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5"
              >
                <TrendingUp size={13} style={{ color: accent }} />
                <span className="tabular font-display text-sm font-black" style={{ color: accent }}>
                  +{formatNumber(points)}
                </span>
                {pointsBefore !== undefined && pointsBefore !== null && (
                  <span className="tabular text-xs text-slate-500">
                    {formatNumber(pointsBefore)} → {formatNumber(pointsBefore + points)}
                  </span>
                )}
              </m.p>
            )}

            {fromTier && (
              <m.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.68 }}
                className="mt-3 text-sm text-slate-500"
              >
                promoted from <span className="font-semibold text-slate-400">{fromTier}</span>
              </m.p>
            )}

            <m.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.78 }}
              className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 py-2 text-xs font-semibold text-slate-300"
            >
              <Sparkles size={13} style={{ color: accent }} />
              Keep the streak alive — the next rank is closer than you think
            </m.p>

            <m.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.88 }}
              className="mt-8 flex flex-wrap items-center justify-center gap-3"
            >
              {onViewRanks && (
                <button type="button" onClick={onViewRanks} className="btn-ghost">
                  <Crown size={15} style={{ color: accent }} />
                  See the full ladder
                </button>
              )}
              <button type="button" onClick={onDismiss} className="btn-primary">
                Continue
              </button>
            </m.div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The overlay receives a rank *label*, but the icon map is keyed by id. Map the
 * label back to an id; an unknown label falls back to the neutral Award icon
 * rather than rendering nothing.
 */
function toTierId(label) {
  const map = {
    Novice: 'novice',
    Apprentice: 'apprentice',
    Practitioner: 'practitioner',
    Specialist: 'specialist',
    Architect: 'architect',
    Grandmaster: 'grandmaster',
    'Apex Luminary': 'apex',
  };
  return map[label];
}
