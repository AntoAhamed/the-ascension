# THE ASCENSION

A gamified productivity platform. You get **one shot per UTC day** to prove you did real
work. Gemini grades it, points land, streaks grow, tiers climb, and everyone else can see
where you rank.

```
┌─────────────┐   Supabase Auth    ┌──────────────┐   Gemini 2.5 Flash   ┌──────────────┐
│  React SPA  │ ──── JWT ────────► │  Express API │ ──── grading ──────► │  @google/genai│
│  (Vite, TW) │ ◄─── JSON ──────── │  port 4000   │                      └──────────────┘
└─────────────┘                    └──────┬───────┘
                                           │ service-role key (server only)
                                    ┌──────▼───────┐
                                    │  Supabase    │  Postgres + RLS + cron decay
                                    └──────────────┘
```

---

## Table of contents

1. [Requirements and quick start](#1-requirements-and-quick-start)
2. [Full setup with real credentials](#2-full-setup-with-real-credentials)
3. [How the game works](#3-how-the-game-works)
4. [Architecture decisions worth knowing](#4-architecture-decisions-worth-knowing)
5. [API reference](#5-api-reference)
6. [Deployment](#6-deployment)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Requirements and quick start

There is **no server-side demo mode and no seeded data in the database.** The server refuses to
start without real Supabase and Gemini credentials, and the client cannot build or sign anyone in
without real Supabase credentials. That is deliberate: an authenticated shell with no real user
behind it could not attach points, streaks, or a leaderboard row to anyone, so there is nothing
useful for a server-side mock to stand in for.

There *is* a **client-side guest preview** — see [Guest mode](#guest-mode-preview-only) — which
lets a visitor click through the whole UI with browser-local sample data and no account. It runs
entirely in the browser and the API has no knowledge of it.

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | 18.18+ (20+ recommended) | ESM, native `fetch`, `node:test`-era tooling |
| Supabase project | any current | Postgres + Auth + RLS |
| Gemini API key | any current | the judge; defaults to `gemini-2.5-flash` |

```bash
npm install

# Fill in real credentials — the build and the server both refuse placeholders.
cp client/.env.example client/.env
cp server/.env.example server/.env

# Run supabase/schema.sql in the Supabase SQL editor first.
# Then:
npm run dev
```

The two things that will stop you, both by design:

- **The server will not boot** until `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY` are real, and it prints every missing one
  at once with instructions.
- **The client will not build for production** until `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` are real. In development (`npm run dev`) it runs anyway and the
  sign-in screen names the missing variables.

---

## 2. Full setup with real credentials

### Step 1 — Create the Supabase project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and create a project.
2. Open **SQL Editor → New** and paste the entire contents of
   [`supabase/schema.sql`](./supabase/schema.sql). Run it.
   It is idempotent, so it is safe to re-run after edits.
3. Copy the keys from **Project Settings → API**:

   | Key                | Where it goes                |
   | ------------------ | ---------------------------- |
   | Project URL        | both `client/.env` and `server/.env` |
   | `anon` / publishable key | both `client/.env` and `server/.env` |
   | `service_role` key | **only** `server/.env`       |

> ⚠️ The `service_role` key bypasses row-level security. Never put it in `client/.env`,
> never commit it, never expose it to the browser.

### Step 2 — Get a Gemini API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and create a key.
2. This project uses `gemini-2.5-flash`. Change it with `GEMINI_MODEL` if you want to.

### Step 3 — Configure the environment

```bash
cp client/.env.example client/.env
cp server/.env.example server/.env
```

**`server/.env`**
```dotenv
# Every value here is mandatory. The server refuses to boot if one is missing,
# blank, or still the placeholder from .env.example.
SUPABASE_URL=https://<your-ref>.supabase.co
SUPABASE_ANON_KEY=<anon / publishable key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
GEMINI_API_KEY=<your gemini key>
GEMINI_MODEL=gemini-2.5-flash

PORT=4000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
CRON_SECRET=<a long random string>
```

Generate a real `CRON_SECRET` rather than typing one:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**`client/.env`**
```dotenv
# Both values are safe to expose — they are the public project URL and the
# anon/publishable key. Nothing else belongs in this file: everything here is
# compiled into the bundle and served to every visitor.
VITE_SUPABASE_URL=https://<your-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon / publishable key>
VITE_API_URL=http://localhost:4000
```

> ⚠️ `VITE_*` variables are **inlined into the JavaScript at build time**. Putting
> `SUPABASE_SERVICE_ROLE_KEY` or `GEMINI_API_KEY` in `client/.env` would publish both to
> every visitor. They belong in `server/.env` only. `client/.env` is gitignored.

### Step 4 — Enable email/password auth

**Authentication → Providers → Email** → enable *Email Provider*.
(Leave *Confirm email* on for production, off if you want instant sign-up.)

### Step 5 — Enable Google OAuth (optional)

**Authentication → Providers → Google** → enable it, paste the client id and secret.

Then add redirect URLs under **Authentication → URL Configuration → Redirect URLs**:
```
http://localhost:5173/            # development
https://your-domain.com/          # production
```

Note the trailing-slash root, **not** a `/auth/callback` path. The client is built
with `flowType: 'implicit'` and `detectSessionInUrl: true`, so supabase-js reads the
tokens out of the URL fragment during initialisation and the landing page does no
work. A dedicated callback path would only work on hosts configured to rewrite
unknown paths to `index.html`; on any other host it returns a 404 *after* the user
has already authenticated. The root exists everywhere, so no host-side rewrite is
needed.

If you see `Unsupported provider: provider is not enabled`, Supabase rejected the
request before Google was ever contacted. It is a project setting, not a code
problem: the provider is switched off. The app surfaces this as an explanatory
message rather than raw JSON.

### Step 6 — Run

```bash
npm run dev
```

The server validates its configuration at boot and refuses to start if anything is
missing, printing every problem at once with the exact variable to set.

---

## 3. How the game works

### Tiers

Thresholds live in the `tiers` Postgres table, **not** in application code. The API loads
them at boot and ships them to the client, so the UI can never disagree with the database.

| Rank | Points | Accent | Icon |
| --- | --- | --- | --- |
| Novice | 0 – 199 | slate | `Sprout` |
| Apprentice | 200 – 499 | emerald | `Wrench` |
| Practitioner | 500 – 999 | sky | `Compass` |
| Specialist | 1,000 – 1,999 | violet | `Target` |
| Architect | 2,000 – 3,999 | amber | `Building2` |
| Grandmaster | 4,000 – 6,999 | rose | `Flame` |
| Apex Luminary | 7,000+ | gold | `Crown` |

To retune a threshold, update the `tiers` table. Nothing else needs to change.

### The rank system is always on screen

The rank is the app's primary motivator, so it is never something a user has to go and
look for. Four surfaces carry it, all rendered through **one** component so a rank always
looks the same:

- **`RankBadge`** — the canonical badge (icon + label, coloured by the rank's accent). Used
  by the header pill, the tier card, every leaderboard row, the podium, the roadmap and the
  promotion overlay. Keyed by `tier.id`, with a neutral `Award` fallback so an unknown or
  custom tier still renders.
- **Header pill** — rank badge + live points, on **every tab** and at every breakpoint
  (bare trophy below `sm` so the four-item nav still fits). Clicking it opens the ladder.
- **`TierCard`** — the permanent dashboard anchor, above the fold. Carries the rank badge,
  a "View all ranks" trigger, an explicit `Current: Specialist (1,450 pts) ➔ Next rank:
  Architect (2,000 pts) · 550 to go` line, and the progress bar.
- **`RankRoadmapModal`** — "The Ranks of Ascension". All seven rungs with thresholds, a
  per-rank note, connector lines so it reads as a ladder, a **You** marker on the current
  rung, **Next up** on the following one, and "N to go" on every locked rung. Reachable from
  the header pill, the tier card, the promotion overlay and the footer.

`RankRoadmapModal` and `RankBadge` both read the `tierTable` the server ships, so the ladder
in the UI is literally the table the scoring engine uses.

### The "RANK UP!" moment

`TierPromotionOverlay` takes over the screen when a submission crosses a threshold:
radiating rays, three staggered shockwave rings, the new rank's own icon (not a generic
crown), the rank name at the largest size on the page, and the points that caused it
(`+105 · 1,895 → 2,000`). It is fired from `Dashboard.handleSubmitted` only when
`payload.tierProgress.current.label` differs from the pre-submission rank, 900 ms after the
submission lands so the points counter animates first.

**Note on the naming.** The user-facing copy says "rank"; the internal code says "tier"
(`tierProgress`, `tierTable`, `computeTierProgress`). The overlap is deliberate — `profile.tier`
is a database column and renaming it would be a schema change — but it is worth knowing
before you grep.

### Scoring

Gemini returns a difficulty tier; **points are derived from that tier by our code, never
read from the model's `pointsAwarded` field.** A hallucinated number cannot inflate a
leaderboard.

| Difficulty | Base | Typical example |
| --- | --- | --- |
| Hard | 100 | Shipped a major feature, solved a hard bug, a real milestone |
| Average | 70 | Study session, standard project progress, moderate workout |
| Easy | 50 | Minor productive habit, admin task, light cleanup |
| Invalid | **−3** | "I woke up", "watched Netflix", vague claims with no work |

### Rejected entries: −3 points, and the day stays open

This is the most important rule to understand, so it gets its own section.

If Gemini judges an entry **Invalid** (trivial, passive, spam, or a vague claim with no
actual work):

- **−3 points**, applied immediately, flooring at zero. A user on 1 point loses 1.
- **The daily slot is NOT consumed.** You can immediately resubmit and still earn today.
- **Your streak is untouched.** `current_streak` and `last_submission_date` are not
  modified, because the day is still winnable.
- The attempt *is* recorded in `daily_logs` with `is_completed = false`, so the history
  feed shows exactly how many rejections and how many points you have burned today.

| | Accepted (Hard / Average / Easy) | Rejected (Invalid) |
| --- | --- | --- |
| Points | base + streak bonus | −3 (floor 0) |
| Daily slot | consumed | **still open** |
| `current_streak` | advanced | untouched |
| `last_submission_date` | stamped to today | untouched |
| Log row | `is_completed = true` | `is_completed = false` |

Because the slot is only spent by a *completed* entry, the one-per-day rule is enforced by
a **partial unique index** on `(user_id, logged_date) WHERE is_completed`. That is what
makes unlimited same-day retries possible while still guaranteeing exactly one accepted
entry per UTC day.

Note that a day spent *only* on rejected attempts still decays at rollover, because
`last_submission_date` was never stamped. Rejections cost you 3 points immediately *and*
the 30-point decay later if you never land a real entry.

### The integrity affirmation

`IntegrityCallout` sits above the submission box with the pledge *"A Sacred Commitment to
Truth"*, and a required checkbox. **The submit button is disabled until it is ticked.**

Two deliberate decisions:

- **The flag is per-attempt, not per-day.** A `useEffect` clears it whenever the textarea is
  emptied, so a retry after a rejection must be affirmed again. One affirmation covers one
  submission — it is not a blank cheque for the rest of the day.
- **It is client-side only, and that is a known limitation.** The affirmation is not sent to
  the server and is not stored, so it is a commitment rather than an auditable record. Making
  it real would mean an `affirmed_at` column on `daily_logs` written inside
  `submit_daily_log()`. Deliberately not done here, because it is a schema change to
  `supabase/schema.sql` and that file has never been executed against a real Postgres.

Note that the check is **not** an anti-cheat. It cannot detect a false claim — only Gemini
can, and only by judging the entry on its merits. The checkbox is there to make the user stop
and think before committing.

### Streak bonus

`+5` per consecutive day, **capped at +50**. Day 1 → +5, day 10 → +50, day 11+ → +50.
A streak of 10 is where the bonus stops rewarding and starts punishing absence.

### Decay

Miss a full UTC day and you lose **30 points per missed day** and your streak resets to
zero. Points floor at zero. This is the entire retention mechanism: the cost of skipping
is always visible and always immediate.

### The daily window

One **accepted** achievement per UTC day. The UI counts down to UTC midnight, and "today"
is always computed server-side in UTC — never in the user's local timezone, so the rules
are identical for everyone.

### Replacing today's entry

Mistakes happen, and "I logged something thin at 09:00 and did much better at 21:00" should
not be punished for the next year. So **the current UTC day is the only editable one**:

- the locked panel offers a deliberately quiet **"Remove & submit higher work"** link;
- a confirmation modal states the exact cost before anything happens — the points that
  come off, broken out as `base + streak bonus`, plus a warning when the streak is at stake;
- the daily slot reopens and the standard input returns, integrity affirmation included.

**Previous days are permanently locked.** At 00:00 UTC the day's entry becomes archival and
the history feed marks it with a `Lock` chip. There is no back-dating, no edit, and no way to
revoke yesterday — the `logged_date = CURRENT_DATE` check inside the database function *is*
the lock.

Three details worth stating because they are deliberate:

- **A revoke is a refund, not a delete.** Points *and* the streak bonus come back off the
  balance, the streak is rebuilt from the surviving logs, and the rank is recalculated. It is
  floored at zero, so a profile that decayed below the awarded amount refunds less than the
  original award — `pointsRemoved` reports what the balance actually moved by.
- **Rejected attempts are never revocable.** Only `is_completed = true` rows are eligible.
  Erasing penalties would turn the retry loop into a free spam shield, so a −3 stays on the
  record forever.
- **The row survives, marked revoked.** `daily_logs.revoked_at` is set instead of deleting,
  which keeps the audit trail honest: the system can prove the entry was made and then taken
  back. The history feed shows it greyed out with a `Replaced` chip, and every aggregate
  excludes it — otherwise its positive `points_awarded` would be negated into a phantom
  penalty and still counted on the monthly board.

The whole operation is one transaction (`revoke_today_log`), so the same-day guard, the row
lock, the refund, the streak rebuild and the tier recompute either all happen or none do.
Two concurrent revokes cannot double-refund: the loser finds nothing left to revoke.

One consequence is worth knowing: if your previous entry was several days ago, revoking today
exposes you to the decay you had already accrued, because you now have no completed day in
that window. That is the rules working, not a bug, and the response reports it as
`streakBroken`.

### The Task Codex

Every rule above is also a page in the app. **Codex** in the nav bar opens
`client/src/pages/Guidelines.jsx`, which contains:

- the scoring matrix (Hard / Average / Easy / Invalid), with signal lists for each tier;
- an **interactive streak-bonus ladder** — pick a depth of work and a streak day, and it
  shows the arithmetic (`base + bonus = total`), with the user's current streak flagged;
- paired ❌/✅ write-up comparisons ("Did some coding." → "Implemented JWT authentication…");
- a chip list of always-rejected phrasings;
- the four core mechanics as numbered cards.

It is reachable from three places: the nav bar, a link directly under the submission box
("Not sure what counts? Check the Task Guidelines"), and the first-run onboarding modal.

**No numbers are hardcoded in the page.** Points, penalties, decay and the bonus cap are all
imported from `client/src/lib/tiers.js` (`DIFFICULTY_META`, `INVALID_PENALTY`,
`DECAY_PER_DAY`, `streakBonusFor`, `STREAK_BONUS_CAP_DAY`), which mirror the server's
`server/src/lib/tiers.js` and the `v_*` locals in `submit_daily_log()`. Change the scoring
table and the Codex follows.

### The tab title tells you where you stand

The browser tab is the only part of the app that stays on screen while it is in the
background, so it carries the one piece of information that is useful when you are not
looking at the app: whether today is still owed.

| State | Title |
| --- | --- |
| Work logged today | `✓ Work Logged - The Ascension` |
| Outstanding, streak of 2+ live | `🔥 Streak Active - The Ascension` |
| Outstanding, nothing at stake | `(1) Today's Work Pending - The Ascension` |
| Signed out, or still loading | `The Ascension \| Gamified Productivity` |

Three decisions are baked in:

- **Logged beats streak.** Once the day is accepted there is nothing at stake, so a "streak
  active" title would be crying wolf.
- **A streak of 1 is not "at risk".** One day is a start, not a run. Nagging before the second
  day lands would mean every new streak opens with a false alarm.
- **`hasSubmitted` is never assumed.** Before the profile resolves it is `null`, which is
  treated as pending — the title must never claim a day is done before the server has said so.

The precedence lives in `client/src/lib/documentTitle.js` as pure functions
(`resolveTitleState`, `titleFor`) with no React in them, so the rules are testable on their own;
`client/src/hooks/useDocumentTitle.js` is only the effect that applies them. It is mounted in
two places: `Dashboard` with the live status, and `App` with `authenticated: false` so the
signed-out screen does not inherit a title claiming work is logged.

### The favicon and brand mark

`client/public/` holds a **rising flame** on a dark rounded badge: violet at the base through
cyan to gold at the tip, brightening upward so the mark itself reads as ascension. A flame
rather than a trophy or shield because it survives being shrunk to 16px, and because it ties
together the three things the product is about — streaks, the rank ladder, and heat while you
work. The silhouette is deliberately asymmetric (leaning tip, a notch on the right flank);
fire is recognised by exactly those two features, and a symmetrical teardrop has neither.

**Every file in `public/` is generated.** Edit `client/scripts/render-icons.mjs`, not the
output:

```bash
npm run icons --workspace client       # regenerate the SVGs and PNGs
npm run verify --workspace client      # icon geometry + title rules + rank assignment
npm run test:tiers:live --workspace client   # assert live API ranks against their own points
```

The SVG and the PNG rasters are emitted from **one set of cubic bezier control points**, so
they cannot drift apart. There is no `sharp` or `resvg` dependency: the mark is defined as
plain maths, scan-converted at 4×4 supersampling, and deflated with the `zlib` that ships
inside Node. The PNG encoder is ~40 lines at the bottom of the script.

The rasters exist because SVG cannot cover everything: iOS home-screen icons read
`apple-touch-icon`, which must be a PNG, and the smallest sizes in the tab strip are served
best as a raster.

| File | Purpose |
| --- | --- |
| `favicon.svg` | Primary. Listed **first** among the `rel="icon"` links, which is what every major engine honours. |
| `favicon-{16,32,64}.png` | Fallback for browsers without SVG favicon support. |
| `apple-touch-icon.png` | 180×180. iOS ignores every `rel="icon"`. |
| `favicon-mask.svg` | Pinned-tab silhouette. A **separate** file: Chromium recolours a `mask-icon` by its alpha channel alone, so `favicon.svg` would flatten into a solid block with the flame lost inside it. |
| `maskable.svg`, `maskable-icon-512.png` | Wider safe zone (27% inset vs 17%) and a square background, so an Android circular or squircle mask cannot clip the flame's tip and base. |
| `icon-192.png`, `icon-512.png` | PWA sources. Not linked as icons — that is what a web manifest is for, and declaring one would opt into install prompts and a service-worker lifecycle. |

Verification is pixel-level rather than by eye, because nothing in this repo can open an image
viewer. `verify-svg-parity.mjs` parses the path data back out of the generated SVG and asserts
the outlines agree with the raster, the gradient runs the right way, and every icon referenced
from `index.html` actually exists. `probe-assets.mjs` decodes each PNG to check it is
structurally valid, that the maskable variant clears the 80% safe zone, and that the 16px
raster still reads as a flame (it must keep 15–75% of the badge lit — too few and the tab is a
dark blob, too many and the flame has swollen into the badge).

---

## 4. Architecture decisions worth knowing

### The database owns all point arithmetic

`submit_daily_log()` runs decay, the completed-slot check, streak calculation, the bonus,
the insert and the tier update **inside one transaction**, branching on the judge's verdict.
That makes double-awarding structurally impossible rather than merely unlikely.

It is also `SECURITY DEFINER` and revoked from `public`, so a rejected attempt cannot be
skipped by a client that simply declines to call it.

`revoke_today_log()` follows the same rule: the same-day guard, the row lock, the refund,
the streak rebuild and the tier recompute are one transaction, so a revoke cannot half-apply.
Because the guard is `logged_date = CURRENT_DATE` in UTC rather than a client-supplied date,
**the client cannot ask to revoke a different day** — it does not get to say which row.

### The streak is recomputed, never decremented

Revoking cannot safely do `current_streak := current_streak - 1`. It does not know what the
streak was before today's entry, or whether today's entry was the one that started the run.
So `recompute_streak()` rebuilds it from the surviving accepted logs using the same
gaps-and-islands technique as `bestStreak`.

The subtle rule: a run ending more than one day before today is reported as **0**, not as its
length. The individual days are still there, but a gap already killed the streak, and a
recompute that resurrected it would contradict `apply_decay()` and `submit_daily_log()`. It
also keeps `last_submission_date` pointing at the real last accepted day, so decay still
computes the correct number of missed days afterwards.

### A revoked row is kept, and every aggregate knows it

`revoked_at timestamptz` rather than a `DELETE`. The three states are then unambiguous:

| `is_completed` | `revoked_at` | Meaning |
| --- | --- | --- |
| `true` | `null` | Accepted — counts toward points, rank, streak |
| `false` | `null` | Rejected — costs the penalty, slot untouched |
| `false` | set | Revoked — counts toward nothing, kept as evidence |

Flipping `is_completed` to `false` is what frees the daily slot: the row drops out of the
partial unique index, so no index surgery is needed.

Every aggregate then filters `revoked_at IS NULL`. This is not defensive decoration — it is
load-bearing. A revoked row also has `is_completed = false` **and a positive
`points_awarded`**, so any query that reasons "not completed ⇒ penalty, negate the points"
turns it into a phantom negative penalty, and any monthly sum double-counts the award the
user was already refunded.

### Two triggers for decay, not one

A nightly `node-cron` job settles everyone at UTC rollover, **and** `apply_decay()` runs
lazily on every profile read.

The cron alone is not enough. If the server restarts, crashes, or the machine is asleep at
midnight, everyone keeps stale streaks and inflated leaderboards. The lazy read is the real
safety net: the first thing a user sees after a gap is already-correct data.

Both paths also recompute `current_tier`, not just `points`. Decay can drop someone from
7,000 to 6,400, and leaving the label alone would show "Apex Luminary" to a user who no
longer qualifies — visible on the leaderboard, not just their own dashboard.

### The daily window is UTC, and only UTC

Every date in this application is a UTC calendar date, and the day boundary is midnight UTC —
not the server's local midnight, not the user's. A player in Auckland and a player in Los
Angeles get the same 24-hour window, and the leaderboard cannot be shifted by changing a
machine's clock.

In practice that means:

- `submit_daily_log()`, `apply_decay()`, `revoke_today_log()` and `recompute_streak()` all
  derive "today" from the same expression, `(now() at time zone 'utc')::date`. Never
  `current_date` and never `now()::date` — both resolve in the *session* time zone, which is
  UTC on Supabase today but is not guaranteed to stay UTC.
- `daily_logs.logged_date` is a `date`, not a `timestamptz`. A timestamp there would make a
  day depend on how the row is read back.
- `created_at`, `updated_at` and `revoked_at` stay `timestamptz` for the audit trail, and are
  only ever compared as instants.

### Why functions take `p_user_id` instead of reading `auth.uid()`

These functions run with the **service-role** key. PostgREST sees no user claim for that
role, so `auth.uid()` would return `NULL` and every function would silently no-op.

Safety does not come from `auth.uid()`. It comes from `REVOKE ... FROM public` plus a
`GRANT` to `service_role` only — so only the API can call these, and the API validates the
caller's JWT before it ever gets there.

### Auth is split, deliberately

| Concern | Handled by | Why |
| --- | --- | --- |
| Sign-up, sign-in, Google OAuth, session | `supabase-js` in the browser | Supabase Auth already does this well, including token refresh and Google callbacks |
| Every database read and write | Express + service role | Points must never be client-writable, and RLS alone cannot host this logic |
| AI grading | Express only | The Gemini API key must never reach the browser |

The split is the security boundary, and it is enforced rather than documented:

- **The service-role key exists only in `server/src/config/env.js`.** It is never logged, never
  serialised into a response, and never read by anything under `client/`. The client's build
  inlines only the two `VITE_SUPABASE_*` values, both of which are public by design.
- **The browser's identity is a Supabase JWT**, verified server-side on every request. The user
  id comes from `auth.getUser()` and from nowhere else — a header, query parameter, or body
  value claiming to be a user is ignored, because there is no code path that reads one.
- **Row-level security is on as defense-in-depth.** If a client key ever leaks, `profiles` is
  world-readable (the leaderboard is public) but **nothing is writable**, and `daily_logs` is
  readable only by its owner. The `SECURITY DEFINER` functions that do the writing are revoked
  from `anon` and `authenticated`.

A missing credential stops the boot rather than surfacing as a runtime error: a server that
starts and then fails per-request is far harder to diagnose than one that refuses to start.

### Guest mode (preview only)

A visitor who has not signed in can click **Explore as guest** on the auth screen and use the whole
app — dashboard, submissions, leaderboard, stats, history — with no account.

**The server has no guest mode.** There is no demo route, no seeded user, no auth bypass, and no
`MOCK_MODE`. A guest request never reaches the API at all: `client/src/lib/api.js` checks the flag
before it builds a URL, so a guest call returns browser-local data and never opens a socket. That
is the whole safety argument, and it is asserted rather than promised — `test:guest` swaps
`globalThis.fetch` for a trap, exercises every guest method, and fails if the trap fires.

| Concern | In guest mode | Why |
| --- | --- | --- |
| Writes to `profiles` / `daily_logs` | impossible | there is no network call to make them |
| Leaderboard | fabricated, labelled `sample: true`, guest gets `rank: null` | a guest is not on a real board and is not shown a position on one |
| The Gemini judge | a keyword heuristic, `simulated: true`, disclosed in its own feedback text | a guest has no account to authenticate with, so there is no request the server would accept |
| Decay | never applied | there is no calendar to fall behind on |

**Where the branch lives.** Exactly one place: `asGuest()` in `client/src/lib/api.js`. Components
call `api.profile.get()` and never learn which source answered. That keeps the real path one
readable call per endpoint, and it keeps `isGuest` out of the components entirely.

**Where the numbers come from.** Guest points, streak, best streak and stats are *derived* from
the sample log history by `deriveProfileState()` in `guestSession.js`, and every rank goes through
the same `tierForPoints()` lookup the real API uses. Hand-writing plausible-looking figures would
let the sample profile contradict itself — the "everybody shows Novice" class of bug is invisible
until a visitor notices it.

Two rules the guest derivation copies from the database rather than approximating, because getting
either wrong is how a preview starts lying about the product:

- **Decay is measured from the newest entry, not across the history.** The database charges 30
  points per fully missed day and settles lazily, so submitting yesterday costs nothing regardless
  of how many gaps are further back. Counting historical gaps would re-charge every past gap on
  every load — the same compounding bug `reconcile_all_streaks()` used to have.
- **A revoked entry contributes nothing** — not points, not streak length, not a penalty.

**Leaving guest mode.** A real Supabase session clears guest state before it renders, so sample
points can never briefly appear in a real account's history. The banner's call to action returns to
the auth screen already switched to the sign-up form.

### Whose data is this? Identity, not `canExplore`

`useGameData` refetches whenever the *identity* changes, and identity is
`user?.id ?? 'guest'` — never `canExplore`.

`canExplore` is `Boolean(user) || isGuest`, so it is true for a guest **and** for a
signed-in user. It only ever flips `false → true → false`; it never changes value at the
moment a visitor signs in. An effect keyed on it therefore did not re-run when it mattered
most, and the account that had just been authenticated went on rendering the guest's sample
points and sample history until the user reloaded by hand. That is the exact failure the
`isGuest` flag was designed to make impossible elsewhere in the app, so it is worth stating
as a rule: **anything deciding *whose* data to show must compare identities, and anything
deciding *whether* to show data at all may use the boolean.**

The same hook refetches exactly once per identity. It aborts the previous request before
starting a new one, and every response is discarded unless it belongs to the most recent
request, so an overlapping pair — a submission landing on a 400 ms timer while the midnight
resync fires — can never let the slower, older answer win.

**UTC midnight is a timer, not a poll.** Decay is applied lazily on read, so a user who
leaves the tab open across midnight should see their streak corrected. That is done with a
single `setTimeout` aimed at the next UTC midnight, re-armed after it fires. It used to be a
one-second interval publishing a `dayRollover` flag — which nothing read, so the resync never
happened, and because the tick lived above the dashboard it re-rendered the entire subtree
once a second for the whole session to publish a value nobody consumed.

### Tier thresholds are data, not code

`get_tier_table()` is read at boot into an in-memory table on the server, then returned
alongside every profile payload. A fallback table ships in the code so the app still boots
if the RPC fails — but the database always wins when it answers.

### A rank is derived from points, never read from a label

`profiles.current_tier` is a denormalised cache. Three places could drift it — the label
being stale is exactly the "everyone shows Novice" symptom, and it is silent, because the
app renders perfectly and is simply wrong.

So the score is treated as the fact and the label as a cache of it, at every layer:

- **The database enforces it.** A `before insert or update of points` trigger on
  `profiles` overwrites `current_tier` with `tier_for_points(new.points)`. Whatever a
  caller writes, the row cannot end up disagreeing with its own score. This makes the
  hand-written recomputes in `submit_daily_log()`, `apply_decay()`, `revoke_today_log()`
  and `reconcile_all_streaks()` redundant rather than wrong — and it also covers the
  writers nobody remembered: a seed script, a manual fix, a future migration.
- **The API re-derives it.** No route returns `current_tier` from the row. They call
  `getTierForPoints(points).label` — `/api/profile`, `/api/leaderboard`, the submission
  response, and the revoke response's before/after pair. A stale column therefore cannot
  reach the client even if the trigger were somehow missing.
- **The client prefers it.** `rankFor({ points, tier })` takes points when they are present
  and only consults the label when there is no score. `tierForPoints()` is the points-in
  lookup, and it mirrors `tier_for_points()` exactly: the highest floor reached, bounds read
  from the table rather than a switch.

`resolveTier()` — the older label-lookup — now tolerates case, whitespace, ids and tier
objects instead of collapsing every miss to `table[0]`. That silent Novice fallback was the
original defect: a wrong input produced a *plausible* wrong answer rather than an error, so
nothing ever surfaced.

Revoke is where staleness was most visible: taking back a 100-point day is exactly what
drops a user out of Apex Luminary, so `tierBefore`/`tierAfter` are recomputed from both
scores rather than trusted from the RPC.

### Gemini output is treated as hostile input

The judge is asked for strict JSON via `responseMimeType` + `responseSchema`, then the
response is:
- parsed defensively (markdown fences and stray prose are tolerated),
- **normalized** — difficulty must be one of four known values, points are recomputed from
  it, and every string field has a fallback.

A malformed or adversarial model response degrades to a rejection; it cannot corrupt data.

### Degradation choices worth calling out

- **Gemini unreachable** → the submission fails with a clear message, nothing is deducted,
  and the user's day is *not* consumed. Retrying later still works.
- **Very short input (<15 chars)** → rejected locally without spending a Gemini call.
- **A rejected entry costs 3 points but keeps the day open.** Deliberately: the slot is the
  scarce resource, and burning it on a misfire would punish a typo as hard as laziness.
  The 3-point cost is real (three fluffs costs you a fifth of an Easy day) and it scales,
  so there is no incentive to spam attempts.

---

## 5. API reference

All `/api/*` routes require `Authorization: Bearer <supabase access token>`, with exactly two
exceptions: `GET /api/health` and `GET /api/tiers` are public, and `POST /api/cron/decay` uses
the `x-cron-secret` header instead because an external scheduler has no user session. The
guarantee is enforced structurally, not by convention — `npm run build:server` fails if any
mounted router stops applying `requireAuth` before its first route.

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/health` | public | Liveness. Reports nothing about the configuration. |
| `GET` | `/api/tiers` | public | Current tier table |
| `GET` | `/api/profile` | JWT | Profile, rank progress, stats, daily status (runs decay first) |
| `PATCH` | `/api/profile` | JWT | Set `username` / dismiss onboarding |
| `GET` | `/api/submissions/today` | JWT | Is the daily slot spent? Plus `rejectedAttemptsToday` / `penaltyToday` / `revokedLog` |
| `POST` | `/api/submissions` | JWT | Submit `{ taskDescription }` → graded result (`accepted: true\|false`) |
| `DELETE` | `/api/submissions/today` | JWT | Revoke today's accepted entry so a better one can replace it |
| `GET` | `/api/logs?limit&offset` | JWT | History feed (including rejected and revoked attempts) + aggregate stats |
| `GET` | `/api/leaderboard?filter&limit` | JWT | `all_time` or `month`, plus your own rank |
| `POST` | `/api/cron/decay` | `x-cron-secret` | Force a decay sweep |

Every query is scoped to `req.user.id`, which comes from Supabase's answer to `auth.getUser()`
and never from a request header, query parameter, or body. There is no auth bypass of any
kind, and no route reaches the database unauthenticated.

Errors are always shaped like this:
```json
{ "error": { "code": "ALREADY_SUBMITTED", "message": "human readable" } }
```

`POST /api/submissions` returns `201` for **both** outcomes — a `daily_logs` row is
created either way — so clients must branch on `accepted`, not on the status code:

```jsonc
// rejected
{
  "accepted": false,
  "slotConsumed": false,      // today's slot is still open
  "penaltyPoints": 3,
  "pointsGained": -3,         // the delta actually applied (floor 0)
  "pointsBefore": 760,
  "profile": { "points": 757, "currentStreak": 3 },
  "evaluation": { "difficulty": "Invalid", "aiFeedback": "…", "reasoning": "…" },
  "log": { "isCompleted": false, "penaltyPoints": 3 }
}

// accepted
{
  "accepted": true,
  "slotConsumed": true,
  "basePoints": 70,
  "streakBonus": 25,
  "pointsGained": 95,
  "penaltyPoints": 0,
  "tierProgress": { "current": { "label": "Specialist" }, "next": { … } }
}
```

`409 ALREADY_SUBMITTED` is returned only when an **accepted** entry already exists for
today — at that point the slot is spent and nothing more can be submitted.

`DELETE /api/submissions/today` succeeds only when today's entry is still the current UTC
day's, so the same `409` cannot be talked around. Its response reports the full delta so the
UI can be honest about the consequences:

```jsonc
{
  "revoked": true,
  "pointsRemoved": 75,        // what the balance actually moved by (floored)
  "pointsBefore": 1180,
  "pointsAfter": 1105,
  "streakBefore": 12,
  "streakAfter": 11,
  "streakBroken": true,
  "tierBefore": "Specialist",
  "tierAfter": "Specialist",
  "tierChanged": false,
  "log": { "isCompleted": false, "revokedAt": "2026-10-01T12:04:11.302Z" },
  "tierProgress": { "current": { "label": "Specialist" }, "next": { … } }
}
```

`409 NOTHING_TO_REVOKE` means there is nothing of yours from today to replace — either the
day is already spent or it rolled over and is now archival.

### Response caching and compression

Every response under `/api` carries `Cache-Control: no-store` except `/api/tiers`. Almost
everything here is scoped to one verified user — points, streak, submission history, rank —
and with no explicit policy a shared cache in front of the origin is entitled to apply
heuristic freshness to a `200` and store one user's payload to serve to the next similar
request. `no-store` removes that possibility rather than relying on shared caches to notice
the `Authorization` header.

`/api/tiers` is the exception and opts in explicitly, because it is seven rows of constants
containing no user data and it changes only when the schema does:

```
Cache-Control: public, max-age=300, stale-while-revalidate=86400
```

Bodies over 1 KB are compressed, with brotli preferred over gzip when the client offers it
and gzip otherwise. A 100-row leaderboard payload is ~13.8 KB uncompressed, ~1.2 KB gzipped
and ~0.8 KB brotli'd. The 1 KB floor is deliberate — below it the gzip header and dictionary
cost more than they save, and this API emits a lot of small responses (health, 404s,
validation errors).

Errors never carry a stack trace, and neither `translateDbError`'s check-constraint branch nor
`POST /api/cron/decay` echo a raw Postgres message back to the caller. Both name tables and
constraints; both go to the server log instead, where the operator can see them and the
client cannot.

---

## 6. Deployment

The client and the API deploy as **two separate services**. The only thing they need to agree
on is the API's public origin, which has to appear in the API's `CORS_ORIGIN` and in the
client's `VITE_API_URL`.

```
┌───────────────────────────┐        ┌───────────────────────────┐
│ Client — static host      │  HTTPS │ API — Node service        │
│ Vercel / Netlify / S3/…  │───────►│ Render / Fly / Railway    │
│ env: VITE_SUPABASE_*      │        │ env: SUPABASE_*, GEMINI_* │
│      VITE_API_URL         │        │      NODE_ENV, CORS_ORIGIN│
└───────────────────────────┘        │      CRON_SECRET          │
                                     └────────────┬──────────────┘
                                                  │ service role
                                          ┌───────▼────────┐
                                          │ Supabase/Postgres│
                                          └────────────────┘
```

### Build gates

Run these before every deploy. Each fails loudly rather than shipping something broken.

```bash
npm run build          # server build gate, then the client production build
npm test               # schema invariants + icon parity, tab-title, ranks, guest mode
npm run test:runtime   # load the built bundle in a real browser and check it renders
npm run audit:bundle   # no privileged credential reached client/dist (run after build)
```

**`npm run build` runs two checks:**

- `server/scripts/build.mjs` — parses every source file, resolves every import, audits every
  mounted router to confirm it applies `requireAuth` before its first route, and exercises
  `validateConfig()` against a synthetic production environment (including the negative
  cases: a missing service-role key must be rejected, `CORS_ORIGIN=*` must be rejected in
  production, and a legitimate local `http://localhost` origin must still be accepted).
- `vite build` — refuses to produce a bundle unless `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` are real. Since Vite inlines `VITE_*` at build time, a
  placeholder would otherwise ship a live site whose login form does nothing. It also
  fails if `package.json` declares a dependency that nothing in `src/` imports, because an
  unused dependency is installed, updated and audited forever while contributing nothing
  to the bundle. (`react-router-dom` used to sit in exactly that state.)

**`npm test` also covers `supabase/schema.sql`** via `supabase/check-schema.mjs`, because
that file is applied by pasting it into the SQL Editor, which has no dry-run mode — by the
time a mistake surfaces you are reading an error from the middle of a 1000-line script. It
checks what a text scan can establish: dollar-quote balance, that every function the API
calls exists exactly once, that re-running is safe, and that the bugs this project has
already had (`42P10` from a LATERAL in an UPDATE's FROM list, non-idempotent decay, a
stale stored tier) cannot come back. What it cannot check is whether Postgres accepts the
SQL — there is no Postgres on the build machine.

**`npm run audit:bundle`** reads the real keys from `server/.env` and asserts that every
JWT-shaped string in `client/dist` is byte-identical to the anon key and carries
`"role":"anon"`. Searching for the service-role key by value is not sufficient on its own:
both keys share their first 110 characters, so a prefix check is satisfied by the anon key.

**`npm run test:runtime`** exists because every other gate here is static. The schema
checker reads SQL as text, the credential audit reads emitted files as text, and `vite build`
only reports whether the module graph *resolves* — none of them observe the bundle
*running*. That gap is not hypothetical: splitting a vendor chunk or adding a lazy boundary
produces a bundle that builds perfectly clean and then throws `Cannot access 'X' before
initialization` in the browser, because a cycle that used to be internal to one chunk is now
split across two and evaluated in a different order. So this serves the real emitted
`client/dist`, loads it in headless Chrome with a seeded guest session, and asserts that
React mounts, that nothing throws, and that every deferred chunk is fetchable and evaluates.
It skips with exit 0 when no Chrome/Edge binary is present (pass `--require-browser` to turn
that skip into a failure — worth doing on CI).

**There is no TypeScript step and no ESLint config** — this is a plain-ESM JavaScript
project, and `npm run build` is the compile gate. Adding either is a separate decision, not
something to imply is already covered.

### Bundle composition

The client is split so that a change to app code does not invalidate the ~300 KB of
third-party code that did not change with it. Content-hashed chunks are re-downloaded by a
returning user the instant their hash changes, so long-lived vendor chunks are worth more
than a smaller total.

| Chunk | gzip | Contents |
| --- | --- | --- |
| `index` | ~27 kB | all app code |
| `supabase` | ~57 kB | `@supabase/supabase-js` and its transitive packages |
| `react` | ~45 kB | `react`, `react-dom`, `scheduler` |
| `motion` | ~38 kB | `framer-motion` |
| `icons` | ~5 kB | `lucide-react` |
| `vendor` | ~6 kB | remaining dependencies |

Deferred until actually needed (`React.lazy`): `Guidelines` (~6 kB gzip, one tab),
`AuthScreen` (~3 kB, signed-out branch only), and the `OnboardingModal`, `RankRoadmapModal`
and `TierPromotionOverlay` overlays (~8 kB combined, opened on demand).

Two deliberate non-choices:

- **The dashboard is not lazy.** It is the landing view for a signed-in user; deferring it
  would put a network round trip in front of the first paint of the page people came for.
- **There is no router.** This is a tabbed SPA sharing one dataset, so there is no route
  table to split on. Splitting the tabs themselves would break the instant-switching
  behaviour the tab state exists to provide.

### The client (static)

```bash
npm run build:client     # emits client/dist
```

Serve `client/dist` as a static site. **SPA fallback is required**: any unknown path must
return `index.html`, or a refresh on `/leaderboard` will 404.

Environment variables must be set as **build-time** variables (Vercel: *Settings → Environment
Variables*, applied to the Build step; Netlify: *Site configuration → Environment variables*).
Setting them only at runtime does nothing, because they are already compiled into the bundle.

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — required; the build fails without them.
- `VITE_API_URL` — your API origin. Leave blank only if the API is on the same origin.
- `VITE_PUBLISH_SOURCEMAPS` — optional. Source maps embed the full original source of every
  module; enable it only on the deploy wired to error monitoring.

### The API (Node)

There is no bundling step. Deploy the repository, install, and run `node server/src/index.js`.

```bash
npm install
npm run build            # the gate above — run it, do not skip it
npm start                # == node server/src/index.js
```

| Variable | Notes |
| --- | --- |
| `NODE_ENV=production` | Enables the strict CORS and `CRON_SECRET` rules. **Set this.** |
| `PORT` | Set it to whatever the platform injects (Render and Fly both do). Defaults to 4000. |
| `SUPABASE_URL` | Required. |
| `SUPABASE_ANON_KEY` | Required. Used *only* to verify incoming JWTs. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required. Server-only; put it in the platform's secret store. |
| `GEMINI_API_KEY` | Required. |
| `GEMINI_MODEL` | Optional, defaults to `gemini-2.5-flash`. |
| `CORS_ORIGIN` | Required. Comma-separated exact origins, no trailing slash, no wildcard. |
| `CRON_SECRET` | **Required in production.** The server will not boot without it. |

`trust proxy` is already set to `1`, which is what Render, Fly, Railway and nginx add — so
rate limiting sees the real client IP rather than the proxy's.

#### Vercel (client)

Zero-config: the repo is detected as Vite. Set `VITE_*` in project settings, set the output
directory to `client/dist`, and add a rewrite so all paths fall through to `index.html`:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/client/dist/index.html" }] }
```

Vercel cannot host a long-lived Node process, so deploy the API elsewhere and use
`POST /api/cron/decay` from Vercel Cron.

#### Render (API)

Web Service, root directory `server`, build `npm install`, start `npm start`. Add the env vars
above as **Secret** entries. Render injects `PORT` automatically. Because the service can be
idle, treat the in-process cron as a convenience and schedule `POST /api/cron/decay` from an
external scheduler.

#### Fly.io (API)

```bash
fly launch --no-deploy          # then add a [build] / [env] section
fly secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... \
  SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... CRON_SECRET=...
fly deploy
```

`fly.toml` needs `internal_port` matching `PORT` and a `force_https = true` health check on
`/api/health`. A Fly machine can stay resident, so the in-process `node-cron` job is reliable
here.

### The decay job in production

The in-process `node-cron` job fires at `00:00 UTC` and is sufficient **only** while the
process is alive. Decay is also reconciled lazily on every profile read
(`apply_decay()`), so a missed sweep self-heals rather than corrupting anything — but the
leaderboard ranking is only as fresh as the last sweep.

If the platform can scale to zero, schedule the external endpoint instead:

```bash
# Vercel Cron / GitHub Actions / any scheduler — once a day, shortly after 00:00 UTC
curl -X POST https://api.example.com/api/cron/decay \
  -H "x-cron-secret: $CRON_SECRET"
```

It is guarded by a **constant-time** secret comparison and returns `500` if the sweep failed,
so a scheduler can tell the difference between "ran" and "ran and did nothing". Note that this
endpoint is authenticated by a shared secret, not a user JWT — an external scheduler has no
Supabase session, and requiring one would make it uncallable.

**Supabase `pg_cron` is the tidiest option**, because it calls the SQL directly and skips the
API entirely:

```sql
select cron.schedule(
  'ascension-decay',
  '7 0 * * *',                      -- 00:07 UTC, just past the rollover
  $$select public.reconcile_all_streaks();$$
);
```

Running both the cron job and `pg_cron` is harmless — the function is idempotent.

### Rate limits

| Scope | Limit | Keyed on |
| --- | --- | --- |
| Whole API | 300 / minute | client IP |
| `POST /api/submissions` | 30 / hour | `user.id` |
| `DELETE /api/submissions/today` | 10 / hour | `user.id` |

The submission limit is the one that matters. Every request that passes validation spends a
real Gemini call, and the one-per-day rule is enforced by the database *after* grading — so it
does not protect the judge at all. A rejected attempt is a paid call that returns `201`, which
is why `skipSuccessfulRequests` is deliberately **not** set on that limiter.

### Before going live

- [ ] `npm run build` and `npm test` both pass
- [ ] `NODE_ENV=production` is set on the API (it is what enforces the CORS and `CRON_SECRET` rules)
- [ ] `CRON_SECRET` is generated, long, and in the secret store
- [ ] `CORS_ORIGIN` lists only your real `https` origins
- [ ] The service-role key and Gemini key are in the host's secret store, never in git
- [ ] `client/.env` contains only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
- [ ] A decay scheduler is in place if the API can idle
- [ ] SPA fallback configured on the static host (needed for deep links, not for OAuth)
- [ ] Google OAuth redirect URLs updated to the production domain — the **site root**, not a
      `/auth/callback` path
- [ ] `npm run audit:bundle` passes against the production build
- [ ] `npm run test:runtime` passes against the production build
- [ ] Email confirmation enabled (prevents throwaway-account abuse)
- [ ] `supabase/schema.sql` has been run against the production project
- [ ] A human has looked at the favicon in a real browser tab
- [ ] A CDN or proxy in front of the API is not caching authenticated responses. The server
      sends `Cache-Control: no-store` on everything under `/api` except `/api/tiers`, which
      is `public` because it is seven rows of constants with no user data. A proxy that
      rewrites or ignores response cache headers can reintroduce the risk the header exists
      to close.

---

## 7. Troubleshooting

**"CONFIGURATION PROBLEMS — REFUSING TO START" on boot**
The server validates its environment at startup and exits. Every missing, blank, or
placeholder value is listed with instructions. There is no flag to skip this — the point is
that a server which boots half-configured produces 500s much later that look like application
bugs.

**"REFUSING TO BUILD — the client is not configured"**
`vite build` will not produce a bundle without real `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`, because Vite inlines them and a placeholder would ship a site whose
login form does nothing. Fill in `client/.env`, or use `vite build --mode development` if you
only want to check that the bundle compiles.

**"REFUSING TO BUILD — unused dependencies are declared"**
Something in `client/package.json` is not imported anywhere in `client/src`. Remove it and
run `npm install` to prune the lockfile. This check exists because an unused dependency is
still installed, updated, audited and eligible for its own CVEs forever, while contributing
nothing to the bundle.

**"CANNOT REACH THE DATABASE — REFUSING TO START"**
The credentials look valid but Supabase did not answer. Check `SUPABASE_URL` for typos, that
the project is not paused, and that `supabase/schema.sql` has been run. The server proves
`profiles` is reachable at boot rather than accepting traffic it cannot serve.

**"Profile not found" right after signing up**
The `handle_new_user()` trigger did not fire. Re-run `supabase/schema.sql`. Trigger creation on
`auth.users` requires ownership of that table, which the SQL editor has.

**`column "revoked_at" does not exist`**
The database predates the revoke feature and the column was never added. `schema.sql` is
idempotent (`add column if not exists`), so re-running the whole file is safe and will pick up
`revoked_at`, `recompute_streak()` and `revoke_today_log()` alongside it.

**`DELETE /api/submissions/today` returns 409 `NOTHING_TO_REVOKE` when it should not**
Check that `logged_date` on the row really is today's UTC date — a row logged near midnight in
a local timezone will not be, and the database compares in UTC by design. The response body
includes `utcNow` for exactly this check.

**Every rank shows "Novice", or the badge disagrees with the points**
Rank is derived from points at all three layers — the `profiles_sync_tier` trigger, the API
serializers, and `rankFor()` on the client — so a wrong rank means the ladder itself is wrong,
not that a label went stale. Confirm the diagnosis in two steps: ask the API directly, which
tells you whether the problem is the server or the UI.

```bash
# Get a real access token: sign in, then in the browser console run
#   (await supabase.auth.getSession()).data.session.access_token
export ASCENSION_TOKEN=<jwt>

curl -H "Authorization: Bearer $ASCENSION_TOKEN" http://localhost:4000/api/profile
npm run test:tiers:live --workspace client
```

The live check recomputes the expected rank from the `tierTable` the API itself returns, so a
bug in `getTierForPoints()` cannot make it pass. If the API returns the right rank but the UI
shows Novice, the client's `tierTable` is empty or malformed and it is falling back to
`FALLBACK_TIERS`. If the API returns Novice too, the `tiers` table has been retuned: the
fallback ladder in both `lib/tiers.js` files and the `insert ... on conflict do update` block
in `schema.sql` are three copies of the same thresholds and all three must move together.

**"fetch failed" / "Could not reach the API"**
The API is not running, or `VITE_API_URL` points somewhere wrong. Check
`curl http://localhost:4000/api/health`.

**"The API returned a non-JSON response" or "API endpoint not found"**
`VITE_API_URL` was pointing at the API origin without the `/api` segment, so requests went to
`/profile` instead of `/api/profile`. The client appends `/api` automatically — set
`VITE_API_URL=http://localhost:4000` (bare origin) or leave it blank to use the Vite dev
proxy. After changing `.env`, restart the dev server: Vite only reads env files at startup.

**"Sign-in is unavailable" on the auth screen**
The build has no Supabase credentials, so the controls are disabled on purpose. Add
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to `client/.env` and restart the dev server.

**401 on every API call after signing in**
The access token expired and the single automatic retry did not recover it — which happens if
the stored session was invalidated server-side. Sign out and back in. If it persists, the
`SUPABASE_ANON_KEY` on the API is from a different project than the `VITE_SUPABASE_URL` the
browser is using, so the API cannot verify the token.

**429 on submission**
You have made 30 grading calls in the last hour. This is the abuse ceiling, and it counts
rejected attempts too. Your day is not lost — wait and try again.

**Gemini returns an error**
Confirm the key works and `GEMINI_MODEL=gemini-2.5-flash` is available to your project. The
user's day is not consumed when this happens, and nothing is deducted, so it is safe to retry.

**"already submitted today" but you did not submit**
The window is UTC. Check the countdown on the dashboard — if it is near `00:00:00`, you are
looking at yesterday's slot.

**"Google sign-in is not enabled on this project"**
The provider is disabled. **Authentication → Providers → Google** → enable it, add a
client id and secret from Google Cloud Console, then add your site root to
**Authentication → URL Configuration → Redirect URLs**. Nothing in the codebase can
fix this; the request never reaches Google.

**Google sign-in lands on a 404**
Your redirect URL points at `/auth/callback`, which this app does not serve. Change it
to the site root — see [Step 5](#step-5--enable-google-oauth-optional).

**Node engine warnings during `npm install`**
Harmless on Node 18. Some Supabase transitive dependencies want Node 22; nothing they are used
for here requires it. The whole project is pinned to Vite 5 and Tailwind 3 for this reason.

**API dies mid-session with `ERR_INVALID_ARG_TYPE: "paths[1]" ... Received null`**
This is a bug in Node 18.18.0's own `--watch` file watcher, not in this codebase. It fires when
a watched file is replaced and takes the whole process down, so every endpoint starts returning
`500` with an empty body. It is the reason `npm run dev` is unreliable here.

Workaround: run the API without the watcher.

```powershell
npm start --workspace server   # == node src/index.js
```

Restart it manually after editing server code. A permanent fix would be adding `nodemon` as a
devDependency (not currently installed) or a ~40-line `fs.watch` supervisor in `server/src/`;
neither has been done, because it changes the dev loop rather than the app.

**Port 4000 will not free up, or the API exits immediately**
`node --watch` spawns a supervisor that survives when you kill the process holding the port.
Kill the whole tree instead:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

**The rank badge shows a generic icon**
`RankBadge` maps icons by `tier.id` (`novice` … `apex`) and falls back to `Award` for anything
else. If a rank you added to the `tiers` table shows a trophy-less badge, add its id to
`RANK_ICONS` in `client/src/components/RankBadge.jsx`.

---

## Project layout

```
├── supabase/
│   ├── schema.sql             # tables, tiers, functions, triggers, RLS, grants — no user data
│   └── check-schema.mjs       # static checks on that file (npm run test:schema)
├── server/
│   ├── scripts/
│   │   ├── build.mjs          # the server build gate: parse, imports, auth audit, config
│   │   └── audit-auth.mjs     # proves every mounted /api router is private
│   └── src/
│       ├── config/            # env validation (fail-fast), Supabase clients
│       ├── lib/               # typed HTTP errors, tier maths
│       ├── middleware/        # JWT verification — no bypass
│       ├── routes/            # profile, submissions, logs, leaderboard, cron
│       ├── services/          # Gemini judge, decay reconciliation
│       └── jobs/              # nightly UTC decay cron
└── client/
    ├── public/               # GENERATED favicons — edit scripts/render-icons.mjs, not these
    ├── scripts/              # icon renderer, parity/asset checks, title + rank + guest tests,
    │                         #   audit-bundle-credentials.mjs (no privileged key in dist)
    │                         #   verify-runtime.mjs (loads the built bundle in a real browser)
    └── src/
        ├── components/        # TierCard, RankBadge, RankRoadmapModal, SubmissionEngine, GuestBanner…
        │                      #   ViewRanksButton.jsx is separate from RankRoadmapModal so the
        │                      #   ladder can be lazy-loaded (TierCard needs the button)
        ├── context/           # AuthContext — Supabase session + the separate `isGuest` flag
        ├── hooks/             # game data + identity-keyed refetch, countdown, animated counter,
        │                      #   Web Audio sound, document title
        ├── lib/               # api client, supabase client, confetti, tiers, title rules
        │                      #   guestSession.js + guestApi.js — the browser-only preview
        └── pages/             # Dashboard.jsx (tab host), Guidelines.jsx (Task Codex, lazy)
```

### What is deliberately absent

Every entry below is about the **server**. The client-side guest preview does not change any of
them: it lives in `client/src/lib/` and the API is not involved.

| Not here | Why |
| --- | --- |
| `server/src/mock/` | A server-side store let anyone click through the whole product with no database — including seeing a leaderboard populated by invented users. A preview of the UI is a reasonable thing to want; a preview that lives on the server is a second source of truth for points, and two sources of truth drift. |
| `MOCK_MODE`, `VITE_DEMO_MODE` | A mode flag read by the server would be a second code path that is never the one under test. Guest mode is a branch in the *client's* API client, so the server still has exactly one path. |
| A server-side heuristic judge | It would have handed out points the real Gemini judge might not award, invisibly, to anyone who hit the API. For a signed-in user Gemini being unreachable is a `502` and an untouched day. (Guest mode does use a heuristic judge — it is labelled `simulated: true` and says so in its own output.) |
| Seeded users or log rows in `schema.sql` | The only rows the schema inserts are the seven tier thresholds, which are configuration. A freshly-migrated database is genuinely empty; sample history lives in the visitor's browser. |
| `x-mock-user` | It let anyone be anyone. `req.user` now comes from Supabase's answer and nowhere else, and a guest never sends a request that could be answered. |

---

MIT