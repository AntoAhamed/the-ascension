import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';

export function DeleteAccountModal({ open, onClose, onConfirm, username = '', loading = false }) {
  const [value, setValue] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setValue('');
      setConfirmed(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  useEffect(() => {
    const v = value.trim();
    setConfirmed(v === 'DELETE' || v === username);
  }, [value, username]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (confirmed && !loading) {
      onConfirm?.();
    }
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
          aria-label="Delete account"
        >
          <m.div
            initial={{ opacity: 0, scale: 0.94, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            className="panel relative w-full max-w-lg overflow-y-auto p-7 sm:p-8"
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

            <div className="flex items-start gap-4">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full border-2 border-rose-500/40 bg-rose-500/10">
                <AlertTriangle size={24} className="text-rose-400" />
              </div>
              <div>
                <h2 className="font-display text-2xl font-black text-white">Delete Account?</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  This action is <strong className="text-rose-400">permanent and cannot be undone</strong>.
                  Deleting your account will irreversibly erase your profile, points, active streak, and
                  all daily logs.
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label htmlFor="confirm-delete" className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                  Type your username or <span className="text-rose-300">DELETE</span> to confirm
                </label>
                <input
                  ref={inputRef}
                  id="confirm-delete"
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  disabled={loading}
                  className="mt-2 w-full rounded-xl border border-white/[0.08] bg-void-950/80 px-4 py-2.5 text-sm text-white outline-none transition focus:border-rose-400/60 focus:ring-1 focus:ring-rose-400/30 disabled:opacity-60"
                  placeholder={username || 'DELETE'}
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
                  disabled={!confirmed || loading}
                  className="group inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-600/90 px-4 py-2 text-sm font-semibold text-white shadow-[0_0_0_1px_rgba(248,113,113,0.35),0_20px_60px_-30px_rgba(248,113,113,0.9)] transition hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <AlertTriangle size={16} />}
                  Permanently Delete My Account
                </button>
              </div>
            </form>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
