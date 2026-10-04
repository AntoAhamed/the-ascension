import { useEffect, useState } from 'react';
import { msUntilUtcMidnight } from '../lib/tiers.js';

/**
 * Live countdown to the next UTC midnight — the moment the daily window resets.
 *
 * Ticks every second, and corrects itself against the wall clock so a throttled
 * background tab never shows a stale time.
 */
export function useCountdown() {
  const [msLeft, setMsLeft] = useState(() => msUntilUtcMidnight());

  useEffect(() => {
    const tick = () => setMsLeft(msUntilUtcMidnight());

    tick();
    const id = setInterval(tick, 1000);

    // Recompute when the tab becomes visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const seconds = Math.max(0, Math.floor(msLeft / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return { msLeft, hours, minutes, seconds: secs, isUrgent: msLeft > 0 && msLeft < 60 * 60 * 1000 };
}