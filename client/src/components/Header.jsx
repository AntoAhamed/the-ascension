import { useEffect, useState } from 'react';
import { m } from 'framer-motion';
import {
  BookOpen,
  ChevronRight,
  History,
  Info,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Trash2,
  Trophy,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { accentForRank, formatNumber, rankFor } from '../lib/tiers.js';
import { RankBadge } from './RankBadge.jsx';
import { HeaderMenu } from './HeaderMenu.jsx';
import { GUEST_BANNER_HEIGHT } from './GuestBanner.jsx';

/**
 * Sticky app header: brand, live points, section nav, and session controls.
 *
 * The rank pill is deliberately present on every tab and at every breakpoint —
 * the rank is the app's core motivation, so it must never be something a user
 * has to navigate to find. It doubles as the entry point to the full ladder.
 */
export function Header({
  activeTab,
  onTabChange,
  profile,
  tierTable,
  soundOn,
  onToggleSound,
  onOpenRanks,
  onOpenAbout,
  onOpenFeedback,
  onRequestSignOut,
  onDeleteAccount,
}) {
  // Note what is NOT destructured: `endSession`. This header opens the
  // confirmation dialog and nothing more. Ending a session is not a click on an
  // icon away — it wipes the browser's copy of the session and reloads the
  // document — so the header has no business doing it, and the only path to it
  // runs through a modal the user answered on purpose.
  const { isGuest } = useAuth();
  // Points first, stored label second: the pill reflects the live score, so a
  // rank-up never waits on the next refetch to recolour.
  const accent = accentForRank(tierTable, { points: profile?.points, tier: profile?.tier });
  const rankLabel = rankFor(tierTable, { points: profile?.points, tier: profile?.tier })?.label ?? '';

  return (
    // Both bars are sticky against the same scroll container, so the header has
    // to start below the guest banner. Offsetting by an inline style rather than
    // a `top-[52px]` class keeps the value tied to GUEST_BANNER_HEIGHT: Tailwind
    // only generates classes it can see as literals, so a computed class name
    // would silently produce no CSS.
    <header
      className="sticky top-0 z-50 border-b border-white/[0.06] bg-void-950/80 backdrop-blur-xl"
      style={isGuest ? { top: GUEST_BANNER_HEIGHT } : undefined}
    >
      {/* Mobile spacing is deliberately tighter (gap-2, px-3): the bar holds
          brand + tabs + rank + menu at every width, and the wider values would
          push the rank pill off the right edge of a 360px phone. */}
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-3 sm:gap-3 sm:px-6">
        {/* Brand */}
        <button
          onClick={() => onTabChange('dashboard')}
          className="group flex shrink-0 items-center gap-2.5"
          aria-label="Go to dashboard"
        >
          <span className="grid h-8 w-8 place-items-center rounded-xl border border-neon-cyan/30 bg-neon-cyan/10 transition-transform group-hover:scale-105 sm:h-9 sm:w-9">
            <Zap size={17} className="text-neon-cyan" />
          </span>
          <span className="hidden font-display text-sm font-black tracking-wider text-white sm:block">
            THE ASCENSION
          </span>
        </button>

        {/* Nav */}
        <nav className="ml-2 flex items-center gap-1 rounded-xl border border-white/[0.07] bg-void-900/50 p-1">
          {[
            { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
            { id: 'leaderboard', label: 'Ranks', icon: Trophy },
            { id: 'history', label: 'History', icon: History },
            { id: 'guidelines', label: 'Codex', icon: BookOpen },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => onTabChange(id)}
              className={`relative flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors sm:px-3 ${
                activeTab === id ? 'text-void-950' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {activeTab === id && (
                <m.span
                  layoutId="nav-pill"
                  className="absolute inset-0 rounded-lg bg-neon-cyan"
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                />
              )}
              <Icon size={13} className="relative" />
              <span className="relative hidden sm:inline">{label}</span>
            </button>
          ))}
        </nav>

        <div className="flex-1" />

        {/* Rank + live points pill. Always visible on every tab, and the way
            into the full ladder from anywhere in the app. */}
        {profile && (
          <m.button
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={onOpenRanks}
            className="flex shrink-0 items-center gap-2 rounded-xl border px-2 py-1.5 transition-colors hover:bg-white/[0.06] sm:px-3"
            style={{ borderColor: `${accent}33`, backgroundColor: `${accent}0f` }}
            title={`${rankLabel} · ${formatNumber(profile.points)} pts — view the full ladder`}
            aria-label="Open the rank ladder"
          >
            {/* Full badge from sm up; a bare trophy on the narrowest screens
                so the four-item nav still fits. */}
            <span className="hidden sm:block">
              <RankBadge
                tier={profile.tier}
                points={profile.points}
                tierTable={tierTable}
                size="sm"
              />
            </span>
            <span
              className="grid h-5 w-5 place-items-center rounded-full sm:hidden"
              style={{ backgroundColor: `${accent}22`, color: accent }}
              aria-hidden
            >
              <Trophy size={11} />
            </span>

            <span className="tabular font-display text-sm font-black" style={{ color: accent }}>
              {formatNumber(profile.points)}
            </span>
            <ChevronRight size={12} className="hidden text-slate-500 lg:block" />
          </m.button>
        )}

        {/* Full control row, sm and up. Below sm these live in HeaderMenu:
            roughly 190px of buttons that cannot fit a phone's width — their
            home on mobile is the overflow menu, not off the screen's edge. */}
        <div className="hidden items-center gap-3 sm:flex">
          <button
            onClick={onOpenAbout}
            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-white/[0.07] hover:text-slate-200"
            aria-label="About and How It Works"
            title="About & How It Works"
          >
            <Info size={16} />
          </button>

          <button
            onClick={onOpenFeedback}
            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-white/[0.07] hover:text-slate-200"
            aria-label="Feedback and Support"
            title="Feedback & Support"
          >
            <MessageSquare size={16} />
          </button>

          <button
            onClick={onToggleSound}
            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-white/[0.07] hover:text-slate-200"
            aria-label={soundOn ? 'Mute sound effects' : 'Enable sound effects'}
            title={soundOn ? 'Mute' : 'Unmute'}
          >
            {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>

          {profile && (
            <span
              className="hidden h-8 w-8 place-items-center rounded-full border-2 font-display text-xs font-black sm:grid"
              style={{
                borderColor: accent,
                backgroundColor: `${accent}1a`,
                color: accent,
              }}
              title={profile.username}
            >
              {(profile.username?.[0] ?? '?').toUpperCase()}
            </span>
          )}

          <button
            onClick={onRequestSignOut}
            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-white/[0.07] hover:text-slate-200"
            aria-label="Sign out"
            title="Sign out"
            aria-haspopup="dialog"
          >
            <LogOut size={16} />
          </button>
          {!isGuest && (
            <button
              onClick={onDeleteAccount}
              className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
              aria-label="Delete account"
              title="Delete account"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>

        {/* The mobile home for everything above. */}
        <div className="sm:hidden">
          <HeaderMenu
            profile={profile}
            tierTable={tierTable}
            soundOn={soundOn}
            onToggleSound={onToggleSound}
            onOpenAbout={onOpenAbout}
            onOpenFeedback={onOpenFeedback}
            onRequestSignOut={onRequestSignOut}
            onDeleteAccount={onDeleteAccount}
          />
        </div>
      </div>
    </header>
  );
}