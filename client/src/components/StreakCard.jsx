import { m } from 'framer-motion';
import { Flame, Snowflake, Zap } from 'lucide-react';
import { Panel, PanelHeader } from './ui/Panel.jsx';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber.js';

/**
 * Streak counter with a flame that reacts to how alive the streak is.
 *
 * At 0 days the streak is "at risk" (amber, the decay rule is one missed day
 * away). Past 7 it burns hot.
 */
export function StreakCard({ streak = 0, decayPending = false, delay = 0.1 }) {
  const animated = useAnimatedNumber(streak);
  const isAlive = streak > 0;
  const isHot = streak >= 7;

  const accent = !isAlive ? '#fb7185' : isHot ? '#fb923c' : '#fbbf24';

  // Next streak bonus, capped at +50.
  const nextBonus = Math.min((streak + 1) * 5, 50);

  return (
    <Panel className="overflow-hidden" delay={delay}>
      <PanelHeader
        title="Streak"
        icon={Flame}
        accent={accent}
        subtitle={isAlive ? 'Keep it alive — log before UTC midnight' : 'Log today to restart'}
      />

      <div className="relative p-5">
        <div className="flex items-center gap-4">
          <div className="relative grid h-16 w-16 shrink-0 place-items-center">
            {isAlive && (
              <m.span
                className="absolute inset-0 rounded-full"
                style={{ background: `${accent}30`, filter: 'blur(12px)' }}
                animate={{ scale: [1, 1.22, 1], opacity: [0.5, 0.9, 0.5] }}
                transition={{ duration: isHot ? 1.6 : 2.4, repeat: Infinity }}
              />
            )}
            <m.span
              key={streak}
              initial={{ scale: 0.7, rotate: -12 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 14 }}
              className="relative"
            >
              {isAlive ? (
                <Flame size={44} style={{ color: accent }} strokeWidth={2} />
              ) : (
                <Snowflake size={36} className="text-slate-500" strokeWidth={2} />
              )}
            </m.span>
          </div>

          <div>
            <p className="flex items-baseline gap-2">
              <span
                className="tabular font-display text-4xl font-black leading-none"
                style={{ color: isAlive ? accent : '#64748b' }}
              >
                {animated}
              </span>
              <span className="text-sm font-semibold text-slate-500">
                day{animated === 1 ? '' : 's'}
              </span>
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span
                className="chip"
                style={{
                  borderColor: `${accent}3a`,
                  backgroundColor: `${accent}12`,
                  color: accent,
                }}
              >
                <Zap size={11} />
                Next log: +{nextBonus} bonus
              </span>
              {decayPending && !isAlive && (
                <span className="chip border-rose-400/30 bg-rose-400/10 text-rose-300">
                  -30 at rollover
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Decay warning — the core tension of the whole system. */}
        {!isAlive && (
          <p className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/[0.07] px-3 py-2 text-xs text-rose-200/90">
            Streak at zero. Miss a full UTC day and you lose <strong>30 points</strong> on top of
            the streak reset.
          </p>
        )}
      </div>
    </Panel>
  );
}