import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { Loader2, MessageSquare, X } from 'lucide-react';

const FEEDBACK_TYPES = [
  { value: 'bug', label: 'Bug Report' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'appeal', label: 'AI Grading Appeal' },
  { value: 'general', label: 'General Feedback' },
];

export function FeedbackModal({ open, onClose, onSubmit, loading = false }) {
  const [feedbackType, setFeedbackType] = useState('general');
  const [message, setMessage] = useState('');
  const textareaRef = useRef(null);

  useEffect(() => {
    if (open) {
      setFeedbackType('general');
      setMessage('');
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const canSubmit = message.trim().length >= 3 && !loading;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit?.({ feedbackType, message: message.trim() });
  };

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
          aria-label="Feedback and Support"
        >
          <m.div
            initial={{ opacity: 0, scale: 0.94, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            className="panel relative w-full max-w-xl overflow-y-auto p-6 sm:p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="absolute right-4 top-4 rounded-lg p-2 text-slate-500 transition-colors hover:bg-white/[0.07] hover:text-slate-200 disabled:opacity-50"
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <div className="mb-6 flex items-center gap-3">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full border-2 border-neon-cyan/40 bg-neon-cyan/10">
                <MessageSquare size={22} className="text-neon-cyan" />
              </div>
              <div>
                <h2 className="font-display text-2xl font-black text-white">Feedback & Support</h2>
                <p className="text-sm text-slate-400">Tell us what's on your mind</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="feedback-type" className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                  Feedback Type
                </label>
                <select
                  id="feedback-type"
                  value={feedbackType}
                  onChange={(e) => setFeedbackType(e.target.value)}
                  disabled={loading}
                  className="mt-2 w-full rounded-xl border border-white/[0.08] bg-void-950/80 px-4 py-2.5 text-sm text-white outline-none transition focus:border-neon-cyan/60 focus:ring-1 focus:ring-neon-cyan/30 disabled:opacity-60"
                >
                  {FEEDBACK_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="feedback-message" className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                  Details
                </label>
                <textarea
                  ref={textareaRef}
                  id="feedback-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  disabled={loading}
                  placeholder="Please share details to help us understand and respond..."
                  className="mt-2 w-full resize-none rounded-xl border border-white/[0.08] bg-void-950/80 px-4 py-3 text-sm text-white outline-none transition focus:border-neon-cyan/60 focus:ring-1 focus:ring-neon-cyan/30 disabled:opacity-60"
                />
              </div>

              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={loading}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.08] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/[0.12] bg-white/[0.09] px-4 py-2 text-sm font-semibold text-white shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_20px_60px_-30px_rgba(56,189,248,0.9)] transition hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <MessageSquare size={16} />}
                  Send Feedback
                </button>
              </div>
            </form>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
