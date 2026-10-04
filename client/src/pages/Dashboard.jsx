import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { m } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { Header } from '../components/Header.jsx';
import { TierCard } from '../components/TierCard.jsx';
import { StreakCard } from '../components/StreakCard.jsx';
import { DailyStatusCard } from '../components/DailyStatusCard.jsx';
import { SubmissionEngine } from '../components/SubmissionEngine.jsx';
import { Leaderboard } from '../components/Leaderboard.jsx';
import { HistoryFeed } from '../components/HistoryFeed.jsx';
import { LoadingPanel } from '../components/ui/Spinner.jsx';
import { EditableUsername } from '../components/EditableUsername.jsx';
import { DeleteAccountModal } from '../components/DeleteAccountModal.jsx';
import { SignOutModal } from '../components/SignOutModal.jsx';
import { AboutModal } from '../components/AboutModal.jsx';
import { FeedbackModal } from '../components/FeedbackModal.jsx';
import { PrivacyModal, TermsModal } from '../components/LegalModals.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { useGameData } from '../hooks/useGameData.js';
import { useSound } from '../hooks/useSound.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { api } from '../lib/api.js';
import { celebrate, celebrateStreak, celebrateTierUp } from '../lib/confetti.js';
import { accentForRank } from '../lib/tiers.js';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Deferred surfaces.
 *
 * This is a tabbed SPA, not a routed one, so there is no route table to split
 * on — and the dashboard itself must NOT be deferred, because it is what a
 * signed-in user came to see. What can be deferred is everything the dashboard
 * only reaches on request:
 *
 *   Guidelines           one of four tabs; ~60% of the source weight of the tab
 *   OnboardingModal      shown once, to a first-time user only
 *   RankRoadmapModal     seven animated rows behind a click
 *   TierPromotionOverlay shown once per tier-up
 *
 * Each becomes its own chunk fetched the first time it is actually needed, so a
 * returning user's first paint carries none of them. The Suspense fallbacks are
 * deliberately near-invisible (or absent): a user who has clicked "View all
 * ranks" already knows a panel is coming, and a skeleton flashing in place of a
 * modal reads as a glitch rather than as loading.
 */
const Guidelines = lazy(() =>
  import('./Guidelines.jsx').then((m) => ({ default: m.Guidelines }))
);
const OnboardingModal = lazy(() =>
  import('../components/OnboardingModal.jsx').then((m) => ({ default: m.OnboardingModal }))
);
const RankRoadmapModal = lazy(() =>
  import('../components/RankRoadmapModal.jsx').then((m) => ({ default: m.RankRoadmapModal }))
);
const TierPromotionOverlay = lazy(() =>
  import('../components/TierPromotionOverlay.jsx').then((m) => ({ default: m.TierPromotionOverlay }))
);

