import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { Info, LogOut, Menu, MessageSquare, Trash2, Volume2, VolumeX } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { accentForRank, rankFor } from '../lib/tiers.js';

/**
 * The header's overflow menu, shown below the `sm` breakpoint.
 *
 * Why it exists: the full control row — About, Feedback, sound, avatar, sign
 * out, delete — is ~190 px of buttons, and a phone is 360-430 px wide. All of
 * them in one flex row is how the header came to overflow the viewport. The
 * essentials (brand, tabs, rank) stay on the bar at every width; everything
 * else lives here, one tap away, instead of off the right edge of the screen.
 *
 * Behavioural contract, same as the dialogs:
 *   - Escape closes it and returns focus to the trigger;
 *   - a pointer anywhere else closes it;
 *   - focus moves into the menu when it opens, so keyboard and screen-reader
 *     users land on the first item rather than having to hunt for it;
 *   - choosing an item closes the menu FIRST, then acts — an action that opens
 *     a dialog (sign out, delete) must not leave this menu floating above it.
 */
export function HeaderMenu({
  profile,
  tierTable,
  soundOn,
  onToggleSound,
  onOpenAbout,
  onOpenFeedback,
  onRequestSignOut,
  onDeleteAccount,
}) {
  const { isGuest } = useAuth();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const accent = accentForRank(tierTable, { points: profile?.points, tier: profile?.tier });
  const rankLabel = rankFor(tierTable, { points: profile?.points, tier: profile?.tier })?.label ?? '';

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (event) => {
      if (!panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    // Move focus to the first item once the panel has mounted.
    const id = requestAnimationFrame(() => {
      panelRef.current?.querySelector('[role="menuitem"]')?.focus();
    });

    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  /** Close first, then act — see the contract above. */
  const choose = (action) => () => {
    setOpen(false);
    triggerRef.current?.focus();
    action?.();
  };

  const itemClass =
    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white';

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/[0.07] hover:text-slate-200"
        aria-label="More options"
        title="More options"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Menu size={18} />
      </button>

      <AnimatePresence>
        {open && (
          <m.div
            ref={panelRef}
            role="menu"
            aria-label="More options"
            initial={{ opacity: 0, scale: 0.95, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -6 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className="absolute right-0 top-full z-50 mt-2 w-60 origin-top-right rounded-xl border border-white/[0.08] bg-void-900/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl"
          >
            {profile && (
              <div className="mb-1 flex items-center gap-3 border-b border-white/[0.06] px-3 py-2.5">
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 font-display text-xs font-black"
                  style={{ borderColor: accent, backgroundColor: `${accent}1a`, color: accent }}
                  aria-hidden
                >
                  {(profile.username?.[0] ?? '?').toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-white">{profile.username}</span>
                  <span className="block text-[11px] font-semibold" style={{ color: accent }}>
                    {rankLabel}
                  </span>
                </span>
              </div>
            )}

            <button role="menuitem" onClick={choose(onOpenAbout)} className={itemClass}>
              <Info size={15} className="shrink-0 text-slate-500" />
              About &amp; How It Works
            </button>
            <button role="menuitem" onClick={choose(onOpenFeedback)} className={itemClass}>
              <MessageSquare size={15} className="shrink-0 text-slate-500" />
              Feedback &amp; Support
            </button>
            <button role="menuitem" onClick={choose(onToggleSound)} className={itemClass}>
              {soundOn ? (
                <VolumeX size={15} className="shrink-0 text-slate-500" />
              ) : (
                <Volume2 size={15} className="shrink-0 text-slate-500" />
              )}
              {soundOn ? 'Mute sound effects' : 'Enable sound effects'}
            </button>

            <div className="my-1 border-t border-white/[0.06]" />

            <button role="menuitem" aria-haspopup="dialog" onClick={choose(onRequestSignOut)} className={itemClass}>
              <LogOut size={15} className="shrink-0 text-slate-500" />
              Sign out
            </button>
            {!isGuest && (
              <button
                role="menuitem"
                aria-haspopup="dialog"
                onClick={choose(onDeleteAccount)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-rose-300/90 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
              >
                <Trash2 size={15} className="shrink-0" />
                Delete account
              </button>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
