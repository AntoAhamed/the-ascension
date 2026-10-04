import { m } from 'framer-motion';
import { Ban, Dumbbell, Flame, Gauge } from 'lucide-react';
import { difficultyMeta } from '../lib/tiers.js';

const ICONS = {
  Hard: Flame,
  Average: Gauge,
  Easy: Dumbbell,
  Invalid: Ban,
};

/** Difficulty chip. Colour and base points come from the shared meta table. */
export function DifficultyBadge({ difficulty, size = 'md', showPoints = true, animate = true }) {
  const meta = difficultyMeta(difficulty);
  const Icon = ICONS[difficulty] ?? Gauge;

  const Wrapper = animate ? m.span : 'span';
  const motionProps = animate
    ? {
        initial: { scale: 0.75, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { type: 'spring', stiffness: 320, damping: 18 },
      }
    : {};

  return (
    <Wrapper
      {...motionProps}
      className={`chip ${meta.chip} ${size === 'sm' ? 'px-2 py-0.5 text-[10px]' : ''}`}
    >
      <Icon size={size === 'sm' ? 10 : 12} strokeWidth={2.6} />
      {meta.label}
      {showPoints && difficulty !== 'Invalid' && (
        <span className="opacity-70">· {meta.basePoints} base</span>
      )}
    </Wrapper>
  );
}