import { ChevronRight } from 'lucide-react';

/**
 * Small standalone trigger for the rank ladder.
 *
 * Deliberately its own module rather than an export of RankRoadmapModal.jsx.
 * TierCard — which is above the fold on every dashboard load — needs this
 * button, so importing it from the modal module would drag the whole ladder
 * (seven animated rows plus its modal shell) into the entry chunk and make the
 * roadmap impossible to lazy-load. Keeping the trigger separate means the button
 * costs a few hundred bytes and the roadmap stays a deferred chunk the user
 * fetches by asking for it.
 */
export function ViewRanksButton({ onClick, accent = '#22d3ee', className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-semibold text-slate-400 transition-all hover:border-white/20 hover:bg-white/[0.07] hover:text-white ${className}`}
      title="View the full rank ladder"
    >
      View all ranks
      <ChevronRight size={12} style={{ color: accent }} />
    </button>
  );
}