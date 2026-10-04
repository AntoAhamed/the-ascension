/**
 * Celebration effects.
 *
 * Difficulty drives the intensity: a Hard day earns a full cannon volley, a
 * rejected entry earns a muted "try again" shake instead of fireworks.
 *
 * canvas-confetti is loaded on first use, not at boot: nobody can celebrate
 * before they have submitted something, so the ~8 KB library has no business in
 * the initial bundle. The import is cached, so a streak of celebrations pays
 * the fetch once. If the chunk fails to load the submission still counts — a
 * party trick must never surface as an error, so failures are swallowed.
 */
let confettiPromise = null;
function loadConfetti() {
  confettiPromise ??= import('canvas-confetti')
    .then((module) => module.default)
    .catch(() => null);
  return confettiPromise;
}

const isReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const CYAN = ['#22d3ee', '#67e8f9', '#a78bfa', '#ffffff'];
const GOLD = ['#ffd166', '#fbbf24', '#fb7185', '#ffffff', '#22d3ee'];
const GREEN = ['#34d399', '#22d3ee', '#ffffff'];

async function fire(particles, opts) {
  if (isReducedMotion()) return;
  try {
    const confetti = await loadConfetti();
    confetti?.({ ...opts, colors: particles, disableForReducedMotion: true });
  } catch {
    // A party trick never becomes an error the user can see.
  }
}

/** Full celebration — used for Hard and Average approvals. */
export function celebrate(difficulty = 'Average') {
  const palette = difficulty === 'Hard' ? GOLD : difficulty === 'Average' ? CYAN : GREEN;

  if (isReducedMotion()) return;

  // Two angled cannons from the lower corners.
  fire(palette, {
    particleCount: 70,
    spread: 62,
    angle: 62,
    origin: { x: 0, y: 0.75 },
    scalar: 1.05,
    ticks: 220,
    zIndex: 9999,
  });
  fire(palette, {
    particleCount: 70,
    spread: 62,
    angle: 118,
    origin: { x: 1, y: 0.75 },
    scalar: 1.05,
    ticks: 220,
    zIndex: 9999,
  });

  if (difficulty === 'Hard') {
    // Extra centre burst for a top-tier day.
    setTimeout(
      () =>
        fire(GOLD, {
          particleCount: 120,
          spread: 360,
          origin: { x: 0.5, y: 0.45 },
          scalar: 1.35,
          ticks: 260,
          zIndex: 9999,
        }),
      180
    );
  }
}

/** A smaller, single-shot burst for milestones like a tier promotion. */
export async function celebrateTierUp() {
  if (isReducedMotion()) return;
  // Load once, before the loop starts: awaiting inside the frame callback would
  // stagger the first volley by however long the chunk takes to arrive.
  const confetti = await loadConfetti();
  if (!confetti) return;

  const end = Date.now() + 1200;
  const frame = () => {
    confetti({
      particleCount: 3,
      angle: 60,
      spread: 60,
      origin: { x: 0, y: 0.7 },
      colors: GOLD,
      zIndex: 9999,
      disableForReducedMotion: true,
    });
    confetti({
      particleCount: 3,
      angle: 120,
      spread: 60,
      origin: { x: 1, y: 0.7 },
      colors: GOLD,
      zIndex: 9999,
      disableForReducedMotion: true,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  };
  frame();
}

/** Streak milestone — fires once per crossing of 7 / 30 / 100 days. */
export function celebrateStreak(streak) {
  if (![7, 30, 60, 100, 365].includes(streak)) return;
  celebrate(streak >= 30 ? 'Hard' : 'Average');
}