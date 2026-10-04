import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Brain,
  CheckCircle2,
  RotateCcw,
  Send,
  Sparkles,
  Undo2,
  XCircle,
} from 'lucide-react';
import { Panel, PanelHeader } from './ui/Panel.jsx';
import { Spinner } from './ui/Spinner.jsx';
import { DifficultyBadge } from './DifficultyBadge.jsx';
import { IntegrityCallout } from './IntegrityCallout.jsx';
import { useSound } from '../hooks/useSound.js';
import { api } from '../lib/api.js';
import { INVALID_PENALTY } from '../lib/tiers.js';
import { useToast } from './ui/Toast.jsx';

const MAX = 1500;
const MIN = 15;

/**
 * The daily submission engine.
 *
 * A rejected entry does NOT burn the daily slot — it only costs a small
 * penalty — so the input intentionally stays open and the user can retry
 * immediately. Only an accepted entry locks the panel via the `locked` prop.
 *
 * Submission is gated on the integrity affirmation. The flag is cleared whenever
 * the entry is emptied, so a retry after a rejection has to be affirmed again —
 * one affirmation covers one attempt, never a blank cheque for the day.
 */
export function SubmissionEngine({
  locked,
  onSubmitted,
  onRevoked,
  todayLog,
  revokedLog,
  tierProgress,
  suggestedPoints,
  penaltyToday = 0,
  rejectedAttemptsToday = 0,
  soundOn = true,
  onOpenGuidelines,
}) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | judging | accepted | penalized
  const [result, setResult] = useState(null);
  const [affirmed, setAffirmed] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const abortRef = useRef(null);
  const toast = useToast();
  const sound = useSound({ enabled: soundOn });

  // The affirmation belongs to a specific entry, not to the day. Emptying the
  // box — after a rejection, or by hand — revokes it.
  useEffect(() => {
    if (!text.trim()) setAffirmed(false);
  }, [text]);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const value = text.trim();

    if (value.length < MIN) {
      toast.error(`Add a bit more detail — ${MIN - value.length} more characters.`);
      return;
    }

    // The button is disabled, but a form can still be submitted with Enter from
    // inside the textarea, so re-check here rather than trusting the UI.
    if (!affirmed) {
      toast.error('Affirm the statement above before submitting.');
      return;
    }

    setPhase('judging');
    sound.playJudging();

    abortRef.current = new AbortController();

    try {
      const payload = await api.submissions.create(value, abortRef.current.signal);

      setResult(payload);

      if (payload.accepted) {
        setPhase('accepted');
        sound.playApproved();
      } else {
        // Rejected: keep the form usable and clear the box so the next attempt
        // starts from a blank slate.
        setPhase('penalized');
        setText('');
        sound.playRejected();
      }

      // Hand the payload to the parent so it can fire confetti, play the
      // tier-up fanfare, and refresh the dashboard.
      onSubmitted?.(payload);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setPhase('idle');

      // An infrastructure failure is NOT a rejection. Two things must differ or
      // the app actively misleads the user: the penalty sound (it implies points
      // were deducted, and none were) and the text (a busy judge says nothing
      // about whether the entry was any good). The form stays open and the entry
      // is preserved either way, so retrying costs nothing.
      if (err?.code === 'AI_SERVICE_UNAVAILABLE') {
        toast.error(err.message ?? 'The judge is unavailable. Your daily attempt was not used.', {
          title: 'Service busy',
          duration: 9000,
        });
        return;
      }

      sound.playRejected();
      toast.error(err.message ?? 'Submission failed. Please try again.');
    } finally {
      abortRef.current = null;
    }
  };

  const cancelJudging = () => {
    abortRef.current?.abort();
    setPhase('idle');
  };

  /**
   * Undoes today's accepted entry.
   *
   * The confirmation step is not decoration: this genuinely takes points and
   * the streak back off the user's balance, and the daily slot only reopens
   * because of it. A single stray click would otherwise silently undo real
   * work they had already banked.
   */
  const handleRevoke = async () => {
    setRevoking(true);
    try {
      const payload = await api.submissions.revokeToday();

      setConfirmRevoke(false);
      // The form was locked by this log; clear local state so when the parent
      // flips `locked` back to false the panel opens on a blank entry.
      setResult(null);
      setPhase('idle');
      setText('');
      setAffirmed(false);

      const removed = payload.pointsRemoved ?? 0;
      const streakNote =
        payload.streakBefore > payload.streakAfter
          ? ` Your streak drops from ${payload.streakBefore} to ${payload.streakAfter} — only a submission today keeps it alive.`
          : '';

      toast.success(
        `−${removed} points returned.${streakNote} Log your stronger entry now.`,
        { title: 'Submission removed', duration: 9000 }
      );

      onRevoked?.(payload);
    } catch (err) {
      setConfirmRevoke(false);
      toast.error(err.message ?? 'Could not remove the submission.', { duration: 8000 });
    } finally {
      setRevoking(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Locked: today's window is already spent                            */
  /* ---------------------------------------------------------------- */
  if (locked) {
    return (
      <Panel className="overflow-hidden" delay={0.05}>
        <PanelHeader
          title="Daily Proof"
          icon={CheckCircle2}
          accent="#34d399"
          subtitle="Today's submission is locked until UTC midnight"
        />
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <m.div
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 220, damping: 16 }}
            className="grid h-16 w-16 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/10"
          >
            <CheckCircle2 size={32} className="text-emerald-400" />
          </m.div>
          <div>
            <p className="text-lg font-bold text-white">Mission complete</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">
              One primary achievement per UTC day. The window reopens the moment the clock rolls
              over — use the time to actually build something.
            </p>
          </div>
          {todayLog && (
            <div className="mt-2 w-full max-w-md rounded-xl border border-white/[0.07] bg-void-900/60 p-4 text-left">
              <div className="flex items-center justify-between gap-3">
                <DifficultyBadge difficulty={todayLog.difficulty} />
                <span className="tabular font-display text-xl font-black text-neon-cyan">
                  +{todayLog.pointsAwarded}
                </span>
              </div>
              <p className="mt-2.5 text-sm leading-relaxed text-slate-300">{todayLog.taskDescription}</p>
              {todayLog.aiFeedback && (
                <p className="mt-2.5 border-l-2 border-neon-violet/40 pl-3 text-xs italic leading-relaxed text-slate-400">
                  {todayLog.aiFeedback}
                </p>
              )}
            </div>
          )}

          {/* Understated by design. Replacing a good entry is a legitimate move,
              but it should not feel like the encouraged path. */}
          <div className="mt-4 w-full max-w-md border-t border-white/[0.06] pt-4">
            <button
              type="button"
              onClick={() => setConfirmRevoke(true)}
              className="group inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-neon-cyan"
            >
              <Undo2 size={13} className="transition-transform group-hover:-rotate-45" />
              Logged something better? Remove &amp; submit higher work
            </button>
            <p className="mt-1.5 text-[11px] text-slate-600">
              Available until 00:00 UTC. Today's points come off your total.
            </p>
          </div>
        </div>

        <AnimatePresence>
          {confirmRevoke && todayLog && (
            <RevokeConfirmModal
              log={todayLog}
              busy={revoking}
              onCancel={() => setConfirmRevoke(false)}
              onConfirm={handleRevoke}
            />
          )}
        </AnimatePresence>
      </Panel>
    );
  }

  /* ---------------------------------------------------------------- */
  /* Active form                                                       */
  /* ---------------------------------------------------------------- */

  // A submission taken back earlier today. The points are already off the
  // balance and the entry can no longer be changed, so this is a receipt, not
  // an action — and it is deliberately quieter than the rejection banner above.
  const revokedToday = revokedLog;

  return (
    <Panel className="overflow-hidden" delay={0.05}>
      <PanelHeader
        title="Daily Proof"
        icon={Sparkles}
        accent="#22d3ee"
        subtitle="Record today's single biggest productive achievement"
        right={
          <span className="tabular hidden text-xs font-semibold text-slate-500 sm:block">
            {text.length} / {MAX}
          </span>
        }
      />

      <form onSubmit={handleSubmit} className="p-5">
        {/* What was taken back today, for the record. */}
        <AnimatePresence>
          {revokedToday && (
            <m.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mb-4 flex flex-wrap items-start gap-2.5 rounded-xl border border-slate-500/20 bg-slate-500/[0.06] px-3.5 py-2.5">
                <Undo2 size={14} className="mt-0.5 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-slate-400">
                    Replaced earlier today.{' '}
                    <span className="tabular font-semibold text-slate-300">
                      −{revokedToday.pointsAwarded} pts
                    </span>{' '}
                    was returned — that entry no longer counts and cannot be restored.
                  </p>
                  <p className="mt-1 truncate text-[11px] italic text-slate-600">
                    “{revokedToday.taskDescription}”
                  </p>
                </div>
              </div>
            </m.div>
          )}
        </AnimatePresence>

        {/* Running total of today's rejected attempts, if any. */}
        <AnimatePresence>
          {rejectedAttemptsToday > 0 && (
            <m.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-3.5 py-2.5">
                <span className="tabular rounded-md bg-rose-500/20 px-2 py-0.5 font-display text-xs font-black text-rose-300">
                  −{penaltyToday} pts
                </span>
                <span className="text-xs text-rose-200/80">
                  {rejectedAttemptsToday === 1
                    ? 'One rejected entry today. Today’s slot is still open — make the next one count.'
                    : `${rejectedAttemptsToday} rejected entries today. Today’s slot is still open — make the next one count.`}
                </span>
              </div>
            </m.div>
          )}
        </AnimatePresence>

        {/* The integrity gate. Sits directly above the box it governs. */}
        <IntegrityCallout
          affirmed={affirmed}
          onToggle={setAffirmed}
          disabled={phase === 'judging'}
        />

        <label htmlFor="task" className="sr-only">
          Describe your productive work
        </label>
        <textarea
          id="task"
          value={text}
          onChange={(e) => {
            if (e.target.value.length <= MAX) setText(e.target.value);
            // Clear a stale verdict as soon as the user edits again.
            if (phase === 'accepted' || phase === 'penalized') {
              setPhase('idle');
              setResult(null);
            }
          }}
          disabled={phase === 'judging'}
          rows={5}
          maxLength={MAX}
          placeholder="e.g. Shipped the OAuth flow end-to-end — handled token refresh, wrote 9 tests, and deleted the legacy session code."
          className="field resize-none leading-relaxed disabled:opacity-60"
        />

        {/* Live feedback on entry quality. */}
        <AnimatePresence>
          {text.length > 0 && text.trim().length < 15 && phase === 'idle' && (
            <m.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-2 text-xs text-slate-500"
            >
              {15 - text.trim().length} more characters — the judge needs enough detail to tell
              real work from a status update.
            </m.p>
          )}
        </AnimatePresence>

        {/* Prompt the user to aim higher while their entry looks thin. */}
        {phase === 'idle' && text.trim().length >= 15 && (
          <p className="mt-2 text-xs text-slate-500">
            Potential award: up to{' '}
            <strong className="text-neon-amber">
              {suggestedPoints ?? 100} pts + streak bonus
            </strong>
          </p>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={phase === 'judging' || !affirmed}
            title={!affirmed ? 'Affirm the statement above to submit' : undefined}
            className="btn-primary flex-1 sm:flex-none sm:px-8"
          >
            {phase === 'judging' ? (
              <>
                <Brain size={17} className="animate-pulse" />
                The judge is reading…
              </>
            ) : phase === 'penalized' ? (
              <>
                <Send size={16} />
                Try again
              </>
            ) : (
              <>
                <Send size={16} />
                Submit for verification
              </>
            )}
          </button>

          {phase === 'judging' && (
            <button type="button" onClick={cancelJudging} className="btn-ghost">
              Cancel
            </button>
          )}
        </div>

        {/* Escape hatch: the rules, one click away. */}
        {onOpenGuidelines && (
          <button
            type="button"
            onClick={onOpenGuidelines}
            className="group mt-3 flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-neon-cyan"
          >
            <BookOpen size={13} className="transition-colors group-hover:text-neon-cyan" />
            Not sure what counts? Check the Task Guidelines
            <ArrowRight
              size={12}
              className="transition-transform group-hover:translate-x-0.5"
            />
          </button>
        )}

        {/* Explains the disabled button, so a locked CTA never looks broken. */}
        <AnimatePresence mode="wait">
          <m.p
            key={affirmed ? 'affirmed' : 'unaffirmed'}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={`mt-3 text-[11px] leading-relaxed ${
              affirmed ? 'text-neon-amber/60' : 'text-slate-600'
            }`}
          >
            {affirmed ? (
              <>
                Affirmed. One accepted entry per UTC day — trivial or vague entries cost{' '}
                {INVALID_PENALTY} points but leave your slot open.
              </>
            ) : (
              <>
                Tick the affirmation above to unlock submission. One accepted entry per UTC day —
                trivial or vague entries cost {INVALID_PENALTY} points but leave your slot open.
              </>
            )}
          </m.p>
        </AnimatePresence>

        <AnimatePresence>{phase === 'judging' && <JudgingOverlay />}</AnimatePresence>
        <AnimatePresence>
          {(phase === 'accepted' || phase === 'penalized') && result && (
            <ResultPanel key={phase} result={result} />
          )}
        </AnimatePresence>
      </form>
    </Panel>
  );
}

/**
 * Confirmation before undoing today's submission.
 *
 * States the exact consequences rather than a generic "are you sure": the
 * precise points that come off (base + streak bonus, since the refund covers
 * both), and the fact that the entry is gone rather than archived. Also warns
 * when today's entry is what is holding the streak alive, since losing the
 * streak is the part users are most likely to regret.
 */
function RevokeConfirmModal({ log, busy, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const breakdown =
    log.streakBonus > 0
      ? `${log.basePoints} base + ${log.streakBonus} streak bonus`
      : `${log.basePoints} points`;

  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !busy && onCancel()}
      className="fixed inset-0 z-[9999] flex cursor-pointer items-center justify-center bg-void-950/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-title"
    >
      <m.div
        initial={{ scale: 0.95, y: 16, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        onClick={(e) => e.stopPropagation()}
        className="panel w-full max-w-md overflow-hidden"
      >
        <div className="flex items-start gap-3 p-5 pb-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-amber-400/25 bg-amber-400/10">
            <Undo2 size={18} className="text-amber-400" />
          </span>
          <div className="min-w-0">
            <h3 id="revoke-title" className="font-display text-base font-black text-white">
              Remove today's submission?
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              This frees your daily slot so you can log a higher-impact entry instead.
            </p>
          </div>
        </div>

        <div className="space-y-2.5 px-5 pb-4">
          <div className="rounded-xl border border-white/[0.07] bg-void-900/60 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              The entry you are removing
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-300">{log.taskDescription}</p>
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-500/[0.06] px-3 py-2.5 text-xs leading-relaxed text-rose-100/90">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-rose-400" />
            <span>
              <strong className="tabular font-bold text-rose-200">
                −{log.pointsAwarded} points
              </strong>{' '}
              will come off your total ({breakdown}). If that entry is holding your{' '}
              <strong className="font-semibold">daily streak</strong> alive, the streak is lost
              until you submit again today.
            </span>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-500">
            Today’s rejected attempts are <em>not</em> affected and stay on your record. This
            cannot be undone — once removed, that entry is gone.
          </p>
        </div>

        <div className="flex gap-3 border-t border-white/[0.06] bg-void-900/40 px-5 py-3.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="btn-ghost flex-1"
          >
            Keep it
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="btn-primary flex-1"
          >
            {busy ? 'Removing…' : 'Remove & resubmit'}
          </button>
        </div>
      </m.div>
    </m.div>
  );
}

/** Overlay shown while Gemini evaluates — narrates the criteria being checked. */
function JudgingOverlay() {
  const checks = [
    'Is this real, actionable work?',
    'Is it more than a status update?',
    'How deep did it go?',
    'Assigning difficulty tier…',
  ];

  return (
    <m.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <div className="mt-4 rounded-xl border border-neon-cyan/20 bg-neon-cyan/[0.05] p-4">
        <div className="flex items-center gap-3">
          <Spinner size={16} className="text-neon-cyan" />
          <span className="text-sm font-semibold text-neon-cyan">Gemini is judging your entry</span>
        </div>
        <ul className="mt-3 space-y-1.5">
          {checks.map((c, i) => (
            <m.li
              key={c}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 + i * 0.28 }}
              className="flex items-center gap-2 text-xs text-slate-400"
            >
              <span className="h-1 w-1 rounded-full bg-neon-cyan" />
              {c}
            </m.li>
          ))}
        </ul>
      </div>
    </m.div>
  );
}

/** The verdict. Accepted shows the reward; rejected shows the penalty. */
function ResultPanel({ result }) {
  const { accepted, evaluation, pointsGained, basePoints, streakBonus, pointsBefore, penaltyPoints } =
    result;

  /* ---------------- Rejected: -3 penalty, slot stays open ---------------- */
  if (!accepted) {
    const lost = Math.abs(pointsGained);

    return (
      <m.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 24 }}
        className="mt-4"
      >
        <div
          className="rounded-xl border p-4"
          style={{
            borderColor: 'rgba(251,113,133,0.30)',
            backgroundColor: 'rgba(244,63,94,0.07)',
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <XCircle size={20} className="text-rose-400" />
              <DifficultyBadge difficulty={evaluation.difficulty} />
            </div>
            <m.span
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.12, type: 'spring', stiffness: 300, damping: 15 }}
              className="tabular font-display text-2xl font-black text-rose-300"
            >
              −{lost}
            </m.span>
          </div>

          <div className="mt-3 flex items-center justify-between rounded-lg border border-rose-400/20 bg-void-900/50 px-3 py-2 text-xs">
            <span className="text-rose-200/80">
              {lost < penaltyPoints
                ? `Serious entry penalty (−${penaltyPoints}, floored at 0)`
                : `Invalid entry penalty (−${penaltyPoints})`}
            </span>
            <span className="tabular font-bold text-rose-200">
              {pointsBefore} → {pointsBefore + pointsGained}
            </span>
          </div>

          <p className="mt-3 text-sm leading-relaxed text-slate-300">{evaluation.aiFeedback}</p>

          {evaluation.reasoning && (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              <span className="font-semibold uppercase tracking-wide">Judge: </span>
              {evaluation.reasoning}
            </p>
          )}

          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-xs leading-relaxed text-amber-200/90">
            <RotateCcw size={14} className="mt-0.5 shrink-0" />
            <span>
              Today’s slot is <strong className="font-semibold text-amber-100">still open</strong>.
              The −{penaltyPoints} is already applied, so make this next entry real work — build,
              study, train, or ship something specific.
            </span>
          </div>
        </div>
      </m.div>
    );
  }

  /* ---------------- Accepted: full reward breakdown ---------------- */
  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: 'spring', stiffness: 200, damping: 24 }}
      className="mt-4"
    >
      <div
        className="rounded-xl border p-4"
        style={{
          borderColor: 'rgba(52,211,153,0.28)',
          backgroundColor: 'rgba(52,211,153,0.06)',
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 size={20} className="text-emerald-400" />
            <DifficultyBadge difficulty={evaluation.difficulty} />
          </div>
          <m.span
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.15, type: 'spring', stiffness: 300, damping: 15 }}
            className="tabular font-display text-2xl font-black text-emerald-400"
          >
            +{pointsGained}
          </m.span>
        </div>

        {streakBonus > 0 && (
          <div className="mt-3 flex items-center justify-between rounded-lg border border-white/[0.06] bg-void-900/50 px-3 py-2 text-xs">
            <span className="text-slate-400">
              Base {basePoints} + streak bonus {streakBonus}
            </span>
            <span className="tabular font-bold text-neon-cyan">
              {pointsBefore} → {pointsBefore + pointsGained}
            </span>
          </div>
        )}

        <p className="mt-3 text-sm leading-relaxed text-slate-300">{evaluation.aiFeedback}</p>

        {evaluation.reasoning && (
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            <span className="font-semibold uppercase tracking-wide">Judge: </span>
            {evaluation.reasoning}
          </p>
        )}
      </div>
    </m.div>
  );
}