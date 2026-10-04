-- ============================================================================
--  THE ASCENSION — Supabase / PostgreSQL schema
-- ============================================================================
--  Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New).
--  It is idempotent: safe to re-run after you make changes below.
--
--  Before you run it, on a BRAND NEW project
--  ------------------------------------------
--  1. Nothing to set up — this file creates every table, function, index, policy
--     and trigger it needs. The database starts empty and this is the only file
--     to paste.
--  2. Supabase Auth must already exist, which it does on every hosted project.
--     The guard at the bottom of this file checks that every object was created and
--     stops with a clear message rather than a wall of `relation "profiles" does not
--     exist`.
--  3. Afterwards, if you want Google sign-in: Authentication -> Providers ->
--     Google, enable it, paste a client ID and secret from Google Cloud Console,
--     and add these under Authentication -> URL Configuration -> Redirect URLs:
--         http://localhost:5173/            development
--         https://your-domain.com/          production
--     The redirect is the site root, not a /auth/callback path — this app reads
--     the OAuth tokens from the URL fragment on load, so any page that loads the
--     bundle works and no host-side rewrite is required.
--
--  Design notes
--  ------------
--  * The database is the single source of truth for ALL point arithmetic.
--    Streak bonuses, decay and tier assignment happen inside a single
--    transaction (submit_daily_log) so a user can never be double-awarded.
--  * The browser never talks to these tables directly. The Express API uses the
--    service-role key, which bypasses RLS. RLS is still enabled below as
--    defense-in-depth in case a client key ever leaks.
--  * Tiers live in a data table (not hardcoded in functions) so the API can read
--    them at boot and stay perfectly in sync with the UI.
--  * Nothing in here creates users or writes a daily log. The only rows this file
--    inserts are the seven tier thresholds above, which are configuration rather
--    than data. Everything else arrives through Supabase Auth and the API, so a
--    freshly-migrated database is genuinely empty.
--
--  Time
--  ----
--  Every date in this application is a UTC calendar date, and the day boundary is
--  midnight UTC — not the server's local midnight, not the user's. A player in
--  Auckland and a player in Los Angeles therefore get the same 24-hour window, and
--  the leaderboard cannot be gamed by changing a machine's clock.
--
--  Concretely, that means:
--    * "today" is always `(now() at time zone 'utc')::date`, never `current_date`
--      and never `now()::date` — both of those resolve in the database session's
--      time zone, which is UTC on Supabase but is NOT guaranteed to stay UTC.
--    * `logged_date` is a `date`, never a `timestamptz`. A timestamp here would
--      let a day depend on how it is read back.
--    * `created_at` / `revoked_at` / `updated_at` stay `timestamptz` for audit
--      purposes and are always compared as instants.
--  submit_daily_log(), apply_decay(), revoke_today_log() and recompute_streak()
--  all derive their day from the same expression, which is what keeps the
--  one-entry-per-day index, the streak, and the decay sweep agreeing about which
--  day it is.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. SESSION SETTINGS
-- ---------------------------------------------------------------------------
--  Pinned rather than assumed. Every day boundary below is written as
--  `(now() at time zone 'utc')::date`, which is correct on its own terms -- but
--  `set timezone to 'utc'` also makes the bare `date` casts inside the interval
--  arithmetic resolve identically, so the file does not depend on the database,
--  the role, or the project default happening to be UTC. Supabase allows that
--  default to be changed from the dashboard; this removes the dependency.
set timezone to 'utc';

-- ---------------------------------------------------------------------------
-- 1. TIERS
-- ---------------------------------------------------------------------------
create table if not exists public.tiers (
  id          text primary key,
  label       text    not null unique,
  min_points  integer not null unique,
  max_points  integer,             -- null = unbounded (top tier)
  accent      text    not null,    -- hex, used for badges / glow
  sort_order  integer not null
);

insert into public.tiers (id, label, min_points, max_points, accent, sort_order) values
  ('novice',     'Novice',          0,  199,  '#94a3b8', 1),
  ('apprentice', 'Apprentice',    200,  499,  '#34d399', 2),
  ('practitioner','Practitioner', 500,  999,  '#38bdf8', 3),
  ('specialist', 'Specialist',   1000, 1999,  '#a78bfa', 4),
  ('architect',  'Architect',    2000, 3999,  '#fbbf24', 5),
  ('grandmaster','Grandmaster',  4000, 6999,  '#fb7185', 6),
  ('apex',       'Apex Luminary',7000, null,  '#ffd166', 7)
on conflict (id) do update
  set label      = excluded.label,
      min_points = excluded.min_points,
      max_points = excluded.max_points,
      accent     = excluded.accent,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 2. PROFILES
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                     uuid primary key references auth.users(id) on delete cascade,
  username               text    not null unique,
  avatar_url             text,
  points                 integer not null default 0 check (points >= 0),
  current_tier           text    not null default 'Novice',
  current_streak         integer not null default 0 check (current_streak >= 0),
  last_submission_date   date,
  has_completed_onboarding boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists profiles_points_idx      on public.profiles (points desc);
create index if not exists profiles_streak_idx      on public.profiles (current_streak desc);

-- Usernames are unique case-insensitively, so "Alice" cannot claim a name a
-- different user already holds as "alice". The plain `unique` on the column above
-- is case-SENSITIVE and would happily allow both, which on a leaderboard means two
-- visually identical names and one of them unclaimable forever. A functional index
-- on lower(username) is the only way to express that in Postgres; it cannot be a
-- column constraint, so this replaces it rather than accompanying it.
create unique index if not exists profiles_username_lower_unq
  on public.profiles (lower(username));

-- ---------------------------------------------------------------------------
-- 3. DAILY LOGS
-- ---------------------------------------------------------------------------
create table if not exists public.daily_logs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  task_description  text not null check (char_length(task_description) between 3 and 2000),
  difficulty        text not null check (difficulty in ('Hard','Average','Easy','Invalid')),

  -- points_awarded is the NET points for this attempt. It is negative for a
  -- rejected entry (-3 penalty), so there is deliberately no >= 0 check here.
  points_awarded    integer not null default 0,
  base_points       integer not null default 0,
  streak_bonus      integer not null default 0,
  penalty_points    integer not null default 0 check (penalty_points >= 0),

  -- false = a rejected attempt that did NOT consume the daily slot.
  is_completed      boolean not null default true,

  -- Revocation. A row that WAS accepted and was then undone by the user while
  -- it was still today's UTC day. Three distinct states, so a row is never
  -- ambiguous about which of them it is:
  --
  --   is_completed = true,  revoked_at IS NULL     -> accepted, counts
  --   is_completed = false, revoked_at IS NULL     -> rejected attempt, penalty
  --   is_completed = false, revoked_at IS NOT NULL -> revoked, counts for nothing
  --
  -- Because a revoked row has is_completed = false it drops out of the partial
  -- unique index below, which is exactly what frees the daily slot. The row is
  -- kept rather than deleted so the audit trail survives: the user provably had
  -- an accepted entry today and then took it back.
  revoked_at        timestamptz,

  ai_feedback       text,
  reasoning         text,
  logged_date       date not null default ((now() at time zone 'utc')::date),
  created_at        timestamptz not null default now()
);

