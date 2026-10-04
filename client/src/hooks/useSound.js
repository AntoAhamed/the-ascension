import { useCallback, useRef } from 'react';

/**
 * Tiny Web Audio synth for UI feedback — no asset files, no library.
 *
 * Three cues: a rising blip while the judge thinks, a bright arpeggio on
 * approval, and a soft descending pair on rejection.
 */
export function useSound({ enabled = true } = {}) {
  const ctxRef = useRef(null);

  const getCtx = useCallback(() => {
    if (!enabled) return null;
    if (!ctxRef.current) {
      const Ctx = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctx) return null;
      ctxRef.current = new Ctx();
    }
    // Browsers suspend the context until a user gesture.
    if (ctxRef.current.state === 'suspended') ctxRef.current.resume();
    return ctxRef.current;
  }, [enabled]);

  const tone = useCallback(
    ({ freq, start = 0, duration = 0.14, type = 'sine', gain = 0.05 }) => {
      const ctx = getCtx();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      const t0 = ctx.currentTime + start;

      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);

      // Short attack/decay envelope so it reads as a "blip", not a beep.
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

      osc.connect(amp).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    },
    [getCtx]
  );

  /** Rising two-note motif played while Gemini evaluates. */
  const playJudging = useCallback(() => {
    tone({ freq: 420, duration: 0.1, type: 'triangle', gain: 0.035 });
    tone({ freq: 620, start: 0.09, duration: 0.12, type: 'triangle', gain: 0.035 });
  }, [tone]);

  /** Bright major arpeggio for an approved submission. */
  const playApproved = useCallback(() => {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      tone({ freq, start: i * 0.075, duration: 0.2, type: 'sine', gain: 0.05 });
    });
  }, [tone]);

  /** Soft descending pair for a rejection. */
  const playRejected = useCallback(() => {
    tone({ freq: 330, duration: 0.16, type: 'sine', gain: 0.04 });
    tone({ freq: 247, start: 0.12, duration: 0.24, type: 'sine', gain: 0.04 });
  }, [tone]);

  /** Fanfare for a tier promotion. */
  const playTierUp = useCallback(() => {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((freq, i) => {
      tone({ freq, start: i * 0.085, duration: 0.32, type: 'triangle', gain: 0.055 });
    });
  }, [tone]);

  /** Subtle click for buttons and hovers. */
  const playTick = useCallback(() => {
    tone({ freq: 880, duration: 0.045, type: 'square', gain: 0.014 });
  }, [tone]);

  return { playJudging, playApproved, playRejected, playTierUp, playTick };
}