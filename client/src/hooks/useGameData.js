import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Central game-data hook.
 *
 * Owns the profile, tier progress and daily status, and exposes a `refresh()`
 * so any component can trigger a resync after a mutation. This is the single
 * place that knows how to talk to the API for "who am I and where do I stand".
 * Gated on the resolved identity rather than on `canExplore`, because a signed-in
 * user and a guest are both reasons to load this data. Which source answers is
 * not this hook's concern: api.js decides that per call.
 */
export function useGameData() {
  const { user, canExplore } = useAuth();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  /**
   * Whose data this is, as a single comparable value.
   *
   * Deliberately not `canExplore`. That flag is true for a signed-in user AND
   * for a guest, so it never changes value when a visitor signs in: it only ever
   * flips false -> true -> false. An effect keyed on it therefore never re-ran
   * at sign-in, and the account that had just been authenticated went on
   * rendering the guest's sample points and sample history until the user
   * reloaded the page by hand.
   *
   * `user?.id` makes the guest -> account transition a genuine change, so the
   * effect below refetches and the real profile replaces the sample one. null
   * means "nobody to show data for", which is the state the auth screen is on.
   */
  const identity = canExplore ? user?.id ?? 'guest' : null;

  /** In-flight request, so a newer refresh can cancel an older one. */
  const abortRef = useRef(null);
  /** Monotonic request counter, so a slow response cannot overwrite a newer one. */
  const seqRef = useRef(0);

  const refresh = useCallback(
    async ({ silent = false } = {}) => {
      if (!identity) {
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);

      // Two refreshes can legitimately overlap: a submission lands and triggers
      // `refresh({silent:true})` on a 400ms timer while the midnight resync
      // fires in the same tick. Without cancelling, whichever response arrives
      // second wins regardless of which request is newer — so a stale profile
      // could overwrite a fresh one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++seqRef.current;

      try {
        const payload = await api.profile.get(controller.signal);
        // A newer request has already been issued; this answer is now history.
        if (seq !== seqRef.current) return;
        setData(payload);
        setError(null);
      } catch (err) {
        // An abort is this hook's own doing, not a failure to report.
        if (err?.name === 'AbortError' || seq !== seqRef.current) return;
        setError(err);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [identity]
  );

  useEffect(() => {
    if (!identity) {
      setLoading(false);
      return undefined;
    }
    refresh();
    // Abort on unmount and on identity change, so a response can never land
    // against a torn-down tree or against a different account's screen.
    return () => abortRef.current?.abort();
  }, [identity, refresh]);

  /**
   * Resyncs once when the UTC day rolls over.
   *
   * Decay is applied lazily on read, so a user who leaves the tab open across
   * midnight should see their streak corrected without reloading by hand.
   *
   * This used to be a one-second interval that recomputed the time remaining
   * and published it as `dayRollover`. That was wrong twice over. Nothing ever
   * read `dayRollover` — the resync it existed to trigger never happened — and
   * because the tick lived in this hook, every second re-rendered the entire
   * dashboard subtree (TierCard, SubmissionEngine, Leaderboard, HistoryFeed and
   * their animations) in order to publish a value nobody consumed. One timer
   * that actually fires does the job the interval was pretending to, for one
   * wake-up a day instead of 86,400.
   */
  useEffect(() => {
    if (!identity) return undefined;

    let timer;
    const schedule = () => {
      const now = new Date();
      const toMidnight =
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - Date.now();
      // +250ms so the timer cannot fire a hair before the date has actually
      // flipped on the server, which would resync against the previous day.
      // Clamped because setTimeout saturates above 2^31-1 ms.
      const delay = Math.min(Math.max(toMidnight, 0) + 250, 2_147_483_647);
      timer = setTimeout(() => {
        refresh({ silent: true });
        schedule();
      }, delay);
    };

    schedule();
    return () => clearTimeout(timer);
  }, [identity, refresh]);

  return {
    ...data,
    profile: data?.profile ?? null,
    tierProgress: data?.tierProgress ?? null,
    tierTable: data?.tierTable ?? [],
    stats: data?.stats ?? null,
    todayStatus: data?.todayStatus ?? null,
    decay: data?.decay ?? null,
    loading: loading || !identity,
    error,
    refresh,
  };
}