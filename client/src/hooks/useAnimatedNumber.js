import { useEffect, useRef, useState } from 'react';

/**
 * Counts a number up to its new value with an ease-out curve.
 *
 * Used by the live point counter so a +100 award rolls forward instead of
 * snapping — the small dopamine hit that makes the reward feel earned.
 */
export function useAnimatedNumber(target, { duration = 900, enabled = true } = {}) {
  const [value, setValue] = useState(enabled ? target : 0);
  const fromRef = useRef(enabled ? target : 0);
  const frameRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setValue(target);
      fromRef.current = target;
      return;
    }

    const from = fromRef.current;
    const to = target;

    // No animation needed if the value barely moved (e.g. post-refresh sync).
    if (Math.abs(to - from) < 1) {
      setValue(to);
      fromRef.current = to;
      return;
    }

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (prefersReduced) {
      setValue(to);
      fromRef.current = to;
      return;
    }

    const start = performance.now();

    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutExpo — fast rise, gentle settle
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setValue(Math.round(from + (to - from) * eased));

      if (t < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = to;
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, duration, enabled]);

  return value;
}