import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { Flame, Medal, Trophy, Users } from 'lucide-react';
import { Panel, PanelHeader } from './ui/Panel.jsx';
import { RankBadge } from './RankBadge.jsx';
import { Skeleton } from './ui/Spinner.jsx';
import { api } from '../lib/api.js';
import { accentForRank, formatNumber, formatPoints } from '../lib/tiers.js';

/**
 * Global leaderboard with All-Time / This-Month scopes.
 *
 * The podium (top 3) gets dedicated treatment because a visible #1 is the
 * strongest social motivator in the product; everyone else lists below. Every
 * row shows the player's rank name so a competitor's title is legible — the
 * question people actually ask is "how did they get there", and the rank is the
 * short answer.
 */
export function Leaderboard({ tierTable, selfId, delay = 0 }) {
  const [filter, setFilter] = useState('all_time');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  /**
   * Fetches the board for the active scope.
   *
   * Toggling All-Time / This-Month quickly fires overlapping requests, and both
   * scopes hit the database on different paths — the month scope joins
   * daily_logs, so it is materially slower. Without cancellation the *last
   * response to arrive* won rather than the last one requested, so a quick
   * double-tap could leave the "All-Time" pill highlighted above a board of
   * month-scoped rows. The abort signal plus the `active` flag make the most
   * recent request the only one allowed to write state.
   */
  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setLoading(true);
    (async () => {
      try {
        const payload = await api.leaderboard.get({
          filter,
          limit: 100,
          signal: controller.signal,
        });
        if (!active) return;
        setData(payload);
        setError(null);
      } catch (err) {
        if (!active || err?.name === 'AbortError') return;
        setError(err);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [filter]);

  const entries = data?.entries ?? [];
  const podium = entries.slice(0, 3);
  const rest = entries.slice(3);

  // Guest sessions are served a fabricated board. The subtitle is where a visitor
  // is already looking for their own standing, so that is where the disclosure
  // belongs — a footer note is the first thing nobody reads.
  const subtitle = data?.sample
    ? 'Sample board — not the live rankings'
    : data?.me?.rank
      ? `You are #${data.me.rank} of ${data.me.totalPlayers}`
      : 'Global rankings';

  return (
    <Panel className="overflow-hidden" delay={delay}>
      <PanelHeader
        title="Leaderboard"
        icon={Trophy}
        accent="#ffd166"
        subtitle={subtitle}
        right={
          <div className="flex rounded-lg border border-white/10 bg-void-900/60 p-0.5">
            {[
              ['all_time', 'All-Time'],
              ['month', 'This Month'],
            ].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`relative rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  filter === value ? 'text-void-950' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {filter === value && (
                  <m.span
                    layoutId="lb-filter-pill"
                    className="absolute inset-0 rounded-md bg-neon-cyan"
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  />
                )}
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>
        }
      />

      <div className="p-5">
        {error && (
          <p className="rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3 text-sm text-rose-200">
            Could not load the leaderboard: {error.message}
          </p>
        )}

        {loading && !data && (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Users size={28} className="text-slate-600" />
            <p className="text-sm text-slate-400">No entries yet for this period.</p>
            <p className="text-xs text-slate-600">
              {filter === 'month'
                ? 'Be the first to log points this month.'
                : 'Nobody has logged anything yet.'}
            </p>
          </div>
        )}

        {podium.length > 0 && (
          <div className="grid grid-cols-3 items-end gap-2 sm:gap-3">
            {/* 2nd, 1st, 3rd — the visual order that reads as a podium. */}
            {[podium[1], podium[0], podium[2]].map((entry, visualIndex) => {
              if (!entry) return <div key={visualIndex} />;
              const place = entry.rank;
              const isFirst = place === 1;
              return (
                <PodiumCard
                  key={entry.userId}
                  entry={entry}
                  tierTable={tierTable}
                  isFirst={isFirst}
                  accent={accentForRank(tierTable, { points: entry.points, tier: entry.tier })}
                />
              );
            })}
          </div>
        )}

        {rest.length > 0 && (
          <div className="mt-5 space-y-1.5">
            <AnimatePresence initial={false}>
              {rest.map((entry, i) => (
                <m.div
                  key={entry.userId}
                  layout
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.3 }}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                    entry.isSelf
                      ? 'border-neon-cyan/35 bg-neon-cyan/[0.07]'
                      : 'border-white/[0.05] bg-void-900/40 hover:bg-white/[0.03]'
                  }`}
                >
                  <span className="tabular w-7 shrink-0 text-center text-sm font-bold text-slate-500">
                    {entry.rank}
                  </span>
                  <RankAvatar entry={entry} tierTable={tierTable} />
                  <div className="min-w-0 flex-1">
                    {/* Rank name sits next to the username, colour-coded to the
                        rank's own accent — so a top player's title reads at a
                        glance instead of being grey text. */}
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-slate-200">
                        {entry.username}
                      </p>
                      {entry.isSelf && (
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-neon-cyan">
                          you
                        </span>
                      )}
                      <RankBadge
                        tier={entry.tier}
                        points={entry.points}
                        tierTable={tierTable}
                        size="sm"
                        className="ml-auto shrink-0"
                      />
                    </div>
                    {entry.currentStreak > 0 && (
                      <p className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-slate-500">
                        <Flame size={9} className="text-neon-amber" />
                        {entry.currentStreak} day streak
                      </p>
                    )}
                  </div>
                  <span className="tabular shrink-0 font-display text-base font-black text-white">
                    {formatPoints(entry.score)}
                  </span>
                </m.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </Panel>
  );
}

function PodiumCard({ entry, tierTable, isFirst, accent }) {
  return (
    <m.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 220, damping: 22, delay: isFirst ? 0.1 : 0.2 }}
      className={`relative overflow-hidden rounded-2xl border text-center ${
        isFirst ? 'order-2 border-neon-gold/40 pt-5' : 'order-1 border-white/[0.08] pt-3'
      } ${entry.isSelf ? 'ring-1 ring-neon-cyan/50' : ''}`}
      style={{
        background: isFirst
          ? 'linear-gradient(180deg, rgba(255,209,102,0.14), rgba(8,10,22,0.9) 70%)'
          : 'rgba(8,10,22,0.7)',
      }}
    >
      {isFirst && (
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-neon-gold to-transparent" />
      )}

      <div className="relative mx-auto w-fit">
        <RankAvatar entry={entry} tierTable={tierTable} size={isFirst ? 'lg' : 'md'} />
        <span
          className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border-2 border-void-900 font-display text-[10px] font-black text-void-950"
          style={{
            background: entry.rank === 1 ? '#ffd166' : entry.rank === 2 ? '#cbd5e1' : '#d97706',
          }}
        >
          {entry.rank}
        </span>
      </div>

      <p className="mt-3 truncate px-1 text-xs font-bold text-slate-200 sm:text-sm">
        {entry.username}
      </p>

      <div className="mt-1.5 flex justify-center px-1">
        <RankBadge
          tier={entry.tier}
          points={entry.points}
          tierTable={tierTable}
          size="sm"
        />
      </div>

      <p
        className={`tabular mt-1.5 font-display font-black leading-none ${
          isFirst ? 'text-2xl sm:text-3xl' : 'text-lg sm:text-xl'
        }`}
        style={{ color: isFirst ? '#ffd166' : accent }}
      >
        {formatNumber(entry.score)}
      </p>

      {entry.currentStreak > 0 && (
        <p className="mt-1 inline-flex items-center gap-0.5 pb-3 text-[10px] font-semibold text-neon-amber">
          <Flame size={10} />
          {entry.currentStreak} day streak
        </p>
      )}
    </m.div>
  );
}

function RankAvatar({ entry, tierTable, size = 'md' }) {
  const accent = accentForRank(tierTable, { points: entry.points, tier: entry.tier });
  const dim = size === 'lg' ? 'h-12 w-12 text-sm' : 'h-9 w-9 text-xs';

  if (entry.avatarUrl) {
    return (
      <img
        src={entry.avatarUrl}
        alt=""
        className={`${dim} shrink-0 rounded-full border-2 object-cover`}
        style={{ borderColor: accent }}
      />
    );
  }

  return (
    <div
      className={`${dim} grid shrink-0 place-items-center rounded-full border-2 font-display font-black`}
      style={{ borderColor: accent, backgroundColor: `${accent}1a`, color: accent }}
      aria-hidden
    >
      {(entry.username?.[0] ?? '?').toUpperCase()}
    </div>
  );
}