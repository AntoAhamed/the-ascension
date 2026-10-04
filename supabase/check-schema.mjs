/**
 * Static checks on supabase/schema.sql.
 *
 * These exist because the file is applied by pasting it into the Supabase SQL
 * Editor, which has no dry-run mode: by the time a mistake surfaces, you are
 * reading an error from the middle of a ~1000-line script and guessing which
 * statement produced it. Anything checkable without a database is checked here
 * instead.
 *
 * What is NOT checked, and cannot be: whether Postgres accepts the SQL. There is
 * no Postgres on the build machine. These are the invariants that a text scan can
 * actually establish — that the file is internally consistent, and that it does not
 * reintroduce a bug this project has already fixed once.
 *
 *   node supabase/check-schema.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, 'schema.sql'), 'utf8');

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    const line = detail ? `${label} -- ${detail}` : label;
    failures.push(line);
    console.log(`  FAIL  ${line}`);
  }
}

/**
 * A check that would pass on an empty set is not a check.
 *
 * The first version of this file asked "does every SECURITY DEFINER function pin
 * search_path?" and counted definers by searching function *bodies* for the
 * keyword. But `security definer` is part of a function's signature, which sits
 * before the opening `$$`, not inside it. The count came back zero, there was
 * nothing left to check, and the assertion reported PASS — having verified
 * nothing at all, on the one security boundary in the file.
 *
 * Empty is not the same as correct. Any assertion whose subject set can come back
 * empty must assert that it is not.
 */
function checkNonVacuous(label, subjects, extra = '') {
  check(
    `${label} (${subjects.length} subject${subjects.length === 1 ? '' : 's'}${extra})`,
    subjects.length > 0,
    'found 0 subjects — the assertion would pass without checking anything'
  );
}

const group = (title) => console.log(`\n${title}`);
const count = (text, re) => (text.match(re) ?? []).length;
const stripComments = (text) => text.replace(/--[^\n]*/g, '');

/**
 * Split the file into dollar-quoted blocks, keeping each block's opening statement.
 *
 * Splitting on `$$` is exact — Postgres sees the same delimiters — but a bare
 * split loses which function each body belongs to, and that association is what
 * half of these checks need. An UPDATE's safety depends on the function it lives
 * in; SECURITY DEFINER is declared in the signature, before the delimiter.
 *
 * The obvious alternative — stripping comments with a regex, then stripping string
 * literals — destroys this file. An apostrophe inside a comment ("the user's
 * streak") looks like the opening quote of a literal, gets paired with some
 * unrelated apostrophe hundreds of lines later, and the text between them (most of
 * the schema) is deleted. The result still scans happily and reports confident
 * nonsense, which is worse than not checking at all.
 *
 * @returns {{ top: string, blocks: Array<{ head: string, body: string }> }}
 */
function parseBlocks(input) {
  const parts = input.split('$$');

  if (parts.length % 2 === 0) {
    // An odd count of delimiters means a stray `$$` has paired across a function
    // boundary, and every association below would be wrong.
    throw new Error(
      `schema.sql has an unbalanced $$ delimiter (${parts.length - 1} found, expected an even count). ` +
        'Refusing to check a file whose structure cannot be parsed.'
    );
  }

  const top = [];
  const blocks = [];

  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) top.push(parts[i]);
    else blocks.push({ head: parts[i - 1], body: parts[i] });
  }

  return { top: top.join('\n'), blocks };
}

const { top: topRaw, blocks } = parseBlocks(src);
const top = stripComments(topRaw);

/** Everything a block owns: the statement that opened it plus the body it delimits. */
const owned = (block) => `${block.head}\n${block.body}`;

/**
 * The block's own signature — everything from the last CREATE FUNCTION to the `$$`.
 *
 * `head` runs from the previous block's closing delimiter to this one's opening
 * one, so it also contains whatever sat between them: the grants section, a
 * trailing comment, half a dozen revokes. That is enough for a stray
 * `SECURITY DEFINER` in a comment to read as a real signature, so the search has
 * to start at the CREATE FUNCTION itself.
 */
function signature(block) {
  const starts = [...block.head.matchAll(/create (?:or replace )?function\b|\bdo\b/gi)];
  const last = starts[starts.length - 1];
  return stripComments(last ? block.head.slice(last.index) : block.head);
}

const functions = blocks.filter((b) => /create (or replace )?function\b/i.test(b.head));
const doBlocks = blocks.filter((b) => /\bdo\s*$/i.test(b.head));

/* ------------------------------------------------------------------ */
/* Structural integrity                                                */
/* ------------------------------------------------------------------ */

group('The file is structurally sound');

