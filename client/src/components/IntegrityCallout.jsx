import { m } from 'framer-motion';
import { ShieldCheck } from 'lucide-react';

/**
 * The integrity pledge, shown above the submission box.
 *
 * This is a genuine behavioural gate, not decoration: `SubmissionEngine` refuses to
 * submit until `affirmed` is true, and clears the flag whenever the entry is
 * emptied, so every attempt — including retries after a rejection — has to be
 * affirmed on its own.
 *
 * Tone matters here. The copy is deliberately warm and unhurried rather than
 * punitive: the goal is a user who wants to log truthfully, not one who feels
 * accused.
 */

const PLEDGE =
  'Across every faith, belief system, and moral code, honesty is a core spiritual virtue. True growth comes only from authentic effort. Logging false work degrades your personal character and spiritual integrity. Be truthful to yourself, to the Divine, and to your journey.';

export function IntegrityCallout({ affirmed, onToggle, disabled = false }) {
  return (
    <m.section
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
      aria-labelledby="integrity-heading"
      className="mb-4 overflow-hidden rounded-xl border border-neon-amber/20 bg-gradient-to-br from-neon-amber/[0.07] via-neon-amber/[0.02] to-transparent"
    >
      {/* Hairline of light along the top edge — same trick the onboarding modal uses. */}
      <div className="pointer-events-none h-px bg-gradient-to-r from-transparent via-neon-amber/50 to-transparent" />

      <div className="flex gap-3 p-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-neon-amber/30 bg-neon-amber/10">
          <ShieldCheck size={17} className="text-neon-amber" />
        </span>

        <div className="min-w-0">
          <h3
            id="integrity-heading"
            className="font-display text-[13px] font-black uppercase tracking-wider text-neon-amber"
          >
            A Sacred Commitment to Truth
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{PLEDGE}</p>
        </div>
      </div>

      {/* The gate itself. Sits on its own row so the checkbox reads as a
          deliberate act rather than another line of small print. */}
      <label
        className={`flex cursor-pointer items-start gap-3 border-t border-white/[0.06] bg-void-900/40 px-4 py-3 transition-colors ${
          affirmed ? 'bg-neon-amber/[0.06]' : 'hover:bg-white/[0.02]'
        } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        <input
          type="checkbox"
          checked={affirmed}
          disabled={disabled}
          onChange={(e) => onToggle?.(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-white/20 bg-void-900 text-neon-amber accent-neon-amber focus:ring-2 focus:ring-neon-amber/40 focus:ring-offset-0 disabled:cursor-not-allowed"
        />
        <span className="text-xs leading-relaxed text-slate-300">
          I affirm that this submission reflects{' '}
          <strong className="font-semibold text-white">genuine work completed today</strong>.
        </span>
      </label>
    </m.section>
  );
}
