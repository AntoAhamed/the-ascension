import { useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import {
  BookOpen,
  CalendarCheck,
  CheckCircle2,
  Dumbbell,
  Flame,
  Gauge,
  Lightbulb,
  RotateCcw,
  Scale,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  XCircle,
} from 'lucide-react';
import { Panel, PanelHeader } from '../components/ui/Panel.jsx';
import {
  DECAY_PER_DAY,
  INVALID_PENALTY,
  STREAK_BONUS_CAP_DAY,
  difficultyMeta,
  streakBonusFor,
} from '../lib/tiers.js';

/* ------------------------------------------------------------------ */
/* Content                                                             */
/* ------------------------------------------------------------------ */

/**
 * Scoring cards.
 *
 * Point values are deliberately NOT written in this file — they are read from
 * DIFFICULTY_META at render time, so the Codex can never drift out of sync with
 * the scoring table the server actually applies.
 */
const SCORING_CARDS = [
  {
    key: 'Hard',
    icon: Flame,
    headline: 'High-impact deep work',
    blurb: 'Rare by design. Reserve it for a day that would genuinely surprise someone reading your history.',
    signals: [
      'Shipped a major feature or closed a genuinely hard bug',
      'Intense study block that produced real understanding',
      'Complex problem solving — architecture, research, difficult maths',
      'Heavy physical session: long run, serious lifting, hard conditioning',
    ],
  },
  {
    key: 'Average',
    icon: Gauge,
    headline: 'Standard productive habits',
    blurb: 'The bread and butter. Boring, repeatable, real — this is where consistency compounds.',
    signals: [
      'Steady, concrete progress on a project that matters',
      'Routine study, reading or practice you actually sat through',
      'Moderate workout with a clear, finished session',
      'Ordinary client, coursework or admin work genuinely completed',
    ],
  },
  {
    key: 'Easy',
    icon: Dumbbell,
    headline: 'Small but genuine wins',
    blurb: 'Minor tasks still count. They are not impressive, but they are not nothing.',
    signals: [
      'Light administrative tasks and small bug fixes',
      'Basic organisation, cleanup, filing and sorting',
      'Habit maintenance — you showed up and did the minimum well',
      'Short maintenance sessions you finished rather than started',
    ],
  },
];

/** Weak → strong rewrites. The left column is not rejected outright, it just scores badly. */
const COMPARISONS = [
  {
    weak: 'Did some coding.',
    strong: 'Implemented JWT authentication and added 5 unit tests for the auth routes.',
    lesson: 'Name the artifact and the effort.',
  },
  {
    weak: 'Worked out.',
    strong: 'Completed a 5km run in 28 minutes and did core stability exercises.',
    lesson: 'Duration and substance.',
  },
  {
    weak: 'Studied a bit.',
    strong:
      'Worked two hours through calculus problem sets and finally cracked chain-rule integration.',
    lesson: 'Say what you did, not that you showed up.',
  },
  {
    weak: 'Worked on my startup.',
    strong: 'Wrote and sent the proposal deck, then closed two follow-up client calls.',
    lesson: 'An outcome beats an intention.',
  },
  {
    weak: 'Debugging.',
    strong: 'Traced a memory leak in the WebSocket reconnect loop and shipped a regression test.',
    lesson: 'Show the hard part and the fix.',
  },
  {
    weak: 'Cleaned my room.',
    strong: 'Deep-cleaned the kitchen and reorganised the pantry shelves — 90 minutes, done.',
    lesson: 'Specific scope reads as real.',
  },
  {
    weak: 'Read some books.',
    strong: 'Finished two chapters of Designing Data-Intensive Applications and wrote 10 lines of notes.',
    lesson: 'Finished and captured beats started.',
  },
  {
    weak: 'Was busy today.',
    strong: 'Migrated 30 database queries to the new pagination API with zero regressions.',
    lesson: '“Busy” is not a task.',
  },
];

/** Rejected outright — passive, trivial, or unprovable. */
const ALWAYS_REJECTED = [
  'Scrolled tech Twitter for an hour.',
  'Thought about starting my business project.',
  'Watched a programming video without coding.',
  'I woke up.',
  'Ate lunch.',
  'Slept well.',
  'Was productive.',
  'Looked busy.',
  'Planned to be productive.',
  'Took a break. (Breaks are not submissions.)',
];

/** The four mechanics, in the order a new player needs them. */
const RULES = [
  {
    icon: CalendarCheck,
    accent: '#22d3ee',
    title: 'One valid slot per UTC day',
    body: 'You get exactly one accepted log per UTC day. The window reopens at 00:00 UTC, not at local midnight — submit before you go to sleep, not after you wake up.',
  },
  {
    icon: RotateCcw,
    accent: '#fb7185',
    title: `Invalid entries cost ${INVALID_PENALTY} points`,
    body: 'A non-productive entry is rejected and costs a flat penalty — but it does not use up your daily slot. You can retry immediately, so a mistake is a scratch, not a lost day. Your total floors at 0.',
  },
  {
    icon: Sparkles,
    accent: '#a78bfa',
    title: 'Streak multipliers',
    body: 'Every consecutive active day adds a bonus to your accepted entry, hard capped so it can never run away. The ladder below shows exactly what each day is worth.',
  },
  {
    icon: TrendingDown,
    accent: '#fbbf24',
    title: 'Decay is unforgiving',
    body: `Miss a full UTC day and ${DECAY_PER_DAY} points are deducted and your streak resets to zero. The penalty is applied automatically at rollover — it is not a warning, it is a bill.`,
  },
];

/** Ladder length: the cap day, plus one extra column to show the ceiling. */
const LADDER_DAYS = STREAK_BONUS_CAP_DAY + 1;

/** Difficulty picker for the worked example, cheapest first. */
const LADDER_TIERS = ['Easy', 'Average', 'Hard'];

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function Guidelines({ profile }) {
  const currentStreak = profile?.currentStreak ?? 0;

  // Default the worked example to the day the user is actually on, and to a
  // representative depth of work — so the first thing they see is their own
  // number, not a generic one.
  const [pickedDay, setPickedDay] = useState(() =>
    Math.min(Math.max(currentStreak, 1), LADDER_DAYS)
  );
  const [pickedExample, setPickedExample] = useState('Average');

  return (
    <div className="space-y-5">
      {/* ---------------------------------------------------------- */}
      {/* Intro                                                     */}
      {/* ---------------------------------------------------------- */}
      <Panel delay={0}>
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:p-6">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-neon-cyan/30 bg-neon-cyan/10">
            <BookOpen size={22} className="text-neon-cyan" />
          </span>
          <div>
            <h2 className="font-display text-xl font-black text-white sm:text-2xl">
              Task Codex
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
              The Judge reads one entry per day and decides how deep the work went. This page is
              the full rulebook: what earns points, what gets rejected, and what happens if you skip
              a day. The short version —{' '}
              <strong className="font-semibold text-slate-200">
                name a specific thing you finished, with enough detail to prove it.
              </strong>
            </p>
          </div>
        </div>
      </Panel>

      {/* ---------------------------------------------------------- */}
      {/* A. Point structure                                        */}
      {/* ---------------------------------------------------------- */}
      <Panel delay={0.05}>
        <PanelHeader
          title="Scoring Matrix"
          icon={Target}
          accent="#ffd166"
          subtitle="Base points by depth of work, decided by the Judge — plus the rejection penalty"
        />
        <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
          {SCORING_CARDS.map((card) => (
            <ScoringCard key={card.key} card={card} />
          ))}
          <InvalidCard />
        </div>
      </Panel>

      {/* ---------------------------------------------------------- */}
      {/* Streak ladder (interactive)                               */}
      {/* ---------------------------------------------------------- */}
      <StreakLadder
        currentStreak={currentStreak}
        pickedDay={pickedDay}
        onPickDay={setPickedDay}
        pickedExample={pickedExample}
        onPickExample={setPickedExample}
        delay={0.1}
      />

      {/* ---------------------------------------------------------- */}
      {/* B. Valid vs invalid examples                              */}
      {/* ---------------------------------------------------------- */}
      <Panel delay={0.15}>
        <PanelHeader
          title="Valid vs. Vague"
          icon={Scale}
          accent="#34d399"
          subtitle="Same activity, different write-up. The left column usually still scores — just poorly."
        />
        <div className="p-5">
          {/* Column labels, desktop only. */}
          <div className="mb-3 hidden grid-cols-2 gap-4 md:grid">
            <span className="chip w-fit border-rose-400/25 bg-rose-400/[0.07] text-rose-300">
              <XCircle size={12} strokeWidth={2.6} />
              Too vague
            </span>
            <span className="chip w-fit border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-300">
              <CheckCircle2 size={12} strokeWidth={2.6} />
              What actually scores
            </span>
          </div>

          <div className="space-y-3">
            {COMPARISONS.map((pair, i) => (
              <m.div
                key={pair.weak}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 + i * 0.04 }}
                className="grid gap-3 md:grid-cols-2 md:gap-4"
              >
                <div className="rounded-xl border border-rose-400/20 bg-rose-500/[0.05] px-4 py-3">
                  <div className="flex items-start gap-2">
                    <XCircle
                      size={14}
                      className="mt-0.5 shrink-0 text-rose-400/80 md:hidden"
                    />
                    <p className="text-sm italic leading-relaxed text-rose-100/70">“{pair.weak}”</p>
                  </div>
                </div>

                <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.05] px-4 py-3">
                  <div className="flex items-start gap-2">
                    <CheckCircle2
                      size={14}
                      className="mt-0.5 shrink-0 text-emerald-400 md:hidden"
                    />
                    <div>
                      <p className="text-sm leading-relaxed text-emerald-50">“{pair.strong}”</p>
                      <p className="mt-1.5 text-[11px] text-emerald-300/50">
                        {pair.lesson}
                      </p>
                    </div>
                  </div>
                </div>
              </m.div>
            ))}
          </div>
        </div>
      </Panel>

      {/* ---------------------------------------------------------- */}
      {/* Always-rejected list                                      */}
      {/* ---------------------------------------------------------- */}
      <Panel delay={0.2}>
        <PanelHeader
          title="Always Rejected"
          icon={XCircle}
          accent="#fb7185"
          subtitle={`No exceptions. Each attempt costs ${INVALID_PENALTY} points, and your day stays open.`}
        />
        <div className="flex flex-wrap gap-2 p-5">
          {ALWAYS_REJECTED.map((text) => (
            <span
              key={text}
              className="chip border-slate-500/25 bg-slate-500/[0.07] text-slate-400"
            >
              <XCircle size={11} strokeWidth={2.6} className="text-rose-400/70" />
              {text}
            </span>
          ))}
        </div>
      </Panel>

      {/* ---------------------------------------------------------- */}
      {/* C. Core rules                                             */}
      {/* ---------------------------------------------------------- */}
      <div>
        <h3 className="mb-3 px-1 font-display text-sm font-black uppercase tracking-widest text-slate-500">
          Core rules &amp; mechanics
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {RULES.map((rule, i) => (
            <RuleCard key={rule.title} rule={rule} index={i + 1} delay={0.05 + i * 0.05} />
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------- */}
      {/* How judging actually works                                 */}
      {/* ---------------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel delay={0.05}>
          <PanelHeader
            title="How the Judge decides"
            icon={ShieldCheck}
            accent="#a78bfa"
            subtitle="No vibes, no self-rating"
          />
          <ul className="space-y-3 p-5 text-sm leading-relaxed text-slate-400">
            {[
              'Your entry is read by Gemini, which labels it Easy, Average, Hard, or Invalid.',
              'The label is what earns points. The model never sets a number itself — the server maps label → points from the scoring table, so a jailbroken prompt cannot inflate your score.',
              'Invalid means one of four things: trivial, passive, vague, or spam.',
              'You get written feedback either way, including what to change to score higher.',
            ].map((line) => (
              <li key={line} className="flex gap-2.5">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-neon-violet" />
                {line}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel delay={0.1}>
          <PanelHeader
            title="How to write a winning entry"
            icon={Lightbulb}
            accent="#fbbf24"
            subtitle="Four things that raise your score"
          />
          <ul className="space-y-3 p-5 text-sm leading-relaxed text-slate-400">
            {[
              <>
                <strong className="font-semibold text-slate-200">Name the artifact.</strong> The
                feature, the chapter, the route, the lift. Not the category.
              </>,
              <>
                <strong className="font-semibold text-slate-200">Give a number.</strong> A
                distance, a count, a duration, a result. Numbers are the cheapest proof.
              </>,
              <>
                <strong className="font-semibold text-slate-200">Say what was hard.</strong> The
                obstacle you cleared is what separates Average from Hard.
              </>,
              <>
                <strong className="font-semibold text-slate-200">Write the finished tense.</strong>{' '}
                Present or past, done. Intentions and plans read as noise.
              </>,
            ].map((line, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-neon-amber" />
                {line}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/** One of the three approved scoring tiers. */
function ScoringCard({ card }) {
  const meta = difficultyMeta(card.key);
  const Icon = card.icon;

  return (
    <m.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col rounded-2xl border p-4"
      style={{ borderColor: `${meta.accent}30`, backgroundColor: `${meta.accent}0a` }}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border"
          style={{ borderColor: `${meta.accent}33`, backgroundColor: `${meta.accent}14` }}
        >
          <Icon size={17} style={{ color: meta.accent }} />
        </span>
        <span
          className="tabular font-display text-2xl font-black"
          style={{ color: meta.accent }}
        >
          +{meta.basePoints}
        </span>
      </div>

      <h4 className="mt-3 font-display text-sm font-black text-white">{card.headline}</h4>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{card.blurb}</p>

      <ul className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-3">
        {card.signals.map((signal) => (
          <li key={signal} className="flex gap-2 text-[11px] leading-relaxed text-slate-400">
            <CheckCircle2 size={12} className="mt-0.5 shrink-0" style={{ color: meta.accent }} />
            {signal}
          </li>
        ))}
      </ul>
    </m.div>
  );
}

/** The rejection card — different shape because it has a different consequence. */
function InvalidCard() {
  return (
    <m.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col rounded-2xl border border-rose-400/25 bg-rose-500/[0.06] p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-rose-400/30 bg-rose-400/10">
          <XCircle size={17} className="text-rose-400" />
        </span>
        <span className="tabular font-display text-2xl font-black text-rose-300">
          −{INVALID_PENALTY}
        </span>
      </div>

      <h4 className="mt-3 font-display text-sm font-black text-white">Invalid work</h4>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        Not deep enough to count, or not work at all. Costs a flat penalty and nothing else.
      </p>

      <ul className="mt-3 space-y-1.5 border-t border-rose-400/15 pt-3">
        {[
          'Trivial — “I woke up”, “ate food”',
          'Passive — scrolling, watching, browsing',
          'Vague — no artifact, no proof of effort',
          'Spam, or an intention instead of a result',
        ].map((signal) => (
          <li key={signal} className="flex gap-2 text-[11px] leading-relaxed text-slate-400">
            <XCircle size={12} className="mt-0.5 shrink-0 text-rose-400" />
            {signal}
          </li>
        ))}
      </ul>

      {/* The bit people miss: the day is still winnable. */}
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2">
        <RotateCcw size={13} className="mt-0.5 shrink-0 text-emerald-400" />
        <p className="text-[11px] leading-relaxed text-emerald-200/90">
          Your daily slot <strong className="font-semibold">stays open</strong>. Retry immediately.
        </p>
      </div>
    </m.div>
  );
}

/** Interactive streak-bonus ladder. */
function StreakLadder({
  currentStreak,
  pickedDay,
  onPickDay,
  pickedExample,
  onPickExample,
  delay,
}) {
  const bonus = streakBonusFor(pickedDay);
  const exampleMeta = difficultyMeta(pickedExample);
  const total = exampleMeta.basePoints + bonus;
  const cappedPicked = pickedDay >= STREAK_BONUS_CAP_DAY;

  return (
    <Panel delay={delay}>
      <PanelHeader
        title="Streak Bonus Ladder"
        icon={Flame}
        accent="#a78bfa"
        subtitle="Added to any accepted entry. +5 per consecutive day, capped at +50."
        right={
          <span className="tabular rounded-lg border border-neon-violet/25 bg-neon-violet/10 px-2.5 py-1 font-display text-sm font-black text-neon-violet">
            +{total} total
          </span>
        }
      />

      <div className="p-5">
        {/* Difficulty picker for the worked example. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            Work depth
          </span>
          {LADDER_TIERS.map((d) => {
            const meta = difficultyMeta(d);
            const isPicked = d === pickedExample;
            return (
              <button
                key={d}
                onClick={() => onPickExample(d)}
                className={`chip transition-colors ${
                  isPicked ? meta.chip : 'border-white/10 bg-white/[0.03] text-slate-500'
                }`}
                aria-pressed={isPicked}
              >
                {d}
                <span className="tabular opacity-70">+{meta.basePoints}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: LADDER_DAYS }, (_, i) => i + 1).map((day) => {
            const isPicked = day === pickedDay;
            const isYou = day === Math.min(Math.max(currentStreak, 1), LADDER_DAYS);
            const capped = day > STREAK_BONUS_CAP_DAY;

            return (
              <button
                key={day}
                onClick={() => onPickDay(day)}
                className={`relative flex w-[3.25rem] flex-col items-center gap-0.5 rounded-xl border px-1 py-2 transition-colors ${
                  isPicked
                    ? 'border-neon-violet/40 bg-neon-violet/10'
                    : 'border-white/[0.07] bg-void-900/50 hover:border-white/20'
                }`}
                aria-pressed={isPicked}
              >
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wide ${
                    isPicked ? 'text-neon-violet' : 'text-slate-500'
                  }`}
                >
                  Day
                </span>
                <span
                  className={`tabular font-display text-base font-black ${
                    isPicked ? 'text-white' : 'text-slate-300'
                  }`}
                >
                  {day}
                </span>
                <span
                  className={`tabular text-[10px] font-bold ${
                    capped ? 'text-slate-600' : isPicked ? 'text-neon-violet' : 'text-slate-500'
                  }`}
                >
                  +{streakBonusFor(day)}
                </span>

                {isYou && !isPicked && (
                  <span
                    className="absolute -top-1.5 rounded-full bg-neon-cyan px-1.5 py-px text-[8px] font-black uppercase tracking-wider text-void-950"
                    title="Your current streak"
                  >
                    You
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <AnimatePresence mode="wait">
          <m.p
            key={`${pickedDay}-${pickedExample}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="mt-4 text-sm leading-relaxed text-slate-400"
          >
            An accepted{' '}
            <strong className="font-semibold text-white">{pickedExample} day</strong> on{' '}
            <strong className="font-semibold text-white">
              day {pickedDay} of your streak
            </strong>{' '}
            pays{' '}
            <span className="tabular font-bold" style={{ color: exampleMeta.accent }}>
              +{exampleMeta.basePoints}
            </span>{' '}
            plus <span className="tabular font-bold text-neon-violet">+{bonus}</span> bonus ={' '}
            <span className="tabular font-bold text-white">+{total}</span> total.
            {cappedPicked &&
              ' You have hit the ceiling — the bonus stops growing, but the streak itself still protects you from decay.'}
          </m.p>
        </AnimatePresence>

        {currentStreak > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            You are on a{' '}
            <strong className="font-semibold text-neon-cyan">
              {currentStreak}-day streak
            </strong>{' '}
            — today&apos;s bonus would be{' '}
            <span className="tabular font-bold text-neon-violet">
              +{streakBonusFor(currentStreak)}
            </span>
            .
          </p>
        )}
      </div>
    </Panel>
  );
}

/** One numbered mechanic rule. */
function RuleCard({ rule, index, delay }) {
  const Icon = rule.icon;

  return (
    <m.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="rounded-2xl border border-white/[0.07] bg-void-850/70 p-5"
    >
      <div className="flex items-center gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border"
          style={{ borderColor: `${rule.accent}33`, backgroundColor: `${rule.accent}14` }}
        >
          <Icon size={17} style={{ color: rule.accent }} />
        </span>
        <span className="tabular font-display text-lg font-black text-slate-700">
          0{index}
        </span>
        <h4 className="font-display text-sm font-black text-white">{rule.title}</h4>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">{rule.body}</p>
    </m.div>
  );
}