{
  // A mismatched $$ would swallow the rest of the file into a string literal.
  // This is the single most damaging thing that can happen to a pasted script.
  // parseBlocks() throws on imbalance, so reaching here already proves it.
  const dollars = count(src, /\$\$/g);
  check(`dollar-quote markers are balanced (${dollars})`, dollars % 2 === 0, `${dollars} found`);

  check(
    `every dollar-quoted block is accounted for (${functions.length} functions, ${doBlocks.length} DO blocks)`,
    dollars === (functions.length + doBlocks.length) * 2,
    `${functions.length + doBlocks.length} blocks but ${dollars} markers`
  );

  checkNonVacuous('functions were found', functions);
  check('no U+FFFD replacement characters', !src.includes('\uFFFD'));

  // CRLF is harmless to Postgres, but it means the file was written by a tool that
  // will keep rewriting it that way, which then shows up as noise in every diff.
  check('line endings are LF', !src.includes('\r\n'));
}

group('Every function this application calls exists exactly once');

const REQUIRED_FUNCTIONS = [
  'tier_for_points',
  'get_tier_table',
  'handle_new_user',
  'touch_updated_at',
  'sync_profile_tier',
  'apply_decay',
  'reconcile_all_streaks',
  'submit_daily_log',
  'recompute_streak',
  'revoke_today_log',
  'get_leaderboard',
  'get_my_rank',
  'get_today_status',
  'get_profile_stats',
];

for (const fn of REQUIRED_FUNCTIONS) {
  const n = count(top, new RegExp(`create or replace function public\\.${fn}\\s*\\(`, 'g'));
  check(`${fn}() is defined`, n === 1, `found ${n}`);
}

group('The preflight guard agrees with the file');

