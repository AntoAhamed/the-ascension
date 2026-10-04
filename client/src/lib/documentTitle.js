/**
 * Derives the browser tab title from the player's current state.
 *
 * A productivity app is judged on whether you came back and did the work, so the
 * tab strip is the one piece of UI that is on screen the entire time. It is the
 * only place the app can speak while it is in the background, which makes it the
 * right home for "you still owe today something".
 *
 * The three states are ordered by how much they should pull the eye back. When
 * two apply, the more urgent one wins, because a tab title is a single slot:
 *
 *   1. Work logged today      — the day is done. Nothing to nag about.
 *   2. Streak at risk         — work is outstanding AND a streak of 2+ is live.
 *                               Losing a real run outweighs a routine reminder.
 *   3. Work pending           — outstanding, but nothing at stake yet.
 *
 * A streak of 1 is deliberately not treated as "at risk". One day is a start,
 * not a run, and nagging about it before the second day lands would be crying
 * wolf on day one of every streak.
 *
 * Kept free of React so the precedence can be tested directly, and so the same
 * rules could back a server-rendered title or a notification body later.
 */

/** The app's name, as it should appear after a status prefix. */
export const APP_NAME = 'The Ascension';

/** Shown before the profile has loaded, and on the signed-out screen. */
export const DEFAULT_TITLE = `${APP_NAME} | Gamified Productivity`;

/** No status to report yet, so the plain title stands. */
export const TITLE_STATE_DEFAULT = 'default';

/** A streak has to be at least this long before losing it counts as news. */
export const STREAK_AT_RISK_MIN = 2;

export const TITLE_STATES = {
  PENDING: 'pending',
  LOGGED: 'logged',
  STREAK: 'streak',
};

/**
 * Picks the tab state.
 *
 * @param {object} input
 * @param {boolean|null} input.hasSubmitted  whether today is already accepted.
 *   `null` means "not known yet", which is treated as pending so the title never
 *   claims a day is done before the server has said so.
 * @param {number} [input.currentStreak]
 * @param {boolean} [input.authenticated]
 * @returns {'pending'|'logged'|'streak'|'default'}
 */
export function resolveTitleState({ hasSubmitted, currentStreak = 0, authenticated = true } = {}) {
  if (!authenticated) return TITLE_STATE_DEFAULT;
  if (hasSubmitted) return TITLE_STATES.LOGGED;
  if (currentStreak >= STREAK_AT_RISK_MIN) return TITLE_STATES.STREAK;
  return TITLE_STATES.PENDING;
}

/**
 * The literal strings, in one place so the emoji and punctuation stay consistent
 * and can be asserted in tests.
 *
 * "(1)" mimics an unread count rather than a bullet, because a tab label is
 * scanned for a number the way an inbox is.
 */
const TITLES = {
  [TITLE_STATES.PENDING]: `(1) Today's Work Pending - ${APP_NAME}`,
  [TITLE_STATES.LOGGED]: `✓ Work Logged - ${APP_NAME}`,
  [TITLE_STATES.STREAK]: `🔥 Streak Active - ${APP_NAME}`,
};

export function titleFor(state) {
  return TITLES[state] ?? DEFAULT_TITLE;
}

/** Convenience: state and string in one call. */
export function resolveTitle(input) {
  return titleFor(resolveTitleState(input));
}
