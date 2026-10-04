/**
 * Verify the deployed database against the contract this app depends on.
 *
 *   npm run db:verify                 read-only checks
 *   npm run db:verify -- <user-uuid>  also exercise decay for one user
 *
 * WHY THIS EXISTS
 *
 * The SQL Editor is the only way to install supabase/schema.sql, and it has no
 * dry-run mode: the script either finishes or reports the statement that stopped
 * it. That is enough to prove the file was PASTED. It is not enough to prove the
 * database is RUNNING it, and the difference cost this project four deploys.
 *
 * CREATE OR REPLACE FUNCTION cannot change a return type or re-type a parameter.
 * When a deploy changes one, that statement raises, the old body survives, and
 * every caller is then rebuilt against the new contract. Postgres raises nothing
 * at install time. Days later a submission fails with a message about a type:
 *
 *   invalid input syntax for type uuid: "(7999d4a4-...,mobin,,0,Novice,0,...)"
 *
 * That names a type and not the drift, which is what makes it expensive. So the
 * checks below are chosen for what they can prove through the API alone, with no
 * SQL editor in the loop — which is why they call RPCs rather than reading
 * catalogs. The preflight guard inside schema.sql reads pg_proc.prosrc directly
 * and is the stronger of the two; this is what is left when you cannot open the
 * editor.
 *
 * READ-ONLY, with one exception: --user calls apply_decay, which settles any
 * outstanding decay for that user. That is the same call GET /api/profile makes
 * on every read, it is idempotent, and it is the only way from here to reach the
 * code path the submission failure lived in. Everything else here only reads.
 */
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[key]) {
    console.error(`Missing ${key} in .env — cannot verify anything.`);
    process.exit(1);
  }
}

const { createClient } = await import('@supabase/supabase-js');
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let failures = 0;

/**
 * Run one check and report it as a line a human can act on.
 *
 * The failure text says what to DO, not only what was wrong. A diagnostic that
 * reports "OK: false" costs the reader a round trip; the reason this whole
 * project has a debug problem is that error messages described symptoms.
 */
async function check(label, assertion, run, remedy) {
  const { data, error } = await run();

  if (error) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${error.code ?? ''} ${error.message}`.trimEnd());
    if (error.details) console.error(`        ${error.details}`);
    console.error(`        -> ${remedy}`);
    return;
  }

  const problem = assertion(data);
  if (problem) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${problem}`);
    console.error(`        -> ${remedy}`);
  } else {
    console.log(`  PASS  ${label}`);
  }
}

console.log(`\nVerifying ${env.SUPABASE_URL}\n`);

console.log('Schema is installed');

await check(
  'the tier table is populated',
  (rows) =>
    Array.isArray(rows) && rows.length > 0
      ? null
      : `expected at least one tier, got ${JSON.stringify(rows)}`,
  () => db.rpc('get_tier_table'),
  'public.tiers is empty. Re-run supabase/schema.sql in full.'
);

// This is the read path behind the leaderboard and the rank pill. It returns
// rows built from several tables at once, so a partially applied schema tends to
// surface here before anywhere a user would notice.
await check(
  'the leaderboard query returns rows',
  (rows) => (Array.isArray(rows) ? null : `expected an array, got ${JSON.stringify(rows)}`),
  () => db.rpc('get_leaderboard', { p_filter: 'all_time', p_limit: 10, p_self_id: null }),
  'Re-run supabase/schema.sql in full.'
);

// Returns the number of rows it had to fix. Zero means decay has already settled
// everywhere, which is the steady state the app maintains on every profile read.
// A nonzero value means decay is landing late — usually a partial apply.
await check(
  'decay is settled for every profile',
  (n) =>
    typeof n === 'number' && n === 0
      ? null
      : `reconcile_all_streaks() fixed ${n} row(s), so decay was still pending`,
  () => db.rpc('reconcile_all_streaks'),
  'Re-run supabase/schema.sql in full, then run this again until it reports 0.'
);

const userId = process.argv[2];

if (!userId) {
  console.log(
    '\nPass a user uuid to also exercise decay:\n' +
      '  npm run db:verify -- 7999d4a4-6d72-459b-9355-0e710ad56f14\n'
  );
} else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
  failures += 1;
  console.error(`\n  FAIL  "${userId}" is not a uuid.`);
} else {
  console.log(`Decay path for ${userId} (settles any pending decay — idempotent)`);

  // The exact shape server/src/services/decay.js reads: data.applied decides
  // whether the streak-broke toast fires, data.profile.points redraws the header.
  // A payload missing either key is not a rendering nit — it is a contract
  // change between this file and that one, and it fails silently in the client.
  await check(
    'apply_decay returns { applied, profile }',
    (data) => {
      if (data === null || typeof data !== 'object') return `expected an object, got ${JSON.stringify(data)}`;
      if (typeof data.applied !== 'boolean') return `data.applied should be boolean, got ${typeof data.applied}`;
      if (typeof data.profile?.points !== 'number') return 'data.profile.points is missing';
      if (data.profile?.id !== userId) return `data.profile.id is ${data.profile?.id}, expected ${userId}`;
      return null;
    },
    () => db.rpc('apply_decay', { p_user_id: userId }),
    'The installed apply_decay does not match the wire format decay.js reads. ' +
      'Re-run supabase/schema.sql in full — the teardown in section 4b is what makes that deterministic.'
  );
}

console.log(
  failures === 0
    ? '\nAll checks passed.\n'
    : `\n${failures} check${failures === 1 ? '' : 's'} failed.\n`
);

process.exit(failures === 0 ? 0 : 1);