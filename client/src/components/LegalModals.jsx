import { useEffect } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { FileText, ShieldCheck, X } from 'lucide-react';

export function PrivacyModal({ open, onClose }) {
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
          aria-label="Privacy Policy"
        >
          <m.div
            initial={{ opacity: 0, scale: 0.94, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            className="panel relative max-h-[90vh] w-full max-w-2xl overflow-y-auto p-6 sm:p-8"
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
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full border-2 border-emerald-400/40 bg-emerald-400/10">
                <ShieldCheck size={22} className="text-emerald-400" />
              </div>
              <div>
                <h2 className="font-display text-2xl font-black text-white">Privacy Policy</h2>
                <p className="text-sm text-slate-400">Effective as of current release</p>
              </div>
            </div>

            <div className="space-y-4 text-sm leading-relaxed text-slate-400">
              <p>
                We take your privacy seriously. When you submit a task description, it is sent securely to Google's Gemini API
                solely for the purpose of evaluation and grading. We do not use these submissions for advertising or profiling
                beyond what is necessary to provide this service.
              </p>
              <p>
                Account information (such as your email and username) is stored in Supabase. All traffic is transmitted over
                encrypted connections. Your task data is processed transiently for grading purposes.
              </p>
              <p>
                <strong className="text-slate-200">Account Deletion:</strong> You may delete your account at any time. Deleting
                your account permanently and irreversibly removes your profile, points, active streak, and all daily logs from
                our database.
              </p>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

export function TermsModal({ open, onClose }) {
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
          aria-label="Terms of Service"
        >
          <m.div
            initial={{ opacity: 0, scale: 0.94, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            className="panel relative max-h-[90vh] w-full max-w-2xl overflow-y-auto p-6 sm:p-8"
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
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full border-2 border-cyan-400/40 bg-cyan-400/10">
                <FileText size={22} className="text-cyan-400" />
              </div>
              <div>
                <h2 className="font-display text-2xl font-black text-white">Terms of Service</h2>
                <p className="text-sm text-slate-400">Core rules & expectations</p>
              </div>
            </div>

            <div className="space-y-4 text-sm leading-relaxed text-slate-400">
              <p>
                By using this application, you agree to the following core rules:
              </p>
              <ul className="ml-5 list-disc space-y-2">
                <li>
                  <strong className="text-slate-200">One accepted entry per UTC day:</strong> Each calendar day (UTC), you may
                  have at most one accepted submission. Rejected entries do not consume this slot, so you may retry the same
                  day.
                </li>
                <li>
                  <strong className="text-slate-200">Daily decay:</strong> Missing a day results in -30 points and resets your
                  streak. Inactivity is tracked based on your last submission date.
                </li>
                <li>
                  <strong className="text-slate-200">Integrity:</strong> You agree to submit truthful descriptions of real
                  productive work. Attempts to game or falsify entries undermine the community.
                </li>
                <li>
                  <strong className="text-slate-200">Fair use:</strong> Automated abuse, spam, or excessive requests may
                  result in temporary or permanent restrictions.
                </li>
              </ul>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