-- The hard business rule: ONE *completed* productive achievement per UTC day.
-- Rejected attempts (is_completed = false) are exempt, so a user may retry as
-- many times as they like — each costing 3 points.
create unique index if not exists daily_logs_one_completed_per_day
  on public.daily_logs (user_id, logged_date)
  where is_completed;

-- Migration for databases created before retry mechanics existed.
alter table public.daily_logs add column if not exists penalty_points integer not null default 0;
alter table public.daily_logs add column if not exists is_completed boolean not null default true;
alter table public.daily_logs add column if not exists revoked_at timestamptz;
alter table public.daily_logs drop constraint if exists daily_logs_one_per_day;
alter table public.daily_logs drop constraint if exists daily_logs_points_awarded_check;
alter table public.daily_logs drop constraint if exists daily_logs_penalty_points_check;
alter table public.daily_logs
  add constraint daily_logs_penalty_points_check check (penalty_points >= 0);

create index if not exists daily_logs_user_date_idx on public.daily_logs (user_id, logged_date desc);
create index if not exists daily_logs_month_idx     on public.daily_logs (logged_date desc);

-- ---------------------------------------------------------------------------
-- 4. FEEDBACK
-- ---------------------------------------------------------------------------
--  The support inbox. One row per message a user sends from the FeedbackModal.
--
--  Deliberately write-only from the app's point of view: the API has no GET route
--  for this table, and the only policy is an INSERT scoped to the caller's own id.
--  So a signed-in user can file a report but cannot read anyone else's — including
--  their own — and cannot edit or delete a filed report even if they change their
--  mind. The operator reads the table directly in the Supabase dashboard, which
--  keeps a support policy decision out of the codebase.
--
--  `feedback_type` is constrained to the four buckets the UI offers. That is not
--  decoration: an unconstrained text column would accumulate whatever a buggy or
--  hostile client sent, and "General" would end up holding the very reports an
--  operator most needs to see.
create table if not exists public.feedback (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  feedback_type text not null check (feedback_type in ('bug','feature','appeal','general')),
  message       text not null check (char_length(message) between 10 and 4000),
  created_at    timestamptz not null default now()
);

-- Triage is by newest-first and always scoped to one type at a time, so the
-- composite index matches that query exactly rather than sorting on read.
create index if not exists feedback_created_idx on public.feedback (created_at desc);
create index if not exists feedback_type_created_idx on public.feedback (feedback_type, created_at desc);

-- cascade: feedback is about a person, so it goes when they go. Account deletion
-- promises to erase everything, and an orphaned row addressed to a deleted uuid
-- would quietly break that promise for no benefit — the operator has already read
-- whatever mattered by then.
--
-- not null on user_id, unlike the columns the task brief sketched: an anonymous
-- report has no way to be followed up on, and allowing one would make every
-- triage query a left join.

-- ---------------------------------------------------------------------------
-- 4b. TEARDOWN — drop every function before recreating it
-- ---------------------------------------------------------------------------
--  CREATE OR REPLACE FUNCTION cannot change a function's return type, and cannot
--  rename or re-type a parameter. Both are silently fatal in the worst possible
--  way: the statement raises, so the function keeps its OLD body, while the
--  functions that call it are replaced with bodies written against the NEW
--  signature. Nothing in the database complains at install time. Days later a
--  submission fails with a message that points at a type, not at the drift:
--
--    invalid input syntax for type uuid: "(7999d4a4-...,mobin,,0,Novice,0,,t,...)"
--
--  — a whole profiles record handed to a function expecting a uuid, because the
--  caller was rebuilt and the callee was not. apply_decay() returned a profiles
--  row for most of this file's life and now returns jsonb {applied, profile};
--  that one change is the entire cause.
--
--  So nothing here uses "or replace". Every function is dropped first and
--  created fresh, which makes the installed body exactly what is written here —
--  the only property that makes re-running this file trustworthy at all.
--
--  The triggers go first: handle_new_user, touch_updated_at and sync_profile_tier
--  are trigger functions, and DROP FUNCTION refuses to remove one a trigger still
--  depends on. (The functions themselves do not depend on each other — a
--  plpgsql body is parsed at first call, so PostgreSQL records no dependency and
--  apply_decay can be dropped while submit_daily_log still references it.)
drop trigger if exists on_auth_user_created      on auth.users;
drop trigger if exists profiles_touch_updated_at on public.profiles;
drop trigger if exists profiles_sync_tier        on public.profiles;

drop function if exists public.tier_for_points(integer);
drop function if exists public.get_tier_table();
drop function if exists public.handle_new_user();
drop function if exists public.touch_updated_at();
drop function if exists public.sync_profile_tier();
--  settle_decay() is not created below. It existed for one deploy as a
--  row-returning companion to apply_decay(), and is dropped here so the copy
--  already sitting in the database goes away rather than lingering as a second,
--  uncalled entry point to one rule. Keeping the drop means installs converge
--  whether the database has seen it or not.
drop function if exists public.settle_decay(uuid);
drop function if exists public.apply_decay(uuid);
drop function if exists public.reconcile_all_streaks();
drop function if exists public.submit_daily_log(uuid, text, text, integer, text, text);
drop function if exists public.recompute_streak(uuid);
drop function if exists public.revoke_today_log(uuid);
drop function if exists public.get_leaderboard(text, integer, uuid);
drop function if exists public.get_my_rank(text, uuid);
drop function if exists public.get_today_status(uuid);
drop function if exists public.get_profile_stats(uuid);

-- ---------------------------------------------------------------------------
-- 5. TIER LOOKUP
-- ---------------------------------------------------------------------------
create or replace function public.tier_for_points(p_points integer)
returns text
language sql
stable
as $$
  select label
  from public.tiers
  where min_points <= greatest(coalesce(p_points, 0), 0)
  order by min_points desc
  limit 1;
$$;

-- Full tier table as JSON — the API loads this at boot so client and server can
-- never disagree about thresholds.
create or replace function public.get_tier_table()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',         id,
           'label',      label,
           'minPoints',  min_points,
           'maxPoints',  max_points,
           'accent',     accent
         ) order by sort_order), '[]'::jsonb)
  from public.tiers;
$$;

-- ---------------------------------------------------------------------------
-- 6. AUTO PROVISION PROFILE ON SIGN-UP
-- ---------------------------------------------------------------------------
--  Runs as SECURITY DEFINER, so it can insert into profiles even though RLS is
--  enabled and there is no INSERT policy. That is the point: a client key must
--  never be able to create a profile with points attached.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base      text;
  v_username  text;
  v_attempt   text;
  v_conflicts integer := 0;
  v_state     text;
  v_context   text;
