import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { BookOpen, ChevronRight, Crown, Flame, Info, Sparkles, Target, X, Zap } from 'lucide-react';

const DIFFICULTIES = [
  { name: 'Hard', points: '100', note: 'Deep work, major milestones', color: '#fb7185' },
  { name: 'Average', points: '70', note: 'Solid, consistent progress', color: '#fbbf24' },
  { name: 'Easy', points: '50', note: 'Small but real wins', color: '#34d399' },
  { name: 'Invalid', points: '−3', note: 'Trivial/unclear — rejected, day stays open', color: '#94a3b8' },
];

export function AboutModal({ open, onClose, onOpenGuidelines }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-void-950/85 p-4 backdrop-blur-md"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label="About and How It Works"
        >
          <m.div
            initial={{ opacity: 0, scale: 0.94, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            className="panel relative max-h-[90vh] w-full max-w-3xl overflow-y-auto p-6 sm:p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={onClose}
              className="absolute right-4 top-4 rounded-lg p-2 text-slate-500 transition-colors hover:bg-white/[0.07] hover:text-slate-200"
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <div className="mb-6 flex items-center gap-3">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full border-2 border-neon-cyan/40 bg-neon-cyan/10">
                <Info size={22} className="text-neon-cyan" />
              </div>
              <div>
                <h2 className="font-display text-2xl font-black text-white sm:text-3xl">
                  About & How It Works
                </h2>
                <p className="text-sm text-slate-400">One entry per UTC day. Real work only.</p>
              </div>
            </div>

            <div className="space-y-6">
              <section>
                <h3 className="flex items-center gap-2 font-display text-lg font-bold text-white">
                  <Zap size={18} className="text-neon-cyan" /> Core Concept
                </h3>
                <p className="mt-2 leading-relaxed text-slate-400">
                  Each UTC day, you get <strong className="text-slate-200">one shot</strong> to prove you did real, productive work.
                  Gemini AI evaluates your submission and assigns it a difficulty. Submit something trivial and it's rejected (−3 pts) —
                  but <strong className="text-emerald-400">the day stays open</strong> so you can try again.
                </p>
              </section>

              <section>
                <h3 className="flex items-center gap-2 font-display text-lg font-bold text-white">
                  <Target size={18} className="text-neon-cyan" /> Scoring & Ranks
                </h3>
                <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
                  {DIFFICULTIES.map((d) => (
                    <div
                      key={d.name}
                      className="rounded-xl border border-white/[0.06] bg-void-900/50 p-3.5"
                      style={{ borderColor: `${d.color}30`, backgroundColor: `${d.color}0a` }}
                    >
                      <div className="flex items-baseline justify-between">
                        <span className="text-sm font-bold" style={{ color: d.color }}>
                          {d.name}
                        </span>
                        <span className="tabular font-display text-xl font-black" style={{ color: d.color }}>
                          {d.points}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-slate-400">{d.note}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-4 space-y-2 text-sm text-slate-400">
                  <p>
                    <Sparkles size={14} className="mr-1 inline text-neon-cyan" />
                    <strong className="text-slate-200">Streak Bonus:</strong> +5 per consecutive day, capped at +50.
                  </p>
                  <p>
                    <Flame size={14} className="mr-1 inline text-rose-400" />
                    <strong className="text-slate-200">Decay:</strong> Miss a day and lose 30 points — your streak resets.
                  </p>
                  <p>
                    <Crown size={14} className="mr-1 inline text-amber-400" />
                    <strong className="text-slate-200">Ranks:</strong> Climb through 7 tiers from Novice to Apex Luminary.
                  </p>
                </div>
              </section>

              <section>
                <h3 className="flex items-center gap-2 font-display text-lg font-bold text-white">
                  <BookOpen size={18} className="text-neon-cyan" /> Learn More
                </h3>
                <p className="mt-2 text-sm text-slate-400">
                  See real examples of valid vs. invalid entries in the Task Codex.
                </p>
                {onOpenGuidelines && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose?.();
                      onOpenGuidelines();
                    }}
                    className="group mt-3 inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.08]"
                  >
                    View Task Codex
                    <ChevronRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                  </button>
                )}
              </section>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