export function Dashboard({ tab, onTabChange }) {
  const { profile, tierProgress, tierTable, stats, todayStatus, decay, loading, error, refresh } =
    useGameData();
  const toast = useToast();
  const sound = useSound();
  // Both flows that end a session route through here, so there is exactly one
  // definition of what "ending a session" means and exactly one place it can be
  // got wrong. See endSession in AuthContext for why the storage purge and the
  // full-page reload are load-bearing rather than cosmetic.
  const { endSession } = useAuth();

  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('asc.sound') !== 'off');
  const [historyKey, setHistoryKey] = useState(0);
  const [todayLog, setTodayLog] = useState(null);
  const [revokedLog, setRevokedLog] = useState(null);
  // Bumped by a revoke so the effect above refetches even when hasSubmitted was
  // already false (revoking a replacement of a replacement, for instance).
  const [revokedNonce, setRevokedNonce] = useState(0);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [promotion, setPromotion] = useState(null);
  const [lastPoints, setLastPoints] = useState(null);
  const [showRanks, setShowRanks] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showSignOut, setShowSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const toggleSound = () => {
    setSoundOn((on) => {
      localStorage.setItem('asc.sound', on ? 'off' : 'on');
      return !on;
    });
  };

  // Fetch today's log so the locked state can show the verdict, plus any entry
  // taken back today so the form can disclose the replacement.
  useEffect(() => {
    if (!profile) return;
    api.submissions
      .today()
      .then((payload) => {
        setTodayLog(payload.log ?? null);
        setRevokedLog(payload.revokedLog ?? null);
      })
      .catch(() => {
        setTodayLog(null);
        setRevokedLog(null);
      });
  }, [profile, todayStatus?.hasSubmitted, revokedNonce]);

  // First run -> onboarding.
  useEffect(() => {
    if (profile && !profile.hasCompletedOnboarding) {
      setShowOnboarding(true);
      setShowAbout(true);
    }
  }, [profile]);

  // Reflect today's status in the browser tab. The tab strip is the only part of
  // the app that stays visible while it is in the background, so it is the one
  // place that can still say "you owe today something" after the user tabs away.
  useDocumentTitle({
    hasSubmitted: todayStatus?.hasSubmitted,
    currentStreak: profile?.currentStreak ?? 0,
  });

  // Surface decay the moment the dashboard loads.
  useEffect(() => {
    if (decay?.applied) {
      toast.error('You missed a day — 30 points deducted and your streak reset.', {
        title: 'Streak broken',
        duration: 7000,
      });
    }
  }, [decay]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmitted = useCallback(
    (payload) => {
      setHistoryKey((k) => k + 1);

      const accepted = Boolean(payload.accepted);
      const difficulty = payload.evaluation?.difficulty;

      if (accepted) {
        // Confetti, then extra flourishes for big days.
        setTimeout(() => {
          celebrate(difficulty);
          celebrateStreak(payload.profile?.currentStreak ?? 0);
        }, 120);

        const tierBefore = tierProgress?.current?.label;
        const tierAfter = payload.tierProgress?.current?.label;

        if (tierAfter && tierBefore && tierAfter !== tierBefore) {
          // Let the points counter animate first, then take over the screen.
          setTimeout(() => {
            celebrateTierUp();
            sound.playTierUp();
            setPromotion({
              from: tierBefore,
              to: tierAfter,
              accent: payload.tierProgress.current.accent,
              points: payload.pointsGained,
              pointsBefore: payload.pointsBefore,
            });
          }, 900);
        }

        toast.success(
          `+${payload.pointsGained} points` +
            (payload.streakBonus > 0 ? ` (incl. +${payload.streakBonus} streak bonus)` : ''),
          { title: `${difficulty} day approved` }
        );
      } else {
        // Rejected: the daily slot is untouched, so nudge them to try again now.
        const penalty = payload.penaltyPoints ?? 3;
        toast.error(`Invalid entry (−${penalty} pts). Submit actual productive work.`, {
          title: 'Entry rejected — try again',
          duration: 8000,
        });
      }

      // Resync so tier, streak, leaderboard and today's penalty tally all
      // reflect the new state.
      setTimeout(() => refresh({ silent: true }), 400);
    },
    [tierProgress, sound, toast, refresh]
  );

  /**
   * Today's accepted entry was taken back. Points went down and possibly the
   * streak with them, which is worth stating plainly, then the panel unlocks
   * back to the submission form.
   */
  const handleRevoked = useCallback(
    (payload) => {
      setTodayLog(null);
      setRevokedNonce((n) => n + 1);
      setHistoryKey((k) => k + 1);

      // A demotion is possible if the refund drops the user under a threshold.
      if (payload?.tierChanged) {
        sound.playRejected();
        toast.error(
          `You are now ${payload.tierAfter}. Submit a stronger entry today to climb back.`,
          { title: 'Rank changed', duration: 9000 }
        );
      }

      setTimeout(() => refresh({ silent: true }), 400);
    },
    [sound, toast, refresh]
  );

  if (loading && !profile) {
    return (
      <div className="min-h-screen">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
          <LoadingPanel label="Reading your progress…" className="h-64" />
        </div>
      </div>
    );
  }

  if (error && !profile) {
    return (
      <div className="grid min-h-screen place-items-center px-4">
        <div className="panel max-w-md p-8 text-center">
          <AlertTriangle size={30} className="mx-auto text-rose-400" />
          <h2 className="mt-4 font-display text-xl font-black text-white">Could not reach the API</h2>
          <p className="mt-2 text-sm text-slate-400">{error.message}</p>
          <button onClick={() => refresh()} className="btn-primary mt-6">
            Try again
          </button>
        </div>
      </div>
    );
  }

  const locked = Boolean(todayStatus?.hasSubmitted);
  const decayPending = !locked && (profile?.currentStreak ?? 0) === 0;

  return (
    <div className="min-h-screen">
      <Header
        activeTab={tab}
        onTabChange={onTabChange}
        profile={profile}
        tierTable={tierTable}
        soundOn={soundOn}
        onToggleSound={toggleSound}
        onOpenRanks={() => setShowRanks(true)}
        onOpenAbout={() => setShowAbout(true)}
        onOpenFeedback={() => setShowFeedback(true)}
        onRequestSignOut={() => setShowSignOut(true)}
        onDeleteAccount={() => setShowDelete(true)}
      />

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        {/* Greeting */}
        <m.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          {tab === 'guidelines' ? (
            <h1 className="font-display text-2xl font-black text-white sm:text-3xl">
              Task <span className="text-gradient">Codex</span>
            </h1>
          ) : (
            <EditableUsername
              username={profile?.username ?? 'ascendant'}
              onSave={async (name) => {
                await api.profile.update({ username: name });
                await refresh({ silent: true });
              }}
            />
          )}
          <p className="mt-1 text-sm text-slate-500">
            {tab === 'guidelines'
              ? 'What counts as productive work, how points are awarded, and what happens if you skip a day.'
              : locked
              ? "Today's work is on the record. Rest, then do it again tomorrow."
              : 'The clock is running. Log the one thing that actually mattered today.'}
          </p>
        </m.div>

        {tab === 'dashboard' && (
          <div className="space-y-5">
            {/* Stats row */}
            <div className="grid gap-5 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <TierCard
                  profile={profile}
                  tierProgress={tierProgress}
                  tierTable={tierTable}
                  onOpenRanks={() => setShowRanks(true)}
                />
              </div>
              <StreakCard
                streak={profile?.currentStreak ?? 0}
                decayPending={decayPending}
                delay={0.1}
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <SubmissionEngine
                  locked={locked}
                  todayLog={todayLog}
                  revokedLog={revokedLog}
                  tierProgress={tierProgress}
                  suggestedPoints={100}
                  penaltyToday={todayStatus?.penaltyToday ?? 0}
                  rejectedAttemptsToday={todayStatus?.rejectedAttemptsToday ?? 0}
                  soundOn={soundOn}
                  onSubmitted={handleSubmitted}
                  onRevoked={handleRevoked}
                  onOpenGuidelines={() => onTabChange('guidelines')}
                />
              </div>
              <DailyStatusCard
                todayStatus={todayStatus}
                todayLog={todayLog}
                revokedLog={revokedLog}
                delay={0.15}
              />
            </div>

            <Leaderboard tierTable={tierTable} selfId={profile?.id} delay={0.2} />

            <HistoryFeed refreshKey={historyKey} delay={0.1} />
          </div>
        )}

        {tab === 'leaderboard' && (
          <div className="space-y-5">
            <Leaderboard tierTable={tierTable} selfId={profile?.id} />
            <HistoryFeed refreshKey={historyKey} compact />
          </div>
        )}

        {tab === 'history' && (
          <div className="mx-auto max-w-3xl space-y-5">
            <HistoryFeed refreshKey={historyKey} />
          </div>
        )}

        {tab === 'guidelines' && (
          <div className="mx-auto max-w-4xl">
            {/* Only the tab body is replaced while the chunk loads, so the header,
                greeting and tab strip stay put and the page does not jump. */}
            <Suspense fallback={<LoadingPanel label="Loading the Codex…" className="h-96" />}>
              <Guidelines profile={profile} />
            </Suspense>
          </div>
        )}
      </main>

      <footer className="border-t border-white/[0.05] py-6">
        <p className="text-center text-[11px] text-slate-600">
          Scored by Gemini · Streaks decay at UTC midnight · One primary achievement per day ·{' '}
          <button
            onClick={() => onTabChange('guidelines')}
            className="underline decoration-slate-700 underline-offset-2 transition-colors hover:text-slate-400"
          >
            Rules
          </button>
        </p>
      </footer>

      {/* The three deferred overlays share one boundary and render nothing while
          loading: each is already gated on a flag the user just set, so an empty
          Suspense fallback is exactly the "not shown yet" state. It also means a
          chunk that is in flight cannot blank the dashboard behind it. */}
      <Suspense fallback={null}>
        <OnboardingModal
          open={showOnboarding}
          suggestedUsername={profile?.username ?? ''}
          onClose={() => setShowOnboarding(false)}
          onOpenGuidelines={() => onTabChange('guidelines')}
          onComplete={() => {
            setShowOnboarding(false);
            refresh({ silent: true });
          }}
        />

        <TierPromotionOverlay
          show={Boolean(promotion)}
          fromTier={promotion?.from}
          toTier={promotion?.to}
          accent={
            promotion?.accent ??
            accentForRank(tierTable, { points: profile?.points, tier: profile?.tier })
          }
          points={promotion?.points}
          pointsBefore={promotion?.pointsBefore}
          onDismiss={() => setPromotion(null)}
          // Dismiss first: the promotion sits at a higher z-index than the
          // roadmap, so opening it underneath would be invisible.
          onViewRanks={() => {
            setPromotion(null);
            setShowRanks(true);
          }}
        />

        {/* Reachable from the header pill, the tier card and the promotion
            overlay — the ladder is never more than one click away, on any tab. */}
        <RankRoadmapModal
          open={showRanks}
          onClose={() => setShowRanks(false)}
          profile={profile}
          tierProgress={tierProgress}
          tierTable={tierTable}
        />

        <AboutModal
          open={showAbout}
          onClose={() => setShowAbout(false)}
          onOpenGuidelines={() => {
            setShowAbout(false);
            onTabChange('guidelines');
          }}
        />

        <FeedbackModal
          open={showFeedback}
          onClose={() => setShowFeedback(false)}
          loading={feedbackLoading}
          onSubmit={async ({ feedbackType, message }) => {
            setFeedbackLoading(true);
            try {
              await api.feedback.submit(feedbackType, message);
              toast.success('Thank you! Your feedback has been submitted successfully.');
              setShowFeedback(false);
            } catch (err) {
              toast.error(err?.message || 'Failed to submit feedback');
            } finally {
              setFeedbackLoading(false);
            }
          }}
        />

        <PrivacyModal open={showPrivacy} onClose={() => setShowPrivacy(false)} />
        <TermsModal open={showTerms} onClose={() => setShowTerms(false)} />

        <DeleteAccountModal
          open={showDelete}
          onClose={() => setShowDelete(false)}
          username={profile?.username ?? ''}
          loading={deleting}
          onConfirm={async () => {
            setDeleting(true);
            try {
              // The request has to happen FIRST: it needs the access token that
              // endSession is about to destroy. Reversing these two lines
              // produces a 401 and leaves the account fully intact.
              await api.profile.delete();
            } catch (err) {
              toast.error(err?.message || 'Failed to delete account');
              setShowDelete(false);
              setDeleting(false);
              return;
            }

            // Deleted. Nothing below this point is user-visible — endSession
            // reloads the document — and none of it may throw, because there is
            // no longer an error screen to show it on. No success toast: it
            // would flash for one frame and be discarded by the navigation, and
            // the sign-in screen the user lands on is the confirmation.
            await endSession();
          }}
        />

        <SignOutModal
          open={showSignOut}
          onClose={() => setShowSignOut(false)}
          loading={signingOut}
          onConfirm={async () => {
            setSigningOut(true);
            try {
              await endSession();
            } catch (err) {
              // Nothing is lost on this path — no request to fail — so a throw
              // here would mean the redirect itself failed, which leaves the user
              // sitting on a half-cleared app. Say so instead of doing nothing.
              toast.error(err?.message || 'Could not sign out');
              setSigningOut(false);
            }
          }}
        />
      </Suspense>

      <footer className="mt-16 border-t border-white/[0.05] py-6">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 text-center text-xs text-slate-500 sm:flex-row sm:text-left">
          <span>© {new Date().getFullYear()} The Ascension</span>
          <div className="flex items-center gap-4">
            <button type="button" onClick={() => setShowPrivacy(true)} className="hover:text-slate-300">
              Privacy Policy
            </button>
            <span aria-hidden>•</span>
            <button type="button" onClick={() => setShowTerms(true)} className="hover:text-slate-300">
              Terms of Service
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}