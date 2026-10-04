import { Eye, UserPlus } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Height in px. The app header is sticky too, and it has to sit below this bar
 * rather than slide underneath it, so both components agree on this number.
 * Header.jsx offsets itself by the same value when isGuest is set.
 */
export const GUEST_BANNER_HEIGHT = 52;

/**
 * The guest-mode banner.
 *
 * Sticky, always visible, and deliberately plain: a visitor has to be able to
 * tell at every moment that what they are looking at is a preview that will not
 * be saved, and the leaderboard in particular shows other people's real standing
 * while their own numbers are invented. Burying that in a one-time modal is how
 * a demo ends up being mistaken for the product.
 */
export function GuestBanner() {
  const { exitGuest } = useAuth();

  return (
    <div
      className="sticky top-0 z-[60] border-b border-neon-amber/20 bg-neon-amber/[0.07] backdrop-blur-xl"
      style={{ height: GUEST_BANNER_HEIGHT }}
      role="status"
    >
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
        <p className="flex min-w-0 items-center gap-2 text-[11px] leading-tight text-neon-amber/90 sm:text-xs">
          <Eye size={14} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            <span className="font-semibold">Guest mode.</span>{' '}
            <span className="hidden sm:inline">
              You are exploring a preview — nothing here is saved, and your scores are not ranked.
            </span>
            <span className="sm:hidden">Preview only — nothing is saved.</span>
          </span>
        </p>

        <button
          onClick={() => exitGuest({ intent: 'signup' })}
          className="btn-primary flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-xs"
        >
          <UserPlus size={13} aria-hidden="true" />
          <span className="hidden sm:inline">Create account</span>
          <span className="sm:hidden">Sign up</span>
        </button>
      </div>
    </div>
  );
}