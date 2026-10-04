import { Loader2 } from 'lucide-react';

export function Spinner({ size = 20, className = '' }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} />;
}

/** Full-panel loading state with a subtle pulse. */
export function LoadingPanel({ label = 'Loading…', className = '' }) {
  return (
    <div className={`panel flex flex-col items-center justify-center gap-3 px-6 py-16 ${className}`}>
      <Spinner size={28} className="text-neon-cyan" />
      <p className="text-sm text-slate-500">{label}</p>
    </div>
  );
}

/** Inline skeleton block. */
export function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded-lg bg-white/[0.05] ${className}`} />;
}