begin
  v_base := coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    nullif(new.raw_user_meta_data ->> 'user_name', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'ascendant'
  );

  -- normalise: lowercase, strip anything that isn't a-z0-9_, cap at 20 chars
  v_username := left(regexp_replace(lower(v_base), '[^a-z0-9_]', '', 'g'), 20);
  if v_username = '' then
    v_username := 'ascendant';
  end if;

  -- De-duplicate. The obvious version of this — check whether the name is taken,
  -- then append a slice of the uuid — is a race: two people signing up with the
  -- same name in the same millisecond both pass the check, and the second INSERT
  -- dies on the unique index. Because this runs inside the auth.users INSERT, that
  -- aborts the signup itself, so the user sees "sign-up failed" for a name clash
  -- they never caused.
  --
  -- So the uniqueness index is treated as the authority and the loop reacts to
  -- what it actually says. Each attempt uses a different suffix, so a genuine
  -- collision advances to the next candidate instead of looping forever.
  for v_attempt in 0 .. 3 loop
    v_username := case v_attempt
      when 0 then left(v_username, 20)
      else left(v_username, 14) || '_' || substr(replace(new.id::text, '-', ''), 1, 6)
                  || '_' || v_attempt::text
    end;

    begin
      insert into public.profiles (id, username, avatar_url)
      values (new.id, v_username, new.raw_user_meta_data ->> 'avatar_url')
      on conflict (id) do nothing;
      return new;
    exception
      when unique_violation then
        v_conflicts := v_conflicts + 1;
        -- Only a username clash is retried. A violation on the primary key means
        -- the profile already exists, which `on conflict do nothing` should have
        -- absorbed; anything else is a real failure and must not be swallowed.
        if v_conflicts = 4 then
          raise;
        end if;
    end;
  end loop;

  return new;

exception
  -- Sign-up is the one place where a bare SQLSTATE reaches a person as "sign-up
  -- failed", so the failing statement is attached to it.
  when others then
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_context = pg_exception_context;
    raise exception using
      errcode = v_state,
      message = sqlerrm,
      detail  = v_context;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 7. UPDATED_AT
-- ---------------------------------------------------------------------------
--  set search_path is pinned on every function in this file, including the
--  SECURITY INVOKER trigger functions. It costs nothing and it means a hostile or
--  careless session search_path cannot be substituted for the schema these
--  functions resolve their table names against.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_state   text;
  v_context text;
begin
  new.updated_at := now();
  return new;

exception
  when others then
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_context = pg_exception_context;
    raise exception using
      errcode = v_state,
      message = sqlerrm,
      detail  = v_context;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 7a. STRUCTURAL GUARD: current_tier can never disagree with points
-- ---------------------------------------------------------------------------
--  profiles.current_tier is a denormalised cache of tier_for_points(points).
--  Every writer in this file recomputes it by hand — submit_daily_log(),
--  apply_decay(), revoke_today_log(), reconcile_all_streaks() — and each of
--  those got it right. But a denormalised column maintained only by
--  convention is one forgotten UPDATE away from showing "Novice" to somebody
--  with 8,000 points, and the symptom is silent: the app renders, it is just
--  wrong, and it looks like the ladder maths is broken.
--
--  So the invariant is enforced by the database itself rather than by
--  discipline. Any INSERT or UPDATE that lands points gets the matching rank,
--  whatever the caller wrote in the current_tier column. Writes that already
--  set it correctly are unaffected — this simply becomes the single source of
--  truth, which is why the hand-written assignments above are harmless.
--
--  BEFORE, so the stored row is already correct when it is returned to the
--  caller. Sub-second cost: one indexed lookup on a seven-row table.
create or replace function public.sync_profile_tier()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_state   text;
  v_context text;
begin
  new.current_tier := public.tier_for_points(new.points);
  return new;

exception
  -- This fires on EVERY insert and every points write, so a fault here breaks
  -- sign-up, submission and revocation at once and reports all three as the same
  -- opaque SQLSTATE from whatever the caller happened to be doing.
  when others then
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_context = pg_exception_context;
    raise exception using
      errcode = v_state,
      message = sqlerrm,
      detail  = v_context;
end;
$$;

drop trigger if exists profiles_sync_tier on public.profiles;
create trigger profiles_sync_tier
  before insert or update of points on public.profiles
  for each row execute function public.sync_profile_tier();

