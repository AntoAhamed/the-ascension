import { m } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Clock, Hourglass, Undo2 } from 'lucide-react';
import { Panel, PanelHeader } from './ui/Panel.jsx';
import { useCountdown } from '../hooks/useCountdown.js';
import { DifficultyBadge } from './DifficultyBadge.jsx';

/**
 * Daily status indicator + countdown to UTC midnight.
 *
 * This is the pressure element: it always shows how long is left to earn
 * today's points, and how long until the streak decays.
 */
export function DailyStatusCard({ todayStatus, todayLog, revokedLog, delay = 0.15 }) {
  const { msLeft, hours, minutes, seconds, isUrgent } = useCountdown();
  const submitted = Boolean(todayStatus?.hasSubmitted);

  // The reset is 00:00 UTC everywhere, which is almost never local midnight —
  // saying only "Resets in" reads as a bug to anyone more than an hour off UTC.
  // Name the local wall-clock time of the reset so the duration has a frame of
  // reference: "5:00:00 left" makes sense once you can see it means 6:00 AM here.
  const resetLocalTime = new Date(Date.now() + msLeft).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  const accent = submitted ? '#34d399' : isUrgent ? '#fb7185' : '#22d3ee';

  return (
    <Panel className="overflow-hidden" delay={delay}>
      <PanelHeader
        title="Today's Status"
        icon={submitted ? CheckCircle2 : Hourglass}
        accent={accent}
        subtitle={submitted ? 'Mission complete for today' : 'Mission pending — the clock is running'}
      />

      <div className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p
              className="font-display text-2xl font-black uppercase tracking-wide"
              style={{ color: accent }}
            >
              {submitted ? 'Approved' : 'Pending'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {submitted
                ? 'Come back after UTC midnight for a fresh window.'
                : 'Submit one primary achievement before the day rolls over.'}
            </p>
          </div>

          <div className="text-right">
            <p className="flex items-center justify-end gap-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              <Clock size={11} />
              Resets in
            </p>
            <m.p
              animate={isUrgent && !submitted ? { opacity: [1, 0.55, 1] } : {}}
              transition={{ duration: 1.4, repeat: Infinity }}
              className="tabular mt-1 font-mono text-2xl font-bold"
              style={{ color: submitted ? '#34d399' : isUrgent ? '#fb7185' : '#e2e8f0' }}
            >
              {String(hours).padStart(2, '0')}:{String(minutes).padStart(2, '0')}:
              {String(seconds).padStart(2, '0')}
            </m.p>
            <p className="mt-1 text-[10px] font-medium leading-tight text-slate-600">
              at 00:00 UTC
              <br />
              {resetLocalTime} your time
            </p>
          </div>
        </div>

        {/* Segmented progress through the current UTC day. */}
        <DayProgress isUrgent={isUrgent} />

        {!submitted && (todayStatus?.rejectedAttemptsToday ?? 0) > 0 && (
          <m.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-rose-400/25 bg-rose-500/[0.06] px-3.5 py-2.5"
          >
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-200/90">
              <AlertTriangle size={12} />
              {todayStatus.rejectedAttemptsToday} rejected attempt
              {todayStatus.rejectedAttemptsToday === 1 ? '' : 's'} · slot still open
            </span>
            <span className="tabular shrink-0 text-xs font-black text-rose-300">
              −{todayStatus.penaltyToday} pts
            </span>
          </m.div>
        )}

        {submitted && todayLog && (
          <m.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="mt-4 rounded-xl border border-white/[0.07] bg-void-900/60 p-3.5"
          >
            <div className="flex items-center justify-between gap-3">
              <DifficultyBadge difficulty={todayLog.difficulty} />
              <span className="tabular font-display text-lg font-black text-neon-cyan">
                +{todayLog.pointsAwarded}
              </span>
            </div>
            <p className="mt-2.5 text-sm leading-relaxed text-slate-300">
              {todayLog.taskDescription}
            </p>
            {todayLog.aiFeedback && (
              <p className="mt-2.5 border-l-2 border-neon-violet/40 pl-3 text-xs italic leading-relaxed text-slate-400">
                {todayLog.aiFeedback}
              </p>
            )}
            {todayLog.streakBonus > 0 && (
              <p className="mt-2 text-[11px] font-semibold text-neon-amber">
                includes +{todayLog.streakBonus} streak bonus
              </p>
            )}
          </m.div>
        )}

        {/* An entry taken back today. Shown in place of the approved card so the
            status never looks like it silently lost the day's record. */}
        {!submitted && revokedLog && (
          <m.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 rounded-xl border border-slate-500/20 bg-slate-500/[0.06] p-3.5"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400">
                <Undo2 size={12} />
                Replaced today
              </span>
              <span className="tabular font-display text-lg font-black text-slate-500">
                −{revokedLog.pointsAwarded}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500 line-through decoration-slate-600">
              {revokedLog.taskDescription}
            </p>
          </m.div>
        )}
      </div>
    </Panel>
  );
}

/** Thin 24-cell rail showing elapsed hours of the UTC day. */
function DayProgress({ isUrgent }) {
  const now = new Date();
  const pct = (now.getUTCHours() * 60 + now.getUTCMinutes()) / (24 * 60);
  const filled = Math.round(pct * 24);

  return (
    <div className="mt-4">
      <div className="flex gap-1">
        {Array.from({ length: 24 }).map((_, i) => (
          <m.div
            key={i}
            initial={{ scaleY: 0.2, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            transition={{ delay: i * 0.012 }}
            className="h-1.5 flex-1 origin-bottom rounded-full"
            style={{
              backgroundColor:
                i < filled ? (isUrgent ? '#fb7185' : '#22d3ee') : 'rgba(255,255,255,0.07)',
              opacity: i < filled ? (i > filled - 4 ? 0.55 : 1) : 1,
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] font-medium text-slate-600">
        <span>00:00 UTC</span>
        <span>{filled} of 24 hours elapsed</span>
        <span>24:00 UTC</span>
      </div>
    </div>
  );
}