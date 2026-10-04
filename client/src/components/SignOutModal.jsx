import { useEffect, useRef } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { LogOut } from 'lucide-react';

/**
 * Asks before ending a session.
 *
 * Signing out is not destructive the way deleting an account is — nothing is
 * lost — but it is disruptive and one click away from a stray keystroke. It ends
 * the session on this device, so an accidental click costs a user their streak
 * context, their draft entry, and a re-login. That is worth one question.
 *
 * WHY A MODAL AND NOT window.confirm()
 *   confirm() is unstyled, blocking, and — critically for this app — cannot be
 *   animated or brought in line with the rest of the UI. It also cannot promise
 *   an autofocus target, and on some platforms it renders behind the OS chrome.
 *
 * THE FOCUS TARGET IS CANCEL, DELIBERATELY
 *   The dialog opens with focus on the safe action, so a stray Enter dismisses it
 *   rather than signing the user out. Opening with focus on "Log out" would make
 *   the same keystroke that opened the dialog also confirm it, and the two events
 *   are close enough together in time for that to be a real hazard.
 */
export function SignOutModal({ open, onClose, onConfirm, loading = false }) {
  const panelRef = useRef(null);
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    // Whatever had focus before the dialog opened gets it back afterwards, so
    // dismissing it does not strand keyboard users at the top of the document.
    const previous = document.activeElement;
    cancelRef.current?.focus();

    /**
     * Everything a Tab can reach inside the panel.
     *
     * Deliberately not filtered on visibility: the panel has exactly three
     * focusable elements and they are all rendered whenever `open` is true, so a
     * visibility check would be a place to be wrong with no upside.
     */
    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        // stopPropagation so an Escape here cannot also reach a dialog beneath.
        e.stopPropagation();
        onClose?.();
        return;
      }

      if (e.key !== 'Tab') return;

      // Trap. Without this, Tab walks out of the dialog into the page behind it,
      // which is still mounted and still focusable — so a keyboard user ends up
      // clicking buttons on a dialog they cannot see.
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      // `.focus` rather than `.focus()`: the trigger may already be gone, e.g.
      // after a delete flow that has navigated away.
      previous?.focus?.();
    };
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
        >
          <m.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sign-out-title"
            aria-describedby="sign-out-body"
            initial={{ opacity: 0, scale: 0.94, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            className="panel relative w-full max-w-md p-6 sm:p-7"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-4">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full border-2 border-white/15 bg-white/[0.06]">
                <LogOut size={22} className="text-slate-200" />
              </div>
              <div>
                <h2 id="sign-out-title" className="font-display text-xl font-black text-white">
                  Are you sure you want to log out?
                </h2>
                <p id="sign-out-body" className="mt-2 text-sm leading-relaxed text-slate-400">
                  Your streak and points are saved. You will need to sign in again to keep logging
                  today's work.
                </p>
              </div>
            </div>

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                ref={cancelRef}
                type="button"
                onClick={onClose}
                disabled={loading}
                className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.08] disabled:opacity-50"
              >
                Stay signed in
              </button>
              <button
                type="button"
                onClick={() => onConfirm?.()}
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/[0.12] bg-white/[0.09] px-4 py-2 text-sm font-semibold text-white shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_20px_60px_-30px_rgba(148,163,184,0.9)] transition hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <LogOut size={16} />
                Log out
              </button>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}