{
  // The guard must never compare pg_get_function_result() with `=`. Postgres
  // re-renders the declaration in its own canonical form rather than echoing it,
  // and the canonical form is not what the file says:
  //
  //     written   returns table (applied boolean, profile public.profiles)
  //     reported  TABLE(applied boolean, profile profiles)
  //
  // TABLE is uppercased and the schema qualification is dropped because public is
  // on the search_path. A guard comparing against the lowercase literal rejects a
  // schema that applied perfectly — which is worse than having no guard at all,
  // because it fails on success and so gets trained out of the reader's trust
  // before it ever catches a real drift.
  //
  // This is not hypothetical: it is the failure this assertion was written after,
  // reported by the Supabase SQL Editor on an otherwise clean apply.
  const guardBlock = src.slice(src.search(/^do \$\$[\s\S]*?\$\$;/m) ?? 0);

  const resultReaders = [...guardBlock.matchAll(/pg_get_function_result\s*\(/gi)];
  checkNonVacuous('pg_get_function_result assertions were found to scan', resultReaders);

  const caseSensitive = resultReaders.filter((m) => {
    // The comparison follows the read, so look at what comes after it rather than
    // trying to bracket the expression precisely.
    const after = guardBlock.slice(m.index, m.index + 700);
    return /is\s+distinct\s+from\s+'|\)\s*=\s*'|<>\s*'/i.test(after);
  });
  check(
    `every pg_get_function_result assertion is case-insensitive (${resultReaders.length} reads)`,
    caseSensitive.length === 0,
    'Postgres canonicalises the text (TABLE uppercased, schema dropped) — use ~*'
  );

  check(
    'the canonical-form difference is documented in the guard',
    /pg_get_function_/i.test(guardBlock) && /(canonical|uppercase)/i.test(guardBlock),
    'the next reader will assume the reported text matches the file'
  );

  // The guard's expected shape must still describe what the file declares, or it
  // is asserting a contract nobody implements. Compared by column name rather than
  // by string equality: the guard's literal is a regex with escaped punctuation,
  // so diffing the two texts directly would just encode the escape sequences.
  const declaredReturn = blocks.find((b) =>
    /create or replace function\s+public\.apply_decay/i.test(b.head)
  );
  check('the guard names apply_decay', /proname\s*=\s*'apply_decay'/.test(guardBlock));
  check(
    "apply_decay's declared return type is what the guard expects",
    declaredReturn !== undefined && /returns jsonb/i.test(signature(declaredReturn)),
    'the guard asserts jsonb but the function declares something else'
  );

  // The guard has to be able to see body drift, not just declaration drift. Four
  // deploys each installed cleanly and each failed days later, so a guard that
  // only checks signatures reports success on exactly the failure it exists for.
  const bodyReads = [...guardBlock.matchAll(/prosrc|pg_get_functiondef/gi)];
  checkNonVacuous('installed-body reads were found to scan', bodyReads);
  check(
    'the guard inspects installed function bodies',
    /prosrc|pg_get_functiondef/i.test(guardBlock),
    'declaration assertions cannot see a stale body'
  );
  check(
    "the guard requires the PERFORM, not just the right signature",
    /perform\s+public\.apply_decay/i.test(stripComments(guardBlock)),
    'the guard must name the construct it forbids, or it protects nothing'
  );
}

{
  // The guard enumerates the objects it expects to find once the script has run.
  // If it names something the file never creates, every fresh project fails on the
  // very last statement — which reads as a broken script when nothing is actually
  // wrong with it, and costs an afternoon.
  //
  // Two arrays, because they are looked up differently: tables go through
  // to_regclass and functions through to_regprocedure. A single combined list
  // cannot work — to_regclass on a function name returns NULL, so every function
  // would be reported missing on a schema that applied perfectly. That is not
  // hypothetical: it is the message this check was written to catch, produced by
  // its own single-list version.
  const tableGuard = src.match(/v_tables text\[\] := array\[([\s\S]*?)\];/);
  const fnGuard = src.match(/v_functions text\[\] := array\[([\s\S]*?)\];/);

  check('the preflight guard lists tables', tableGuard !== null, 'v_tables not found');
  check('the preflight guard lists functions', fnGuard !== null, 'v_functions not found');

  if (tableGuard) {
    const tables = [...tableGuard[1].matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    checkNonVacuous('the guard lists tables', tables);
    check(
      'the guard checks tables with to_regclass',
      /to_regclass\(\s*v_found\s*\)/.test(src),
      'to_regclass is not used for the table list'
    );
    const missingTables = tables.filter(
      (n) => !new RegExp(`create table if not exists\\s+${n.replace('.', '\\.')}\\b`, 'i').test(top)
    );
    check(
      'every table the guard names is created by this file',
      missingTables.length === 0,
      `not created here: ${missingTables.join(', ')}`
    );
  }

  if (fnGuard) {
    // Functions carry their argument types in the guard because that is what
    // to_regprocedure matches on — an overload means two entries, and a missing
    // signature is a real defect rather than a cosmetic one.
    const fns = [...fnGuard[1].matchAll(/'([a-z_.]+\([^']*\))'/g)].map((m) => m[1]);
    checkNonVacuous('the guard lists functions', fns);
    check(
      'the guard checks functions with to_regprocedure',
      /to_regprocedure\(\s*v_found\s*\)/.test(src),
      'to_regprocedure is not used for the function list'
    );

    const notCreated = fns.filter((sig) => {
      const name = sig.slice(0, sig.indexOf('('));
      return !new RegExp(`create or replace function\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i').test(
        top
      );
    });
    check(
      'every function the guard names is created by this file',
      notCreated.length === 0,
      `not created here: ${notCreated.join(', ')}`
    );

    // …and the other direction, which the check above cannot see. A function the
    // file creates but the guard does not name is one the guard will not verify:
    // it installs, a half-applied database goes unnoticed, and nothing in the
    // script says so. Deleting a function is exactly the edit that produces this,
    // and settle_decay's removal left a stale entry behind until this ran.
    //
    // Non-vacuity is asserted over the CREATED set, not over the unlisted one:
    // here an empty result is the success condition, so treating it as an empty
    // subject set would fail every correct file for the right reason.
    const created = functions.map((b) =>
      signature(b).match(/function\s+(?:public\.)?(\w+)/i)?.[1]
    );
    checkNonVacuous(
      'created functions were found to scan',
      created.filter(Boolean)
    );
    const unguarded = created.filter(
      (name) => name && !fns.some((sig) => sig.startsWith(`public.${name}(`))
    );
    check(
      `every function this file creates is named by the guard (${unguarded.length} unlisted)`,
      unguarded.length === 0,
      `created but never verified: ${unguarded.join(', ')}`
    );
  }
}

group('Re-running the file is safe');

for (const re of [
  /create table if not exists public\.tiers/,
  /create table if not exists public\.profiles/,
  /create table if not exists public\.daily_logs/,
  /on conflict \(id\) do update/,
]) {
  check(`idempotent: ${re.source.slice(0, 50)}`, re.test(top));
}

for (const t of ['on_auth_user_created', 'profiles_touch_updated_at', 'profiles_sync_tier']) {
  check(`dropped before recreate: ${t}`, new RegExp(`drop trigger if exists ${t}`).test(top));
}

const policyDrops = count(top, /drop policy if exists/g);
const policyCreates = count(top, /^create policy/gm);
check(
  `policies are dropped before being recreated (${policyDrops} drops, ${policyCreates} creates)`,
  policyCreates > 0 && policyDrops === policyCreates,
  'a create policy without a matching drop would fail on re-run'
);

// CREATE OR REPLACE cannot change a function's return type, re-type a parameter
// or rename one. When a function's signature evolves, that statement raises and
// the OLD body survives — while the functions that call it are replaced with
// bodies written against the NEW signature. Nothing complains at install time;
// the mismatch surfaces days later as a type error in an unrelated request
// ("invalid input syntax for type uuid: (7999d4a4-...,mobin,,0,Novice,...)"),
// which is exactly the failure this file spent three deploys learning about.
//
// So every function is dropped and recreated. This reverses an earlier decision
// to prefer CREATE OR REPLACE, which was made for a good reason that turned out
// to be the lesser evil: a short window in which the function does not exist.
// Against that, a transaction either commits the whole new schema or none of it,
// so there is no instant at which half the file is installed — the reason
// "temporarily missing" is survivable and "permanently stale" is not.
const fnGuardList = [
  'tier_for_points(integer)',
  'get_tier_table()',
  'handle_new_user()',
  'touch_updated_at()',
  'sync_profile_tier()',
  'apply_decay(uuid)',
  'reconcile_all_streaks()',
  'submit_daily_log(uuid, text, text, integer, text, text)',
  'recompute_streak(uuid)',
  'revoke_today_log(uuid)',
  'get_leaderboard(text, integer, uuid)',
  'get_my_rank(text, uuid)',
  'get_today_status(uuid)',
  'get_profile_stats(uuid)',
];

const fnDrops = fnGuardList.filter((sig) =>
  new RegExp(`drop function if exists public\\.${sig.replace(/[()]/g, (m) => `\\${m}`)}\\s*;`, 'i').test(top)
);

checkNonVacuous('function teardowns were found to scan', fnDrops);
check(
  `every function is dropped before it is recreated (${fnDrops.length}/${fnGuardList.length})`,
  fnDrops.length === fnGuardList.length,
  `no drop statement for: ${fnGuardList.filter((s) => !fnDrops.includes(s)).join(', ')}`
);

// The teardown has to precede the first CREATE, or the drop cannot help the
// function it was meant to replace.
{
  const firstDrop = top.search(/drop function if exists/i);
  const firstCreate = top.search(/create (?:or replace )?function/i);
  check(
    'the teardown runs before any function is created',
    firstDrop !== -1 && firstCreate !== -1 && firstDrop < firstCreate,
    'a drop placed after a create is dead code'
  );
}

// Dropping a trigger function a trigger still depends on fails outright, so the
// triggers have to go first. This is the one ordering constraint that bites.
for (const t of ['on_auth_user_created', 'profiles_touch_updated_at', 'profiles_sync_tier']) {
  const dropTriggerAt = top.search(new RegExp(`drop trigger if exists ${t}`));
  const firstFnDrop = top.search(/drop function if exists/i);
  check(
    `the ${t} trigger is dropped before any function is dropped`,
    dropTriggerAt !== -1 && firstFnDrop !== -1 && dropTriggerAt < firstFnDrop,
    'DROP FUNCTION refuses to remove a function a live trigger still depends on'
  );
}

// Grants live at the end of the file, after the teardown, so a dropped-and-
// recreated function does not silently come back without them.
{
  const lastFnCreate = [...top.matchAll(/create (?:or replace )?function/gi)].pop()?.index ?? -1;
  const firstRevoke = top.search(/revoke all on function/i);
  const firstGrant = top.search(/grant execute on function/i);
  check(
    'privileges are (re)granted after every function is recreated',
    firstRevoke > lastFnCreate && firstGrant > lastFnCreate,
    'DROP FUNCTION also drops its grants, so these must come afterwards'
  );
}

check(
  'no column is added without IF NOT EXISTS',
  !/add column (?!if not exists)\s+\w+/i.test(top),
  'a plain `add column` would fail the second time this file is run'
);

/* ------------------------------------------------------------------ */
/* Regressions: bugs this project has already had                      */
/* ------------------------------------------------------------------ */

group('Does not reintroduce the 42P10 failure');

{
  // An UPDATE's target alias is not visible to a LATERAL subquery in its own FROM
  // list. This raised 42P10 on every leaderboard read and killed the decay sweep —
  // the single most expensive bug in this file's history.
  //
  // The rule is specific, not a blanket ban: a LATERAL in a plain SELECT is legal,
  // and get_leaderboard() uses one legitimately to aggregate a monthly score per
  // profile. What is illegal is LATERAL inside an UPDATE's own FROM list, where it
  // would have to reference the target alias.
  const updates = blocks.flatMap((b) => stripComments(b.body).match(/update\s+public\.\w+[\s\S]*?;/gi) ?? []);
  const offenders = updates.filter((stmt) => /\blateral\b/i.test(stmt));

  checkNonVacuous('UPDATE statements were found to scan', updates);
  check(
    'no LATERAL inside any UPDATE statement',
    offenders.length === 0,
    `${offenders.length} UPDATE(s) reference a lateral subquery`
  );

  check('no `cross join lateral` anywhere', !/cross join lateral/i.test(src));
  check('the 42P10 cause is documented for the next reader', /42P10|target alias/i.test(src));
}

group('A SQL fault names the statement that caused it');

{
  // Every plpgsql body re-raises with PG_EXCEPTION_CONTEXT attached. Postgres puts
  // the failing statement, its line number and every nested frame in there, which
  // is the entire difference between "invalid input syntax for type uuid" (three
  // deploys of guessing) and a filename and line.
  const plpgsql = blocks.filter((b) => /language\s+plpgsql/i.test(signature(b)));

  checkNonVacuous('plpgsql functions were found to scan', plpgsql);

  const nameOf = (b) => b.head.match(/create (?:or replace )?function\s+([\w.]+)/i)?.[1] ?? '?';

  const silent = plpgsql.filter((b) => !/pg_exception_context/i.test(b.body));

  check(
    `every plpgsql function re-raises with its stack (${plpgsql.length} functions)`,
    silent.length === 0,
    `no context handler: ${silent.map(nameOf).join(', ')}`
  );

  const duplicated = plpgsql.filter((b) => (b.body.match(/pg_exception_context/gi) ?? []).length > 1);
  check(
    'the handler appears exactly once per body',
    duplicated.length === 0,
    `duplicated in: ${duplicated.map(nameOf).join(', ')}`
  );

  // The subtle one. `raise exception '...'` without an explicit errcode REPLACES
  // the SQLSTATE with P0001, so translateDbError() could no longer tell
  // P0002 (profile missing -> 404) from P0003 (nothing to revoke -> 409) and both
  // collapsed into "already submitted today" -> 409. Preserving it is load-bearing.
  const handler = plpgsql.filter((b) =>
    /raise\s+exception\s+using[\s\S]{0,160}?errcode\s*=\s*v_state/i.test(stripComments(b.body))
  );
  check(
    `every handler carries the original SQLSTATE over (${handler.length}/${plpgsql.length})`,
    handler.length === plpgsql.length,
    `SQLSTATE is lost in: ${plpgsql.filter((b) => !handler.includes(b)).map(nameOf).join(', ')}`
  );

  const renamed = plpgsql.filter(
    (b) => /get\s+stacked\s+diagnostics[\s\S]{0,200}?=\s*returned_sqlstate/i.test(stripComments(b.body))
  );
  check(
    'every handler reads returned_sqlstate',
    renamed.length === plpgsql.length,
    `missing in: ${plpgsql.filter((b) => !renamed.includes(b)).map(nameOf).join(', ')}`
  );

  // An exception block makes its statements run in a subtransaction, so a bare
  // `when others then null` would swallow a business rule and report success.
  const swallowed = plpgsql.filter(
    (b) => /when\s+others\s+then\s*null\s*;/i.test(stripComments(b.body))
  );
  check(
    'no handler swallows an error',
    swallowed.length === 0,
    `swallowed in: ${swallowed.map(nameOf).join(', ')}`
  );
}

group('Decay has one implementation and one wire format');

{
  // apply_decay() returns jsonb {applied, profile} because Node needs to know
  // whether decay charged anything. Routing the SQL callers through that same
  // payload meant converting public.profiles -> jsonb -> public.profiles between
  // two functions in the same transaction, and each leg failed differently:
  //
  //   22P02  invalid input syntax for type uuid: "{\"applied\":false,...}"
  //   42809  column notation .profile applied to type jsonb
  //   22P02  invalid input syntax for type uuid: "(7999d4a4,...,mobin,,0,...)"
  //
  // Four deploys made that attempt in three spellings, and the failure MOVED
  // rather than going away — each fix changed the line number and the error code
  // and left the shape intact. A moving error is the signature of one shared
  // assumption, not of four separate bugs, and the assumption was that a
  // function can consume another's result set by picking a column out of it.
  //
  // So the SQL callers no longer read apply_decay()'s output at all. They PERFORM
  // it, which discards the result, then read the row from public.profiles. These
  // assertions make that structural, so neither the unpacking nor a second decay
  // entry point can return in an otherwise well-meaning edit.
  // Scanned over `top` plus the FUNCTION blocks, deliberately not over `blocks`.
  // The preflight guard is itself a dollar-quoted block, and it has to name the
  // constructs it forbids — jsonb_populate_record, select * into — inside regex
  // literals. Scan `blocks` and every one of those negative assertions fires on
  // the text that documents them: the guard would be the first place in the file
  // to reintroduce the bug it exists to prevent. `top` still covers the DDL and
  // the statements between functions, so nothing outside a function escapes.
  const allCode = stripComments(src);
  const sqlOnly = stripComments([top, ...functions.map((b) => b.body)].join('\n'));
  const bodies = functions.map((b) => stripComments(b.body));

  // 1. Decay has two SQL entry points and no more: the per-user RPC the API
  //    calls, and the set-based sweep the cron calls. A third would be a third
  //    place for the rule to live.
  //
  //    Selected through signature(), not head(). `head` spans from the previous
  //    block's closing delimiter to this one's opening one, so it carries the
  //    comments in between — and the comment above sync_profile_tier lists every
  //    writer of current_tier by name, which made the tier trigger register as a
  //    decay function. An assertion whose subject set is assembled from
  //    neighbouring prose is asserting that the prose is accurate.
  const decayFns = functions.filter((b) =>
    /function public\.(apply_decay|settle_decay|reconcile_all_streaks)\b/i.test(signature(b))
  );
  const names = decayFns.map((b) => signature(b).match(/function public\.(\w+)/i)?.[1] ?? '?');
  checkNonVacuous('decay functions were found to scan', decayFns);
  check(
    `decay is reached through exactly two functions (${names.sort().join(', ')})`,
    decayFns.length === 2 &&
      names.includes('apply_decay') &&
      names.includes('reconcile_all_streaks') &&
      !names.includes('settle_decay'),
    `found ${decayFns.length}: ${names.join(', ') || 'none'}`
  );

  // 2. apply_decay stays the jsonb entry point for the API.
  check(
    'apply_decay(uuid) returns jsonb',
    /create or replace function\s+public\.apply_decay\(p_user_id uuid\)\s*returns jsonb/i.test(allCode),
    'decay.js reads data.applied off this RPC; a different return shape breaks it'
  );

  // 3. settle_decay() must not come back. It is dropped in the teardown and
  //    asserted absent by the preflight guard, so a copy left in someone's
  //    database cannot survive as a second, uncalled entry point to one rule.
  check(
    'settle_decay is not created anywhere in the file',
    !/create\s+(or\s+replace\s+)?function\s+public\.settle_decay/i.test(allCode),
    'a second entry point to one rule is a second thing to disagree about'
  );
  check(
    'the teardown still drops a copy of settle_decay left by an earlier deploy',
    /drop function if exists public\.settle_decay\(uuid\)/i.test(top),
    'installs no longer converge: the old function stays forever'
  );

  // 4. The assertion that closes the bug class. Inside a transaction, decay is
  //    settled by DISCARDING its result, never by reading it — so there is no
  //    result shape for a caller and a callee to disagree about, and no way to
  //    hand a composite to a uuid parameter by accident.
  const callSites = bodies.flatMap((body) =>
    [...body.matchAll(/(perform|select)\s+public\.(apply_decay|settle_decay)\s*\(/gi)].map((m) =>
      m[1].toLowerCase()
    )
  );

  checkNonVacuous('in-transaction decay call sites were found to scan', callSites);
  check(
    `every in-transaction decay call PERFORMs its result away (${callSites.length} sites)`,
    callSites.length === 2 && callSites.every((c) => c === 'perform'),
    `${callSites.filter((c) => c === 'select').length} site(s) read a result set instead of discarding it`
  );

  // 5. And each of those two callers then reads the settled row from the table,
  //    with the statement shape this file has used successfully all along.
  const inTransaction = functions.filter((b) =>
    /function public\.(submit_daily_log|revoke_today_log)\b/i.test(signature(b))
  );
  check(
    'both in-transaction decay callers exist',
    inTransaction.length === 2,
    `found ${inTransaction.length}`
  );

  const noTableRead = inTransaction.filter(
    (b) =>
      !/select\s+\*\s+into\s+v_profile\s+from\s+public\.profiles\s+where\s+id\s*=\s*p_user_id\s+for update/i.test(
        stripComments(b.body)
      )
  );
  check(
    'each caller reads the settled row straight from public.profiles',
    noTableRead.length === 0,
    `no plain row read in: ${noTableRead
      .map((b) => signature(b).match(/function public\.(\w+)/i)?.[1] ?? '?')
      .join(', ')}`
  );

  // 6. No conversion artefact is left lying around.
  check(
    'no jsonb -> row conversion remains in the schema',
    !/jsonb_populate_record/i.test(sqlOnly),
    'jsonb_populate_record was the third attempt at this and the wrong one'
  );
  check(
    'no composite notation applied to a jsonb value',
    !/\(\s*\w+\s*\)\s*\.\s*\w+\s*from\s+\(\s*select\s+public\./i.test(sqlOnly),
    '(alias).field does not resolve on jsonb (42809)'
  );
  check(
    'no function-call result is unpacked into a row anywhere',
    !/select\s+\*\s+into\s+\w+\s+from\s+public\.\w+\s*\(/i.test(sqlOnly),
    'the payload will be coerced into a profiles row (22P02)'
  );

  // 7. The two SQLSTATEs are recorded, so the next reader can grep for them
  //    instead of re-deriving them from a bug report.
  check(
    'the decay conversion failures are documented in the file',
    /22P02/.test(src) && /42809/.test(src),
    'the reason for the design is not recorded where the design is'
  );

  // 8. Node is the only consumer of the wire format, so the design is worth
  //    nothing if the API stopped reading it. This reads across into the server,
  //    which is the point: the two files are one contract.
  const decayService = readFileSync(resolve(HERE, '../server/src/services/decay.js'), 'utf8');
  check(
    'the API still calls apply_decay and reads .applied',
    /rpc\(\s*'apply_decay'/.test(decayService) && /data\?\.applied/.test(decayService),
    'decay.js and schema.sql have drifted apart'
  );
  check(
    'the API never calls the in-transaction decay path',
    !/settle_decay/.test(decayService),
    'the wire format exists for this caller; bypassing it duplicates the contract'
  );
}

group('Decay settlement stays idempotent');

{
  // Neither decay function used to advance last_submission_date, so the missed-day
  // count was recomputed identically on every call and 30 x N was subtracted again
  // from an already-decayed balance. Because decay settles on every profile read,
  // one missed day became a drain proportional to how often the page was opened.
  //
  // Selected by name, not by a shared variable. The first version of this check
  // grepped for `v_missed`, which only apply_decay uses — reconcile_all_streaks
  // computes the same quantity as a CTE column named `missed_days` — so half the
  // subject set silently went unexamined while the assertion still reported PASS.
  // The two functions are named explicitly so that adding a third decay path is a
  // test failure rather than a silent gap.
  /** The function's own name, from its signature rather than anywhere in the head. */
  const nameOf = (b) => signature(b).match(/function\s+(?:public\.)?(\w+)/i)?.[1] ?? '?';

  const decay = functions.filter((b) =>
    /function public\.(apply_decay|reconcile_all_streaks)\b/i.test(signature(b))
  );
  check(
    'both decay implementations are under test',
    decay.length === 2,
    `found ${decay.length}: ${decay.map(nameOf).join(', ') || 'none'}`
  );

  // Neither may delegate the arithmetic. This check once asserted the opposite —
  // that apply_decay was a thin wrapper around settle_decay holding no decay
  // arithmetic — which was true for one deploy and then described a function
  // that no longer existed. Naming a wrapper here would assert that a function
  // containing no arithmetic advances a cursor, and the first run of exactly
  // that reported precisely this, which is how a stale name survives review.
  //
  // Written as "neither calls the other" rather than "both contain 30 *" because
  // the two implement the rule in different shapes — one in plpgsql variables,
  // one in a CTE — and an arithmetic-shape assertion can only match one of them.
  // Delegation is the failure worth catching; a shared constant is not.
  const delegating = decay.filter((b) =>
    /public\.(apply_decay|reconcile_all_streaks|settle_decay)\s*\(/i.test(stripComments(b.body))
  );
  check(
    'each decay implementation holds the rule itself, rather than delegating',
    delegating.length === 0,
    `delegates instead: ${delegating.map(nameOf).join(', ')}`
  );

  const stuck = decay.filter((b) => !/last_submission_date\s*=\s*v_today\s*-\s*1/i.test(b.body));
  check(
    'every decay function advances the settlement cursor',
    stuck.length === 0,
    `no cursor advance in: ${stuck.map(nameOf).join(', ')}`
  );

  // Zeroing the streak in the same statement is what makes advancing the cursor
  // safe: submit_daily_log restarts on a zero streak, so settle-then-submit yields
  // 1 rather than N+1. A cursor advance without the streak reset is the same
  // compounding bug wearing a different hat.
  //
  // Measured over `decay`, not over `cursors`: if the cursor check above already
  // failed, subtracting two subsets of one another produces a negative count and
  // a message like "-1 functions do not zero the streak", which reads as nonsense
  // and sends the reader looking for a bug in the checker instead of in the schema.
  const notZeroed = decay.filter((b) => !/current_streak\s*=\s*0/i.test(b.body));
  check(
    'every decay function resets the streak alongside the cursor',
    notZeroed.length === 0,
    `no streak reset in: ${notZeroed.map(nameOf).join(', ')}`
  );

  check('the idempotency reasoning is documented', /IDEMPOTENT|idempotent/i.test(src));
}

group('Rank is always derived from points');

{
  // The bug this guards: a 7,000-point demotion to 6,400 kept showing
  // "Apex Luminary" because the label was copied off an already-stale read.
  const sync = functions.find((b) => /new\.current_tier/.test(b.body));
  check('the tier-sync trigger exists', sync !== undefined);
  check(
    'it derives the tier from points, not from a stored label',
    sync !== undefined &&
      /current_tier\s*:?=\s*public\.tier_for_points\(\s*new\.points\s*\)/i.test(sync.body)
  );
  check(
    'it is a BEFORE trigger, so the stored value is already correct on write',
    /before insert or update/i.test(top)
  );

  // Every write to current_tier must be one of two shapes: a direct call to
  // tier_for_points, or a variable that was itself assigned from one. Anything
  // else is a label travelling from somewhere it may already be stale.
  const allCode = [top, ...blocks.map(owned)].join('\n');
  const writes = [...allCode.matchAll(/current_tier\s*:?=([^,;\n]*)/gi)].map((m) => m[1].trim());
  const derived = writes.filter((rhs) => /tier_for_points\(/i.test(rhs) || /^\w+$/.test(rhs));
  checkNonVacuous('current_tier assignments were found', writes);
  check(
    'every current_tier write is a tier_for_points call or a variable holding one',
    derived.length === writes.length,
    `untraceable: ${writes.filter((w) => !derived.includes(w)).join(' | ')}`
  );

  // …and those variables must themselves come from points, which is the step the
  // check above deliberately allows rather than proving.
  const varAssigns = [...allCode.matchAll(/v_new_tier\s*:?=\s*([^;\n]*)/gi)].map((m) => m[1].trim());
  check(
    `v_new_tier is always derived from tier_for_points (${varAssigns.length} sites)`,
    varAssigns.length > 0 && varAssigns.every((rhs) => /tier_for_points\(/i.test(rhs)),
    varAssigns.filter((r) => !/tier_for_points\(/i.test(r)).join(' | ') || 'none found'
  );

  check(
    'the API derives rank rather than reading the stored column',
    /getTierForPoints/.test(
      readFileSync(resolve(HERE, '..', 'server', 'src', 'routes', 'leaderboard.js'), 'utf8')
    )
  );
}

group('The daily window is UTC everywhere');

{
  // `current_date` and `now()::date` resolve in the SESSION time zone, which
  // happens to be UTC on Supabase but is not guaranteed to stay that way. A player
  // in Auckland and one in Los Angeles must share the same 24-hour day.
  //
  // Scanned in executable code only. The header names both of these expressions
  // while explaining why to avoid them, and flagging the documentation of a bug as
  // the bug is how a test becomes noise nobody reads.
  const executable = stripComments([top, ...blocks.map((b) => b.body)].join('\n'));

  check('no bare current_date in executable code', !/\bcurrent_date\b/i.test(executable));
  check('no now()::date in executable code', !/now\(\)\s*::\s*date/i.test(executable));

  check(
    'the session time zone is pinned rather than assumed',
    /set\s+timezone\s+to\s+'utc'/i.test(top),
    "expected `set timezone to 'utc'` — Supabase lets the project default be changed from the dashboard"
  );

  const explicit = count(executable, /now\(\) at time zone 'utc'/gi);
  check(`day boundaries are explicitly UTC (${explicit} sites)`, explicit >= 8, `${explicit} found`);
}

group('Privileges stay locked down');

{
  // Every mutating function is SECURITY DEFINER, so it bypasses RLS. Leaving one
  // executable by anon/authenticated would let anyone call it through PostgREST and
  // award themselves points.
  const revokes = count(top, /^revoke all on function public\./gim);
  check(`every mutating RPC is revoked from public (${revokes})`, revokes >= 9, `${revokes} found`);

  check(
    'service_role is explicitly re-granted',
    count(top, /grant execute on function public\..*to service_role/gi) >= 9
  );

  // Compared per-function rather than by counting tokens globally: a global count
  // passes even when one function declares SECURITY DEFINER without pinning
  // search_path and a different, innocent function carries the setting. The
  // exposure is per-function, so the assertion has to be too.
  //
  // Read from the head, where the keyword actually lives. Every clause of a
  // function signature precedes its opening $$.
  const definers = functions.filter((b) => /security definer/i.test(signature(b)));
  checkNonVacuous('SECURITY DEFINER functions were found', definers);

  const unpinned = definers.filter((b) => !/set search_path/i.test(signature(b)));
  check(
    'every SECURITY DEFINER function pins search_path',
    unpinned.length === 0,
    unpinned.map((b) => signature(b).match(/function\s+(?:public\.)?(\w+)/i)?.[1] ?? '?').join(', ')
  );

  // Named per table rather than counted. A bare count of 2 silently passed while
  // RLS was missing on the newest table and enabled twice on an old one; asserting
  // the exact set means adding a table without protecting it is a failure here
  // rather than a production incident.
  const rlsTables = new Set(
    [...top.matchAll(/alter table (public\.\w+)\s+enable row level security/gi)].map((m) =>
      m[1].toLowerCase()
    )
  );
  const userTables = ['public.profiles', 'public.daily_logs', 'public.feedback'];
  const missingRls = userTables.filter((t) => !rlsTables.has(t));
  check(
    'RLS is enabled on every user table',
    missingRls.length === 0,
    `not protected: ${missingRls.join(', ')}`
  );
  checkNonVacuous('RLS statements were found', [...rlsTables]);

  // The feedback table is the newest one and the easiest to add half-secured: an
  // INSERT policy with no RLS enabled does nothing at all, and the endpoint still
  // passes its own tests because the API writes with the service role. These two
  // assertions exist specifically so that cannot ship.
  check(
    'feedback RLS is explicitly enabled',
    /alter table public\.feedback\s+enable row level security/i.test(src)
  );
  check(
    'the feedback INSERT policy constrains user_id to the caller',
    /feedback_insert_own[\s\S]*?for insert[\s\S]*?with check \(\s*user_id = auth\.uid\(\)/i.test(src)
  );
  check(
    'trigger functions keep the default EXECUTE grant (revoking it breaks service_role writes)',
    /deliberately keep[\s\S]*?default EXECUTE grant/i.test(src)
  );
}

group('No user data is seeded');

{
  // A freshly-migrated database must be genuinely empty, or the first real user is
  // competing against fiction.
  //
  // Only top-level statements count. handle_new_user() and submit_daily_log()
  // contain INSERTs by definition — that is what they are for, and flagging them
  // would be flagging the application working.
  const inserts = [...top.matchAll(/insert into (public\.\w+|auth\.\w+)/gi)].map((m) => m[1]);
  const unexpected = inserts.filter((t) => !/^public\.tiers$/i.test(t));

  checkNonVacuous('seeded rows were found', inserts, '');
  check(
    'the only seeded rows are tier thresholds',
    unexpected.length === 0,
    `also seeds: ${unexpected.join(', ')}`
  );

  check('no literal user emails', !/@(gmail|outlook|yahoo|hotmail|example)\./i.test(src));
  check(
    'no hardcoded uuid literals',
    !/['"][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"]/i.test(src)
  );
  check('all seven tier thresholds are present', count(top, /\('?'[a-z]+'?,\s*'/g) >= 7);
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
