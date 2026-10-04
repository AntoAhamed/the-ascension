import { useEffect } from 'react';
import { DEFAULT_TITLE, resolveTitle, resolveTitleState } from '../lib/documentTitle.js';

/**
 * Keeps document.title in sync with the player's state.
 *
 * The rules live in lib/documentTitle.js; this hook is only the effect that
 * applies them. Mount it once, near the root, and pass the same data the
 * dashboard already has.
 *
 * The title is restored to DEFAULT_TITLE on unmount rather than left as-is. A
 * signed-out user sitting on the auth screen would otherwise keep a tab claiming
 * their work is logged, which is both wrong and mildly alarming.
 *
 * @param {{hasSubmitted?: boolean, currentStreak?: number, authenticated?: boolean}} state
 */
export function useDocumentTitle({ hasSubmitted, currentStreak, authenticated = true } = {}) {
  const resolved = resolveTitleState({ hasSubmitted, currentStreak, authenticated });
  const title = resolveTitle({ hasSubmitted, currentStreak, authenticated });

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous === title ? DEFAULT_TITLE : previous;
    };
  }, [title]);

  return resolved;
}