-- ---------------------------------------------------------------------------
-- 8. DECAY  (-30 pts + streak reset per missed UTC day)
-- ---------------------------------------------------------------------------
--  ONE function, and its return value is read by exactly one caller.
--
--  The API needs to know whether decay actually charged anything, so that the
--  "your streak broke" toast fires on the day it happens instead of on every page
--  load. That flag crosses a process boundary, so this returns jsonb:
--
--      { "applied": boolean, "profile": { ...the row... } }
--
--  The temptation — and the mistake this file made four times — is to let the
--  SQL callers read that payload back into a profiles row, so they can do
--  `select * into v_profile from public.apply_decay(...)`. Two functions in one
--  transaction then exchange a row as a value, and each attempt to unpack it
--  failed differently at submit time, on a schema that reported no error while
--  installing:
--
--      22P02  invalid input syntax for type uuid: "{"applied":false,...}"
--      42809  column notation .profile applied to type jsonb
--      22P02  invalid input syntax for type uuid: "(7999d4a4,...,mobin,,0,...)"
--      22P02  invalid input syntax for type uuid: "(7999d4a4,...,mobin,,0,...)"
--
--  So the SQL callers do not read this function's output at all. They PERFORM it
--  — which discards the result — and then read the row from the table:
--
--      perform public.apply_decay(p_user_id);
--      select * into v_profile from public.profiles where id = p_user_id for update;
--
--  There is no conversion, nothing to decompose, and no shape to keep in step
--  with a caller. settle_decay() existed for one deploy as a row-returning
--  sibling for the SQL side; it was deleted because keeping it meant keeping the
--  unpacking, and because a second entry point to one rule is a second thing to
--  disagree about.
-- ---------------------------------------------------------------------------
create or replace function public.apply_decay(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_profile public.profiles;
  v_today   date := (now() at time zone 'utc')::date;
  v_missed  integer;
  v_applied boolean := false;
  v_state   text;
  v_context text;
begin
  -- Table references are aliased anyway, belt and braces.
  select p.* into v_profile from public.profiles p where p.id = p_user_id for update;
  if not found then
    raise exception 'Profile not found for user %', p_user_id using errcode = 'P0002';
  end if;

  if v_profile.last_submission_date is null then
    -- never submitted: only penalise days that have fully elapsed since signup
    v_missed := greatest(0, (v_today - (v_profile.created_at at time zone 'utc')::date) - 1);
  else
    v_missed := greatest(0, (v_today - v_profile.last_submission_date) - 1);
  end if;

  if v_missed > 0 then
    v_applied := true;
    -- SET targets are grammar-level column names (never variables); the
    -- expressions on the right-hand side are qualified as `p.<column>` and
    -- read the PRE-update value, so `points` and the tier lookup below cannot
    -- disagree.
    --
    -- current_tier MUST be recomputed here, not left for the next submission:
    -- decay can drop a user below a threshold (7,000 -> 6,400), and a stale
    -- label would show "Apex Luminary" to someone who no longer qualifies.
    --
    -- last_submission_date is the decay settlement cursor. Advancing it to
    -- v_today - 1 is what makes this function IDEMPOTENT, and it has to be:
    -- v_missed is derived from a cursor this function would otherwise never
    -- move, so every later call would recompute the same v_missed and subtract
    -- the same 30 x N again from an already-decayed balance. Because decay is
    -- settled lazily on every profile read, that turned a single missed day
    -- into a slow drain proportional to how often the page was opened.
    --
    -- Setting current_streak = 0 in the same statement is what keeps advancing
    -- the cursor safe: submit_daily_log() restarts the streak on a zero streak
    -- regardless of last_submission_date, so settling decay and then submitting
    -- yields 1, not N+1.
    update public.profiles p
       set points               = greatest(0, p.points - (30 * v_missed)),
           current_streak       = 0,
           current_tier         = public.tier_for_points(greatest(0, p.points - (30 * v_missed))),
           last_submission_date = v_today - 1
     where p.id = p_user_id
    returning p.* into v_profile;
  end if;

  return jsonb_build_object('applied', v_applied, 'profile', to_jsonb(v_profile));

exception
  when others then
    -- Every plpgsql body in this file ends this way. Postgres puts the failing
    -- statement, its line number and every nested frame into this context, which
    -- is the difference between a bug report that names a line and one that says
    -- only "invalid input syntax for type uuid". The SQLSTATE is carried over
    -- verbatim so translateDbError() still maps P0001/P0002/P0003/23505.
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_context = pg_exception_context;
    raise exception using
      errcode = v_state,
      message = sqlerrm,
      detail  = v_context;
end;
$$;

--  Set-based version used by the nightly cron job. One statement, no loop.
create or replace function public.reconcile_all_streaks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today   date := (now() at time zone 'utc')::date;
  v_rows    integer := 0;
  v_state   text;
  v_context text;
begin
  with missed as (
    select id,
           case
             when last_submission_date is null then
               greatest(0, (v_today - (created_at at time zone 'utc')::date) - 1)
             else
               greatest(0, (v_today - last_submission_date) - 1)
           end as missed_days
      from public.profiles
  )
  -- current_tier is recomputed for the same reason as in apply_decay(): decay
  -- can push a user below a threshold and the label must not go stale.
  --
  -- There is deliberately no LATERAL join here. An UPDATE's target alias is not
  -- visible to a LATERAL subquery in its own FROM list -- Postgres rejects that
  -- with 42P10 "invalid reference to FROM-clause entry for table p" -- whereas
  -- a plain FROM entry and the SET expressions may both reference the target.
  -- Computing the new balance inline is therefore both correct and cheaper than
  -- the lateral subquery it replaces.
  --
  -- last_submission_date is advanced to v_today - 1 for the idempotency reason
  -- documented in apply_decay(): this sweep runs on every leaderboard read, so
  -- without a moving cursor each read would re-charge the same missed days.
  update public.profiles p
     set points               = greatest(0, p.points - (30 * m.missed_days)),
         current_streak       = 0,
         current_tier         = public.tier_for_points(greatest(0, p.points - (30 * m.missed_days))),
         last_submission_date = v_today - 1
    from missed m
   where p.id = m.id
     and m.missed_days > 0;

  get diagnostics v_rows = row_count;
  return v_rows;

exception
  when others then
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_context = pg_exception_context;
    raise exception using
      errcode = v_state,
      message = sqlerrm,
      detail  = v_context;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. DAILY SUBMISSION  (the transactional heart of the app)
-- ---------------------------------------------------------------------------
--  Two very different outcomes live in this function:
--
--  ACCEPTED (Hard / Average / Easy)
--    Settles decay, consumes the daily slot, advances the streak, pays the
--    streak bonus, records the log as completed.
--
--  REJECTED (Invalid)
--    Deducts a flat 3-point penalty (floored at zero), records the attempt as
--    NOT completed so the daily slot stays open, and leaves the streak and
--    last_submission_date untouched — the user can still earn today.
--
--  Raises:
--    P0001  daily slot already completed -> HTTP 409
--    P0002  profile not found            -> HTTP 404
-- ---------------------------------------------------------------------------
--  NOTE: the user id is passed explicitly rather than via auth.uid(). These
--  functions are invoked with the service-role key, for which PostgREST sees
--  no user claim, so auth.uid() would be NULL. Safety comes from the fact that
--  EXECUTE is revoked from anon/authenticated — only the API can call these,
--  and the API validates the caller's JWT before it gets here.
create or replace function public.submit_daily_log(
  p_user_id          uuid,
  p_task_description text,
  p_difficulty       text,
  p_points_awarded   integer,
  p_ai_feedback      text,
  p_reasoning        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile        public.profiles;
  v_log            public.daily_logs;
  v_today          date    := (now() at time zone 'utc')::date;
  v_yesterday      date    := v_today - 1;
  v_base           integer := greatest(coalesce(p_points_awarded, 0), 0);
  v_valid          boolean;
  v_points_before  integer;
  v_new_streak     integer;
  v_bonus          integer;
  v_delta          integer;
  v_new_points     integer;
  v_new_tier       text;
  v_penalty        integer := 3;
  v_state          text;
  v_context        text;
begin
  -- 1. settle any outstanding decay first. PERFORM executes it and throws the
  --    result away, so there is no result set to decompose: no column to select
  --    out of a function's alias, no composite to unpack, nothing that can be
  --    mistaken for a uuid parameter.
  --
  --    Three previous versions did that unpacking instead — `select * into`
  --    from apply_decay, then `(d).profile`, then jsonb_populate_record — and
  --    each one failed at submit time with a different type error:
  --
  --      22P02  invalid input syntax for type uuid: "{"applied":false,...}"
  --      42809  column notation .profile applied to type jsonb
  --      22P02  invalid input syntax for type uuid: "(7999d4a4,...,mobin,,...)"
  --      22P02  invalid input syntax for type uuid: "(7999d4a4,...,mobin,,...)"
  --
  --    All four were the same mistake: two functions in one transaction
  --    exchanging a row as a value. The row lock is taken inside apply_decay and
  --    is held by this transaction for the rest of the function, so reading the
  --    row back below is a plain indexed read of a row we already hold.
  perform public.apply_decay(p_user_id);

  --    Then read the settled row. Single table, single row, one uuid equality —
  --    the same shape as every `update ... where id = p_user_id` below, which
  --    has never raised anything.
  select * into v_profile
    from public.profiles
   where id = p_user_id
     for update;

  if not found then
    raise exception 'Profile not found' using errcode = 'P0002';
  end if;

  -- 2. the daily slot is spent only by a COMPLETED entry. Rejected attempts
  --    leave it open, so retries are allowed all day long.
  if exists (
    select 1 from public.daily_logs
     where user_id = p_user_id
       and logged_date = v_today
       and is_completed
  ) then
    raise exception 'Daily submission already completed for %', v_today using errcode = 'P0001';
  end if;

  v_valid := p_difficulty in ('Hard', 'Average', 'Easy') and v_base > 0;
  v_points_before := v_profile.points;

  -- =================================================================
  -- REJECTED ATTEMPT — penalty only, slot stays open
  -- =================================================================
  if not v_valid then
    -- Floor at zero: a user on 1 point loses 1, not 3 and not negative.
    v_new_points := greatest(0, v_points_before - v_penalty);
    v_delta      := v_new_points - v_points_before; -- 0 to -3, actually applied
    v_new_tier   := public.tier_for_points(v_new_points);

    insert into public.daily_logs (
      user_id, task_description, difficulty, points_awarded,
      base_points, streak_bonus, penalty_points, is_completed,
      ai_feedback, reasoning, logged_date
    ) values (
      p_user_id, p_task_description, 'Invalid', v_delta,
      0, 0, v_penalty, false,
      p_ai_feedback, p_reasoning, v_today
    )
    returning * into v_log;

    -- Deliberately does NOT touch current_streak or last_submission_date:
    -- the day is still winnable, so the streak must not be punished yet.
    update public.profiles
       set points       = v_new_points,
           current_tier = v_new_tier
     where id = p_user_id
    returning * into v_profile;

    return jsonb_build_object(
      'log',           to_jsonb(v_log),
      'profile',       to_jsonb(v_profile),
      'accepted',      false,
      'slotConsumed',  false,
      'penaltyPoints', v_penalty,
      'pointsBefore',  v_points_before,
      'pointsGained',  v_delta,
      'basePoints',    0,
      'streakBonus',   0
    );
  end if;

  -- =================================================================
  -- ACCEPTED SUBMISSION — full reward path
  -- =================================================================

  -- 3. streak
  if v_profile.last_submission_date is null
     or v_profile.last_submission_date < v_yesterday
     or v_profile.current_streak = 0 then
    v_new_streak := 1;
  else
    v_new_streak := v_profile.current_streak + 1;
  end if;

  -- 4. streak bonus: +5 per consecutive day, capped at +50
  v_bonus := least(v_new_streak * 5, 50);

  -- 5. insert the completed log
  insert into public.daily_logs (
    user_id, task_description, difficulty, points_awarded,
    base_points, streak_bonus, penalty_points, is_completed,
    ai_feedback, reasoning, logged_date
  ) values (
    p_user_id, p_task_description, p_difficulty, v_base + v_bonus,
    v_base, v_bonus, 0, true,
    p_ai_feedback, p_reasoning, v_today
  )
  returning * into v_log;

  -- 6. credit points, advance streak, stamp the day
  v_new_points := v_points_before + v_base + v_bonus;
  v_new_tier   := public.tier_for_points(v_new_points);

  update public.profiles
     set points               = v_new_points,
         current_tier         = v_new_tier,
         current_streak       = v_new_streak,
         last_submission_date = v_today
   where id = p_user_id
  returning * into v_profile;

  return jsonb_build_object(
    'log',            to_jsonb(v_log),
    'profile',        to_jsonb(v_profile),
    'accepted',       true,
    'slotConsumed',   true,
    'penaltyPoints',  0,
    'pointsBefore',   v_points_before,
    'basePoints',     v_base,
    'streakBonus',    v_bonus,
    'pointsGained',   v_base + v_bonus,
    'tierChanged',    v_new_tier is distinct from public.tier_for_points(v_points_before)
  );

exception
  -- Same handler as apply_decay(), and the reason matters here more than
  -- anywhere: this function is 170 lines long and its callers see only a
  -- SQLSTATE. Without the context, "22P02" from a submission is unfalsifiable.
  when others then
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_context = pg_exception_context;
    raise exception using
      errcode = v_state,
      message = sqlerrm,
      detail  = v_context;
end;
$$;

-- ---------------------------------------------------------------------------
--  9a. STREAK RECOMPUTATION  (rebuild the streak from the accepted logs)
-- ---------------------------------------------------------------------------
-- Rebuilds current_streak + last_submission_date from the accepted logs.
--
-- Used by revoke_today_log(), where decrementing the streak is not safe: we
-- cannot know what the streak was before today's entry, or whether today's
-- entry was even the one that started the run. Recomputing from the logs is
-- self-healing and gets every edge case right for free — a first-ever entry, a
-- gap, a run interrupted by a revoked day.
--
-- The gap-and-islands technique: walking dates downwards, row_number() counts
-- 1, 2, 3... and a *consecutive* run all lands on the same shifted date, so
-- grouping by that value identifies each run. We then take only the run that
-- contains the most recent completed day.
--
-- A run that ends more than one day before today is reported as 0: the streak
-- is only alive if it reaches yesterday. This mirrors apply_decay() and
-- submit_daily_log(), so a revoke cannot resurrect a streak that a gap had
-- already broken.
create or replace function public.recompute_streak(p_user_id uuid)
returns table (current_streak integer, last_date date)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today   date := (now() at time zone 'utc')::date;
  v_anchor  date;
  v_state   text;
  v_context text;
begin
  select max(l.logged_date) into v_anchor
    from public.daily_logs l
   where l.user_id      = p_user_id
     and l.is_completed
     and l.revoked_at is null;

  if v_anchor is null then
    return query select 0, null::date;
    return;
  end if;

  if v_anchor < v_today - 1 then
    -- A gap sits between the last accepted day and today, so the run is dead.
    return query select 0, v_anchor;
    return;
  end if;

  return query
    select i.len::integer, i.last_day
      from (
        select count(*)::integer as len,
               max(n.logged_date) as last_day
          from (
            -- window function first: Postgres rejects one used directly in GROUP BY
            select l.logged_date,
                   l.logged_date
                     - (row_number() over (order by l.logged_date desc))::integer as island
              from public.daily_logs l
             where l.user_id      = p_user_id
               and l.is_completed
               and l.revoked_at is null
          ) n
         group by n.island
      ) i
     -- the run containing the most recent accepted day
     where i.last_day = v_anchor
     limit 1;

exception
  when others then
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_context = pg_exception_context;
    raise exception using
      errcode = v_state,
      message = sqlerrm,
      detail  = v_context;
end;
$$;

-- ---------------------------------------------------------------------------
--  9b. REVOCATION  (undo today's accepted submission)
-- ---------------------------------------------------------------------------
--  A user who logs a thin entry by mistake should be able to take it back and
--  do better. The window is deliberately narrow: only the CURRENT UTC day can
--  be revoked. Once 00:00 UTC rolls over, yesterday's entry is final forever.
--
--  What a revoke does, atomically:
--    1. settle any decay already owed
--    2. mark today's accepted log revoked (it leaves the unique index, so the
--       daily slot reopens)
--    3. give back the points AND the streak bonus that entry paid
--    4. recompute the streak from the surviving logs
--    5. recompute the tier from the new point total
--
--  What a revoke deliberately does NOT do:
--    * Touch rejected attempts. Those cost real points and stay on the record.
--      Letting a user erase penalties would turn the retry loop into a free
--      spam shield, so only is_completed = true rows are revocable.
--    * Refund anything on a day that is no longer today. The logged_date =
--      CURRENT_DATE guard below is the entire locking mechanism.
--
--  Raises:
--    P0002  profile not found                  -> HTTP 404
--    P0003  no accepted log for today          -> HTTP 409
-- ---------------------------------------------------------------------------
create or replace function public.revoke_today_log(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile        public.profiles;
  v_log            public.daily_logs;
  v_today          date    := (now() at time zone 'utc')::date;
  v_streak_before  integer;
  v_tier_before    text;
  v_points_before  integer;
  v_new_points     integer;
  v_new_streak     integer;
  v_new_anchor     date;
  v_new_tier       text;
  v_refund         integer;
  v_state          text;
  v_context        text;
begin
  -- 1. settle decay first. PERFORM discards the result set, so nothing is
  --    decomposed here; the row lock apply_decay takes is held for the rest of
  --    this function. See submit_daily_log() for why no function's output is ever
  --    unpacked in this file.
  perform public.apply_decay(p_user_id);

  select * into v_profile
    from public.profiles
   where id = p_user_id
     for update;

  if not found then
    raise exception 'Profile not found' using errcode = 'P0002';
  end if;

  -- 2. locate TODAY's accepted entry. Rejected attempts are not revocable.
  --    `for update` serialises two concurrent DELETEs: the loser sees the row
  --    already revoked, matches nothing, and gets P0003 instead of refunding
  --    the same points twice.
  select * into v_log
    from public.daily_logs
   where user_id     = p_user_id
     and logged_date = v_today
     and is_completed
     and revoked_at is null
   for update;

  if not found then
    raise exception 'No accepted submission for %', v_today using errcode = 'P0003';
  end if;

  v_streak_before := v_profile.current_streak;
  v_tier_before   := v_profile.current_tier;
  v_points_before := v_profile.points;

  -- 3. revoke it. The row is kept for the audit trail; is_completed = false
  --    takes it out of the partial unique index and so reopens the slot.
  update public.daily_logs
     set is_completed = false,
         revoked_at   = now()
   where id = v_log.id
  returning * into v_log;

  -- 4. refund the NET points that entry paid, i.e. base + streak bonus.
  --    Floored at zero so a refund can never manufacture points out of a
  --    profile that has since been decayed below the refunded amount.
  v_refund     := v_log.points_awarded;
  v_new_points := greatest(0, v_points_before - v_refund);

  -- 5. rebuild the streak from whatever completed logs survive
  select s.current_streak, s.last_date
    into v_new_streak, v_new_anchor
    from public.recompute_streak(p_user_id) s;

  v_new_tier := public.tier_for_points(v_new_points);

  update public.profiles
     set points               = v_new_points,
         current_tier         = v_new_tier,
         current_streak       = v_new_streak,
         last_submission_date = v_new_anchor
   where id = p_user_id
  returning * into v_profile;

  return jsonb_build_object(
    'revoked',        true,
    'log',            to_jsonb(v_log),
    'profile',        to_jsonb(v_profile),
    'pointsRemoved',  v_points_before - v_new_points,
    'pointsBefore',   v_points_before,
    'pointsAfter',    v_new_points,
    'streakBefore',   v_streak_before,
    'streakAfter',    v_new_streak,
    'tierBefore',     v_tier_before,
    'tierAfter',      v_new_tier,
    'tierChanged',    v_new_tier is distinct from v_tier_before,
    'streakBroken',   v_new_streak < v_streak_before
  );

exception
  -- P0002 and P0003 pass through unchanged: the SQLSTATE is preserved, so the
  -- "nothing to revoke" 409 is still distinguishable from a genuine fault.
  when others then
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_context = pg_exception_context;
    raise exception using
      errcode = v_state,
      message = sqlerrm,
      detail  = v_context;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. LEADERBOARD
-- ---------------------------------------------------------------------------
--  p_filter: 'all_time' | 'month'
--  Rank is computed over the requested scope. For 'month' the score is the sum
--  of points actually earned inside the current calendar month.
--  p_self_id marks the caller so the UI can highlight their own row.
-- ---------------------------------------------------------------------------
create or replace function public.get_leaderboard(p_filter text default 'all_time', p_limit integer default 100, p_self_id uuid default null)
returns table (
  rank          bigint,
  user_id       uuid,
  username      text,
  avatar_url    text,
  score         integer,
  points        integer,
  current_tier  text,
  current_streak integer,
  is_self       boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state   text;
  v_context text;
begin
  -- make sure absent users have decayed before we rank them
  perform public.reconcile_all_streaks();

  return query
  with scoped as (
    select p.id            as user_id,
           p.username,
           p.avatar_url,
           p.points,
           p.current_tier,
           p.current_streak,
           case
             when p_filter = 'month' then coalesce(m.month_points, 0)
             else p.points
           end as score
      from public.profiles p
      left join lateral (
        select sum(d.points_awarded)::int as month_points
          from public.daily_logs d
         where d.user_id = p.id
           and d.revoked_at is null
           and d.logged_date >= date_trunc('month', (now() at time zone 'utc'))::date
      ) m on true
  )
  select row_number() over (order by scoped.score desc, scoped.current_streak desc, scoped.username asc),
         scoped.user_id,
         scoped.username,
         scoped.avatar_url,
         scoped.score,
         scoped.points,
         scoped.current_tier,
         scoped.current_streak,
         scoped.user_id = p_self_id
    from scoped
   -- in the monthly board, only users who actually earned points appear
   where p_filter <> 'month' or scoped.score > 0
   order by scoped.score desc, scoped.current_streak desc, scoped.username asc
   limit greatest(1, least(coalesce(p_limit, 100), 500));

exception
  when others then
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_context = pg_exception_context;
    raise exception using
      errcode = v_state,
      message = sqlerrm,
      detail  = v_context;
end;
$$;

-- The signed-in user's own rank (may be NULL if they have no monthly points).
create or replace function public.get_my_rank(p_filter text default 'all_time', p_self_id uuid default null)
returns table (rank bigint, score integer, total_players bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := coalesce(p_self_id, auth.uid());
  v_state   text;
  v_context text;
begin
  return query
  with scored as (
    select p.id,
           case when p_filter = 'month'
                then coalesce((select sum(d.points_awarded)::int
                                 from public.daily_logs d
                                where d.user_id = p.id
                                  and d.revoked_at is null
                                   and d.logged_date >= date_trunc('month', (now() at time zone 'utc'))::date), 0)
                else p.points
           end as score
      from public.profiles p
  ),
  mine as (
    -- `score` is an implicit OUT parameter of this RETURNS TABLE signature, so
    -- the CTE column is renamed to keep every reference unambiguous.
    select coalesce((select s.score from scored s where s.id = v_uid), 0) as my_score
  )
  select (select count(*) + 1 from scored s2 where s2.score > (select m.my_score from mine m))::bigint,
         (select m.my_score from mine m)::integer,
         (select count(*) from scored)::bigint;

exception
  when others then
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_context = pg_exception_context;
    raise exception using
      errcode = v_state,
      message = sqlerrm,
      detail  = v_context;
end;
$$;

-- Today's state for a user. Only a COMPLETED log locks the daily slot;
-- rejected attempts are reported separately so the UI can show the running
-- penalty total while keeping the input open.
create or replace function public.get_today_status(p_self_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with me as (select coalesce(p_self_id, auth.uid()) as uid),
  today as (select (now() at time zone 'utc')::date as d),
  logs as (
    select l.* from public.daily_logs l, me, today
     where l.user_id = me.uid
       and l.logged_date = today.d
  )
  select jsonb_build_object(
    'hasSubmitted', exists (select 1 from logs where is_completed and revoked_at is null),
    'completedLog', (select to_jsonb(l) from logs l where l.is_completed and l.revoked_at is null limit 1),
    -- the entry taken back today, if any. The client shows it so the user can
    -- see exactly what was undone rather than having it vanish silently.
    'revokedLog',   (select to_jsonb(l) from logs l where l.revoked_at is not null limit 1),
    -- revoked_at IS NULL is load-bearing: a revoked row also has is_completed =
    -- false, so without this filter it would reappear as a "rejected attempt"
    -- and its POSITIVE points_awarded would be negated into a negative penalty.
    'rejectedAttemptsToday', (select count(*)::int from logs where not is_completed and revoked_at is null),
    -- points_awarded is negative for a penalty, so negate for a positive total
    'penaltyToday',  (select coalesce(-sum(l.points_awarded), 0)::int from logs l
                       where not l.is_completed and l.revoked_at is null),
    'utcNow',        to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'msUntilReset',  (
      extract(epoch from (
        (date_trunc('day', now() at time zone 'utc') + interval '1 day')
        - (now() at time zone 'utc')
      )) * 1000
    )::bigint
  );
$$;

-- ---------------------------------------------------------------------------
-- 11. PROFILE STATS  (dashboard aggregates, decay already applied by caller)
-- ---------------------------------------------------------------------------
create or replace function public.get_profile_stats(p_self_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  -- Every aggregate below filters on revoked_at IS NULL. A revoked row must not
  -- count anywhere: it is kept purely as an audit trail, so letting it into a
  -- total would resurrect points the user was already refunded.
  select jsonb_build_object(
    'totalLogs',    (select count(*)::int from public.daily_logs d
                       where d.user_id = u.uid and d.is_completed and d.revoked_at is null),
    'hardCount',    (select count(*)::int from public.daily_logs d
                       where d.user_id = u.uid and d.difficulty = 'Hard' and d.revoked_at is null),
    -- rejected attempts (spam / trivial entries), not completed days
    'rejectedCount',(select count(*)::int from public.daily_logs d
                       where d.user_id = u.uid and not d.is_completed and d.revoked_at is null),
    'penaltyTotal', (select coalesce(-sum(d.points_awarded), 0)::int from public.daily_logs d
                      where d.user_id = u.uid and not d.is_completed and d.revoked_at is null),
    -- longest run of consecutive COMPLETED days (gaps-and-islands).
    -- row_number() is computed in an inner query first: Postgres rejects a
    -- window function used directly inside GROUP BY.
    'bestStreak',   (select coalesce(max(run_len), 0)::int from (
                        select count(*)::int as run_len
                          from (
                            select d.logged_date,
                                   d.logged_date - (row_number() over (order by d.logged_date))::int as island
                              from public.daily_logs d
                             where d.user_id = u.uid
                               and d.is_completed
                               and d.revoked_at is null
                            ) numbered
                          group by numbered.island
                       ) s),
    'monthPoints',  (select coalesce(sum(points_awarded), 0)::int from public.daily_logs d
                      where d.user_id = u.uid
                        and d.revoked_at is null
                        and d.logged_date >= date_trunc('month', (now() at time zone 'utc'))::date),
    'last30Days',   (select coalesce(sum(points_awarded), 0)::int from public.daily_logs d
                      where d.user_id = u.uid
                        and d.revoked_at is null
                        and d.logged_date >= (now() at time zone 'utc')::date - 29),
    'submissionsThisMonth', (select count(*)::int from public.daily_logs d
                              where d.user_id = u.uid
                                and d.is_completed
                                and d.revoked_at is null
                                and d.logged_date >= date_trunc('month', (now() at time zone 'utc'))::date)
  )
  from (select coalesce(p_self_id, auth.uid()) as uid) u;
$$;

-- ---------------------------------------------------------------------------
-- 12. ROW LEVEL SECURITY  (defense in depth — the app uses the service role)
-- ---------------------------------------------------------------------------
alter table public.profiles   enable row level security;
alter table public.daily_logs enable row level security;
alter table public.feedback   enable row level security;

-- Profiles: world-readable (the leaderboard is public to signed-in users).
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated
  using (true);

-- Nobody edits their own points/tier/streak directly through PostgREST.
-- All mutations must go through submit_daily_log / apply_decay (SECURITY DEFINER).

-- Daily logs: private to their owner.
drop policy if exists "daily_logs_select_own" on public.daily_logs;
create policy "daily_logs_select_own"
  on public.daily_logs for select
  to authenticated
  using (user_id = auth.uid());

-- Feedback: append-only, own rows only.
--
-- WITH CHECK (user_id = auth.uid()) is the whole point of the policy. Without it
-- any authenticated user could file a report attributed to someone else — the
-- check constrains the row being INSERTED, not the caller's intent — which would
-- make the column actively untrustworthy for support. The API writes with the
-- service role and bypasses this entirely; the policy exists so the table is also
-- safe if it is ever reachable directly through PostgREST.
--
-- There is deliberately no SELECT, UPDATE or DELETE policy. That is not an
-- oversight: those verbs are denied to `authenticated` by default once RLS is on
-- and no policy covers them, which is what we want. A filed report cannot be
-- quietly edited into something else, and cannot be deleted by the person who
-- filed it and leave a gap in an abuse investigation.
drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own"
  on public.feedback for insert
  to authenticated
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 13. GRANTS
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.daily_logs to authenticated;

-- Feedback is INSERT-only for the app roles. Granting select would be a policy
-- decision the schema should not be making silently: RLS would still block reads
-- without a SELECT policy, but the grant is what decides whether the verb is even
-- considered, and "can insert" is the entire contract.
grant insert on public.feedback to authenticated;
grant execute on function public.get_tier_table()          to anon, authenticated;
grant execute on function public.tier_for_points(integer)  to anon, authenticated;

-- The service role bypasses RLS and owns everything else. Restrict the mutating
-- functions from the public roles so they can only run as the API's service role.
--
-- Only the PostgREST-reachable RPCs are listed. The three trigger functions
-- (handle_new_user, touch_updated_at, sync_profile_tier) deliberately keep
-- Postgres's default EXECUTE grant to PUBLIC: a trigger's privilege is checked
-- against the role that fires it, and that role is not always the table owner.
-- PATCH /api/profile updates profiles directly with the service-role key rather
-- than through a SECURITY DEFINER function, so profiles_touch_updated_at fires as
-- service_role — revoking its EXECUTE would make every username change fail with
-- "permission denied" rather than fail safe.
revoke all on function public.submit_daily_log(uuid, text, text, integer, text, text) from public;
revoke all on function public.apply_decay(uuid)                            from public;
revoke all on function public.reconcile_all_streaks()                     from public;
revoke all on function public.get_profile_stats(uuid)                     from public;
revoke all on function public.get_my_rank(text, uuid)                     from public;
revoke all on function public.get_leaderboard(text, integer, uuid)        from public;
revoke all on function public.get_today_status(uuid)                     from public;
revoke all on function public.revoke_today_log(uuid)                    from public;
revoke all on function public.recompute_streak(uuid)                    from public;

-- service_role keeps full access (it is the API's identity).
grant execute on function public.submit_daily_log(uuid, text, text, integer, text, text) to service_role;
grant execute on function public.apply_decay(uuid)                            to service_role;
grant execute on function public.reconcile_all_streaks()                     to service_role;
grant execute on function public.get_profile_stats(uuid)                     to service_role;
grant execute on function public.get_my_rank(text, uuid)                     to service_role;
grant execute on function public.get_leaderboard(text, integer, uuid)        to service_role;
grant execute on function public.get_today_status(uuid)                     to service_role;
grant execute on function public.revoke_today_log(uuid)                    to service_role;
grant execute on function public.recompute_streak(uuid)                    to service_role;

-- ---------------------------------------------------------------------------
-- 14. PREFLIGHT GUARD
-- ---------------------------------------------------------------------------
--  Runs last on purpose: if it fails, everything above has already been applied
--  cleanly and the failure is reported in the editor's own words.
do $$
declare
  v_tables text[] := array[
    'public.tiers', 'public.profiles', 'public.daily_logs', 'public.feedback'
  ];
  v_functions text[] := array[
    'public.tier_for_points(integer)',
    'public.get_tier_table()',
    'public.handle_new_user()',
    'public.touch_updated_at()',
    'public.sync_profile_tier()',
    'public.apply_decay(uuid)',
    'public.reconcile_all_streaks()',
    'public.submit_daily_log(uuid, text, text, integer, text, text)',
    'public.recompute_streak(uuid)',
    'public.revoke_today_log(uuid)',
    'public.get_leaderboard(text, integer, uuid)',
    'public.get_my_rank(text, uuid)',
    'public.get_today_status(uuid)',
    'public.get_profile_stats(uuid)'
  ];
  v_found   text;
  v_missing text[] := '{}';
begin
  -- Check tables/relations using to_regclass
  foreach v_found in array v_tables loop
    if to_regclass(v_found) is null then
      v_missing := v_missing || v_found;
    end if;
  end loop;

  -- Check functions using to_regprocedure
  foreach v_found in array v_functions loop
    if to_regprocedure(v_found) is null then
      v_missing := v_missing || v_found;
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'The Ascension schema did not fully apply. Missing: %',
      array_to_string(v_missing, ', ');
  end if;

  if not exists (select 1 from public.tiers) then
    raise exception 'public.tiers is empty. The insert of tier thresholds failed.';
  end if;

  -- The decay contract has to hold, or submissions fail at runtime with a type
  -- error that names neither function. apply_decay() returns jsonb
  -- {applied, profile}, and nothing in the database unpacks it: the SQL callers
  -- PERFORM it and read the row straight from public.profiles. The teardown in
  -- section 4b is what stops that from drifting, so these assertions are the
  -- second line of defence for anyone who patches the database by hand.
  --
  -- Compared with a case-INSENSITIVE pattern, never with `=`. pg_get_function_
  -- result re-renders the declaration in Postgres's own canonical form rather
  -- than echoing it back, and that form differs from what the file above says
  -- in ways that are not defects. For RETURNS TABLE it uppercases TABLE and
  -- drops the schema qualification, because public is on the search_path.
  --
  -- The first version of an assertion here compared against the lowercase string
  -- and therefore rejected a schema that had applied perfectly. An exact-match
  -- guard is worse than no guard: it fails on success, so it gets ignored, and
  -- then it protects nothing.
  if coalesce((
    select pg_get_function_result(p.oid)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'apply_decay'
      and p.pronargs = 1
  ), '') !~* '^jsonb$' then
    raise exception
      'public.apply_decay(uuid) must return jsonb {applied, profile}. Re-run the whole of this file';
  end if;

-- The installed BODIES have to be the ones in this file. Four deploys of this
  -- schema each installed cleanly and each failed later at submit time, because
  -- CREATE OR REPLACE FUNCTION cannot change a return type or re-type a
  -- parameter: the statement raised, the old body survived, and the callers were
  -- then rebuilt against the new contract. Postgres raises nothing at install
  -- time, and the symptom days later was a whole profiles record handed to a
  -- parameter expecting a uuid: a message pointing at a type, not at the drift.
  -- An assertion on declarations cannot see that. An assertion on the body can.
  --
  -- The check is deliberately narrow rather than a diff against this file. It
  -- forbids exactly the construct behind all four failures, one function's result
  -- set unpacked inside another, and requires the two callers to settle decay by
  -- discarding it. Everything else about those bodies is free to change.
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('submit_daily_log', 'revoke_today_log')
      and (
        -- line comments are stripped first: both callers document the forbidden
        -- constructs above them, by name, and must not trip their own guard
        regexp_replace(p.prosrc, '--[^\n\r]*', '', 'g')
          !~* 'perform\s+public\.apply_decay\s*\(\s*p_user_id\s*\)'
        or regexp_replace(p.prosrc, '--[^\n\r]*', '', 'g')
          ~* '(jsonb_populate_record|select\s+\*\s+into\s+\w+\s+from\s+public\.[a-z_]+\s*\()'
      )
  ) then
    raise exception
      'submit_daily_log() / revoke_today_log() must settle decay with PERFORM public.apply_decay(p_user_id) and then read public.profiles directly. An installed body that unpacks another function''s result is the drift behind the historical 22P02 and 42809 failures.';
  end if;

-- settle_decay() is gone. It existed for one deploy as a row-returning companion
  -- to apply_decay() and was deleted because keeping it meant keeping the
  -- unpacking. If it is present, someone re-created it by hand from a version of
  -- this file that no longer exists.
  if to_regprocedure('public.settle_decay(uuid)') is not null then
    raise exception
      'public.settle_decay(uuid) still exists. Decay has one implementation, apply_decay(), and its return value is read only by the API.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'feedback'
      and policyname = 'feedback_insert_own'
      and cmd        = 'INSERT'
  ) then
    raise exception 'RLS policy feedback_insert_own is missing from public.feedback.';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'feedback' and c.relrowsecurity
  ) then
    raise exception 'Row level security is not enabled on public.feedback.';
  end if;
end;
$$;

-- ============================================================================
--  Done. Next: add your keys to server/.env (see README) and start the API.
-- ============================================================================
