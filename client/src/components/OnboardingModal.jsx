import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { ArrowRight, BookOpen, Check, Dumbbell, Flame, Lightbulb, Rocket, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { Spinner } from './ui/Spinner.jsx';

/**
 * First-run onboarding.
 *
 * Two steps. Step 1 teaches the rules with real examples — this is where the
 * product stops being ambiguous, because "what counts?" is the first question
 * every new user has. Step 2 sets the username.
 */

const EXAMPLES = [
  {
    label: 'Code',
    icon: Rocket,
    text: 'Shipped the OAuth flow end-to-end — token refresh, 9 tests, deleted the legacy session code.',
    points: 100,
    difficulty: 'Hard',
  },
  {
    label: 'Study',
    icon: Lightbulb,
    text: 'Worked through 2 hours of calculus problem sets and finally understood chain rule integration.',
    points: 70,
    difficulty: 'Average',
  },
  {
    label: 'Fitness',
    icon: Dumbbell,
    text: 'Completed a 5km run at a 5:40 pace, then did 20 minutes of mobility work.',
    points: 70,
    difficulty: 'Average',
  },
  {
    label: 'Business',
    icon: Flame,
    text: 'Wrote and sent the proposal deck, then followed up with two client calls.',
    points: 70,
    difficulty: 'Average',
  },
];

const REJECTED = ['I woke up.', 'Ate lunch with a friend.', 'Watched a lot of Netflix.', 'Was productive.'];

export function OnboardingModal({ open, onClose, suggestedUsername = '', onComplete, onOpenGuidelines }) {
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState(suggestedUsername);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setStep(0);
      setUsername(suggestedUsername);
      setError(null);
    }
  }, [open, suggestedUsername]);

  if (!open) return null;

  const finish = async () => {
    const name = username.trim();
    if (name.length < 3) {
      setError('Pick a username with at least 3 characters.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.profile.update({ username: name, hasCompletedOnboarding: true });
      onComplete?.();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-void-950/85 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to The Ascension"
    >
      <m.div
        initial={{ opacity: 0, scale: 0.94, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        className="panel relative max-h-[90vh] w-full max-w-2xl overflow-y-auto"
      >
        {/* Ambient edge light */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-neon-cyan/60 to-transparent" />

        {step === 0 ? (
          <div className="p-7 sm:p-9">
            <StepDots current={0} total={2} />

            <m.h2
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 font-display text-3xl font-black text-white sm:text-4xl"
            >
              One task. Every day. <span className="text-gradient">Real work only.</span>
            </m.h2>

            <p className="mt-3 max-w-lg leading-relaxed text-slate-400">
              Each UTC day you get <strong className="text-slate-200">one</strong> accepted submission
              at proving you moved something forward. Gemini reads it and scores it. Miss a day and you
              lose <strong className="text-rose-400">30 points</strong>.
            </p>

            <p className="mt-2 max-w-lg text-sm leading-relaxed text-slate-500">
              Submit something trivial and it is rejected for{' '}
              <strong className="text-rose-300">−3 points</strong> — but that does{' '}
              <em>not</em> use up your day. Today stays open until you log real work.
            </p>

            {/* Scoring tiers */}
            <div className="mt-6 grid gap-2.5 sm:grid-cols-3">
              {[
                { d: 'Hard', pts: 100, accent: '#fb7185', note: 'Deep work, big milestones' },
                { d: 'Average', pts: 70, accent: '#fbbf24', note: 'Solid, standard progress' },
                { d: 'Easy', pts: 50, accent: '#34d399', note: 'Small but real wins' },
              ].map((tier, i) => (
                <m.div
                  key={tier.d}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 + i * 0.08 }}
                  className="rounded-xl border p-3.5"
                  style={{ borderColor: `${tier.accent}30`, backgroundColor: `${tier.accent}0a` }}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-bold" style={{ color: tier.accent }}>
                      {tier.d}
                    </span>
                    <span
                      className="tabular font-display text-xl font-black"
                      style={{ color: tier.accent }}
                    >
                      {tier.pts}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">{tier.note}</p>
                </m.div>
              ))}
            </div>

            {/* Examples that pass */}
            <p className="mt-7 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              This gets approved
            </p>
            <div className="mt-2.5 space-y-2">
              {EXAMPLES.map((ex, i) => (
                <m.div
                  key={ex.label}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3 + i * 0.07 }}
                  className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-void-900/50 p-3"
                >
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-emerald-400/25 bg-emerald-400/10">
                    <ex.icon size={13} className="text-emerald-400" />
                  </span>
                  <p className="flex-1 text-xs leading-relaxed text-slate-300">
                    “{ex.text}”
                  </p>
                  <span className="tabular shrink-0 font-display text-sm font-black text-neon-cyan">
                    {ex.points}
                  </span>
                </m.div>
              ))}
            </div>

            {/* Examples that fail */}
            <p className="mt-6 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              This is rejected (−3 pts, day stays open)
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {REJECTED.map((r) => (
                <span
                  key={r}
                  className="chip border-rose-400/25 bg-rose-500/[0.06] text-slate-400 line-through"
                >
                  {r}
                </span>
              ))}
            </div>

            {onOpenGuidelines && (
              <button
                type="button"
                onClick={() => {
                  onClose?.();
                  onOpenGuidelines();
                }}
                className="group mt-4 flex w-full items-center justify-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-neon-cyan sm:justify-start"
              >
                <BookOpen size={13} className="transition-colors group-hover:text-neon-cyan" />
                Read the full Task Codex — examples, scoring and penalties
              </button>
            )}

            <button onClick={() => setStep(1)} className="btn-primary mt-8 w-full sm:w-auto">
              Choose my username
              <ArrowRight size={16} />
            </button>
          </div>
        ) : (
          <div className="p-7 sm:p-9">
            <StepDots current={1} total={2} />

            <h2 className="mt-4 font-display text-3xl font-black text-white">
              What should we call you?
            </h2>
            <p className="mt-2 text-slate-400">
              This is how you appear on the global leaderboard.
            </p>

            <div className="mt-6">
              <label htmlFor="username" className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-400">
                Username
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-display text-slate-600">
                  @
                </span>
                <input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') finish();
                  }}
                  className="field pl-8 font-display text-lg"
                  placeholder="your_name"
                  autoFocus
                  maxLength={20}
                />
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Letters, numbers and underscores. 3–20 characters.
              </p>
            </div>

            {error && (
              <m.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-3 rounded-lg border border-rose-400/25 bg-rose-500/[0.08] px-3 py-2 text-xs text-rose-200"
              >
                {error}
              </m.p>
            )}

            <div className="mt-8 flex flex-wrap gap-3">
              <button onClick={() => setStep(0)} className="btn-ghost">
                Back
              </button>
              <button onClick={finish} disabled={saving} className="btn-primary flex-1 sm:flex-none sm:px-10">
                {saving ? (
                  <>
                    <Spinner size={16} />
                    Saving…
                  </>
                ) : (
                  <>
                    <Check size={16} />
                    Enter the Ascension
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </m.div>
    </m.div>
  );
}

function StepDots({ current, total }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`h-1 rounded-full transition-all duration-300 ${
            i === current ? 'w-8 bg-neon-cyan' : 'w-4 bg-white/15'
          }`}
        />
      ))}
    </div>
  );
}