import { memo, useCallback, useEffect, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { History, Lock, Target, TrendingUp, Undo2, XCircle } from 'lucide-react';
import { Panel, PanelHeader } from './ui/Panel.jsx';
import { Skeleton } from './ui/Spinner.jsx';
import { DifficultyBadge } from './DifficultyBadge.jsx';
import { api } from '../lib/api.js';
import { formatNumber, formatRelativeDay } from '../lib/tiers.js';

const PAGE = 20;

/** Current UTC day, matching the server's day boundary exactly. */
const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * History & analytics: a timeline of past logs with the judge's verdict, plus
 * lifetime aggregate stats.
 */
export function HistoryFeed({ refreshKey = 0, delay = 0.1, compact = false }) {
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState(null);

  /**
   * Fetches one page of logs.
   *
   * `at` is the offset to read from and is passed explicitly rather than closed
   * over. `setOffset` does not change `offset` until the next render, so a
   * `loadMore` that incremented state and then called a function reading the
   * captured `offset` re-read the page it had just displayed: "Load older"
   * duplicated the previous twenty rows instead of advancing. That also
   * inflated `logs.length` against `total`, so the button's remaining count and
   * its own visibility drifted further off with every page.
   */
  const load = useCallback(async ({ at = 0 } = {}) => {
    const isFirstPage = at === 0;
    isFirstPage ? setLoading(true) : setLoadingMore(true);
    try {
      const payload = await api.logs.list({ limit: PAGE, offset: at });
      setLogs((prev) => {
        if (isFirstPage) return payload.logs;
        // Ids are unique server-side, so this only ever drops a row a concurrent
        // reset already removed. Belt-and-braces against a duplicated page.
        const seen = new Set(prev.map((l) => l.id));
        return [...prev, ...payload.logs.filter((l) => !seen.has(l.id))];
      });
      setStats(payload.stats ?? null);
      setTotal(payload.total ?? payload.logs.length);
      setOffset(at + payload.logs.length);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    load({ at: 0 });
  }, [refreshKey, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = () => {
    // Guarded so a double-click cannot fire two overlapping pages and skip one.
    if (loadingMore) return;
    load({ at: offset });
  };

  /**
   * Stable across renders and keyed by id, which is what lets the memoised
   * LogRow below skip rows whose data and expansion state have not changed.
   */
  const toggleRow = useCallback((id) => setExpanded((cur) => (cur === id ? null : id)), []);

  if (loading && logs.length === 0) {
    return (
      <Panel className="overflow-hidden" delay={delay}>
        <PanelHeader title="History" icon={History} accent="#a78bfa" />
        <div className="space-y-2.5 p-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </Panel>
    );
  }

  return (
    <Panel className="overflow-hidden" delay={delay}>
      <PanelHeader
        title="History"
        icon={History}
        accent="#a78bfa"
        subtitle={total > 0 ? `${total} submission${total === 1 ? '' : 's'} on record` : 'Nothing logged yet'}
      />

      {/* Aggregate stats strip */}
      {stats && !compact && <StatsStrip stats={stats} />}

      <div className="p-5">
        {error && (
          <p className="rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3 text-sm text-rose-200">
            {error.message}
          </p>
        )}

        {!error && logs.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Target size={28} className="text-slate-600" />
            <p className="text-sm text-slate-400">Your timeline starts with today's submission.</p>
            <p className="max-w-xs text-xs text-slate-600">
              Log one real achievement a day and this becomes the record of how you actually
              spent your time.
            </p>
          </div>
        )}

        <div className="relative space-y-2.5">
          {/* Timeline spine */}
          {logs.length > 1 && (
            <div className="pointer-events-none absolute left-[13px] top-2 bottom-2 w-px bg-gradient-to-b from-neon-violet/40 via-white/10 to-transparent" />
          )}

          <AnimatePresence initial={false}>
            {logs.map((log, i) => (
              <LogRow
                key={log.id}
                log={log}
                index={i}
                isExpanded={expanded === log.id}
                onToggle={toggleRow}
              />
            ))}
          </AnimatePresence>
        </div>

        {logs.length < total && (
          <button onClick={loadMore} disabled={loadingMore} className="btn-ghost mt-4 w-full">
            {loadingMore ? 'Loading…' : `Load older entries (${total - logs.length} remaining)`}
          </button>
        )}
      </div>
    </Panel>
  );
}

function StatsStrip({ stats }) {
  const items = [
    { label: 'Total logs', value: stats.totalLogs, accent: '#22d3ee' },
    { label: 'Hard days', value: stats.hardCount, accent: '#fb7185' },
    { label: 'Best streak', value: stats.bestStreak, accent: '#fbbf24' },
    { label: 'This month', value: stats.monthPoints, accent: '#a78bfa', suffix: 'pts' },
    { label: 'Last 30 days', value: stats.last30Days, accent: '#34d399', suffix: 'pts' },
  ];

  return (
    <div className="grid grid-cols-2 gap-px border-b border-white/[0.06] bg-white/[0.04] sm:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="bg-void-850/90 px-4 py-3">
          <p
            className="tabular font-display text-lg font-black leading-none"
            style={{ color: item.accent }}
          >
            {formatNumber(item.value ?? 0)}
            {item.suffix && <span className="ml-0.5 text-[10px] font-bold opacity-60">{item.suffix}</span>}
          </p>
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {item.label}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * One timeline entry.
 *
 * Memoised, which only pays off because `onToggle` is a stable function that
 * takes the row id rather than a per-row arrow function. Passing
 * `() => toggle(log.id)` instead would hand every row a brand-new function
 * identity on every render, React's shallow prop comparison would always report
 * a change, and the memo would never once skip anything — which is the usual
 * way this optimisation ends up doing nothing while appearing to be done.
 *
 * Worth it here because the list grows with every page the user loads, up to a
 * few hundred rows, and each one is an animated node with several icon children.
 */
const LogRow = memo(function LogRow({ log, index, isExpanded, onToggle }) {
  // A past day is final: the revoke endpoint only ever accepts today's log, so
  // anything older than the current UTC day is permanently immutable. Today is
  // the only revocable day, so it gets no lock.
  const isPast = log.loggedDate < todayUtc();
  const revoked = Boolean(log.revokedAt);

  return (
    <m.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.3), duration: 0.3 }}
      className="relative pl-8"
    >
      {/* Node on the spine */}
      <span className="absolute left-[8px] top-3.5 grid h-[11px] w-[11px] place-items-center rounded-full border-2 border-void-850 bg-void-600">
        <span
          className="h-1 w-1 rounded-full"
          style={{
            // A revoked entry is not a rejection and not an achievement, so it
            // gets its own muted grey marker rather than borrowing rose or cyan.
            background: revoked ? '#64748b' : log.isCompleted === false ? '#fb7185' : '#22d3ee',
          }}
        />
      </span>

      <div
        className={`cursor-pointer rounded-xl border px-4 py-3 transition-colors ${
          isExpanded
            ? 'border-white/15 bg-white/[0.05]'
            : 'border-white/[0.05] bg-void-900/40 hover:bg-white/[0.025]'
        } ${revoked ? 'opacity-60' : ''}`}
        onClick={() => onToggle(log.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(log.id);
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                {formatRelativeDay(log.loggedDate)}
              </span>
              <DifficultyBadge
                difficulty={log.difficulty}
                size="sm"
                showPoints={false}
                animate={false}
              />
              {revoked ? (
                <span
                  className="chip border-slate-500/30 bg-slate-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400"
                  title="Removed and replaced — these points were returned and this entry no longer counts"
                >
                  <Undo2 size={9} />
                  Replaced
                </span>
              ) : isPast ? (
                <span
                  className="chip border-white/[0.07] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-600"
                  title="Past entries are permanent. Only the current UTC day can be removed."
                >
                  <Lock size={9} />
                  Locked
                </span>
              ) : null}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{log.taskDescription}</p>
          </div>

          <div className="shrink-0 text-right">
            <p
              className={`tabular font-display text-lg font-black leading-none ${
                revoked
                  ? 'text-slate-500 line-through decoration-slate-600'
                  : log.pointsAwarded > 0
                    ? 'text-neon-cyan'
                    : log.pointsAwarded < 0
                      ? 'text-rose-300'
                      : 'text-slate-600'
              }`}
            >
              {log.pointsAwarded > 0
                ? `+${log.pointsAwarded}`
                : log.pointsAwarded < 0
                  ? `−${Math.abs(log.pointsAwarded)}`
                  : '0'}
            </p>
            {revoked ? (
              <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                returned
              </p>
            ) : (
              log.streakBonus > 0 && (
                <p className="mt-0.5 text-[10px] font-semibold text-neon-amber">
                  +{log.streakBonus} streak
                </p>
              )
            )}
            {!revoked && log.isCompleted === false && (
              <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-400/80">
                rejected
              </p>
            )}
          </div>
        </div>

        {/* The judge's voice — the emotional core of the history feed. */}
        <AnimatePresence initial={false}>
          {isExpanded && (
            <m.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              {log.aiFeedback && (
                <p className="mt-3 border-l-2 border-neon-violet/40 pl-3 text-xs italic leading-relaxed text-slate-400">
                  {log.aiFeedback}
                </p>
              )}
              {log.reasoning && (
                <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
                  <span className="font-semibold uppercase tracking-wide">Judge: </span>
                  {log.reasoning}
                </p>
              )}
              {revoked ? (
                <>
                  <p className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500">
                    <Undo2 size={10} />
                    Removed on {formatRelativeDay(log.loggedDate)} and replaced with a stronger
                    entry. The {log.pointsAwarded} points were returned to your balance.
                  </p>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
                    This entry no longer counts toward your total, your rank, or your streak. It
                    remains visible as a record that it was submitted and then taken back.
                  </p>
                </>
              ) : (
                <>
                  {log.basePoints > 0 && (
                    <p className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500">
                      <TrendingUp size={10} />
                      {log.basePoints} base + {log.streakBonus} bonus
                    </p>
                  )}
                  {log.isCompleted === false && (
                    <p className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-rose-400/80">
                      <XCircle size={10} />
                      Rejected attempt (−{log.penaltyPoints ?? 3} pts) · the daily slot was not
                      consumed
                    </p>
                  )}
                  {isPast && log.isCompleted !== false && (
                    <p className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-slate-600">
                      <Lock size={10} />
                      Archived — only the current UTC day can be removed or replaced
                    </p>
                  )}
                </>
              )}
            </m.div>
          )}
        </AnimatePresence>

        {!isExpanded && log.aiFeedback && (
          <p className="mt-2 truncate text-[11px] italic text-slate-600">
            “{log.aiFeedback}”
          </p>
        )}
      </div>
    </m.div>
  );
});