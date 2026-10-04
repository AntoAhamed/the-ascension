/**
 * Tests session teardown.
 *
 * Ending a session is a sequence, and a sequence is where this kind of code fails:
 * every individual line is right, and the bug is that one line is in the wrong
 * place or missing. The bug this suite exists for already shipped — DELETE
 * /api/profile succeeded, the app navigated to '/', the next page load read the
 * token still sitting in localStorage, re-authenticated as a user who no longer
 * existed, got a 401, and rendered "Could not reach the API" instead of the
 * sign-in screen. Nothing in that sequence failed loudly, and nothing about it
 * would show up in a build log.
 *
 * So the assertions below are about ORDER and COMPLETENESS, not about whether the
 * right functions are imported:
 *
 *   1. THE STORAGE PURGE ACTUALLY PURGES.
 *      Exercised against a fake storage, because this is the only part of the
 *      sequence with real logic in it: the key list has to match Supabase's real
 *      key shape (`sb-<project-ref>-auth-token`, whose ref the app cannot know) and
 *      has to leave other origins' keys alone.
 *
 *   2. THE ORDER IN AuthContext IS THE ORDER THE FIX DEPENDS ON.
 *      Asserted by position: token cleared before the request, Supabase's own
 *      sign-out before the purge it can undo, redirect last. Each of those is a
 *      silent regression if the lines get shuffled.
 *
 *   3. NEITHER FLOW CAN SKIP THE TEARDOWN.
 *      The delete flow has to issue its request first (it needs the token it is
 *      about to destroy) and only then end the session; the sign-out button has to
 *      go through a dialog. Both are ordering claims about code in two other
 *      files, which is precisely the thing a future refactor reorders by accident.
 *
 *   4. THE DIALOG IS SAFE TO CANCEL.
 *      Focus opens on the non-destructive action, and the destructive one is not
 *      autofocused — otherwise the Enter keypress that dismisses the dialog also
 *      confirms it.
 *
 * Runs against the real source files, not a copy, so it cannot drift.
 *
 *   node client/scripts/test-session-teardown.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

import { stripJsComments as stripComments } from '../../scripts/lib/strip-js-comments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(HERE, '..');
const readSrc = (...parts) => readFileSync(resolve(CLIENT, 'src', ...parts), 'utf8');
/** Dynamic import needs a file:// URL; a bare Windows path is rejected. */
const importSrc = (name) => import(pathToFileURL(resolve(CLIENT, 'src', 'lib', name)).href);

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

/**
 * Index of a needle in a haystack, optionally from an offset.
 *
 * Used for order assertions. An order claim that silently degrades to
 * "both substrings exist" is worse than no claim at all, because it reports
 * success on the exact regression it was written to catch.
 */
function at(haystack, needle, from = 0) {
  return haystack.indexOf(needle, from);
}

/**
 * Strip JS comments, leaving code and string literals intact.
 *
 * Lives in scripts/lib/strip-js-comments.mjs at the repo root, shared with
 * server/scripts/test-cors-origins.mjs. It was duplicated here first and that is
 * how the bug got in twice: a negative scan reads raw source and fires on the prose
 * documenting the thing it forbids, and a positive scan passes on prose instead of
 * on code. One implementation, one set of limitations, both tests fixed at once.
 */

/** A throwaway in-memory Storage, so tests never touch real localStorage. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    _map: map,
  };
}

const { purgeBrowserSession, isSessionKey, SESSION_KEY_PREFIXES, GUEST_STORAGE_KEY } =
  await importSrc('sessionPurge.js');

/* ------------------------------------------------------------------ */
/* 1. The purge removes this session and nothing else                  */
/* ------------------------------------------------------------------ */

group('The storage purge removes every session key, and no key it does not own');

{
  // The real key shape Supabase uses. The project ref is embedded in it, which is
  // precisely why an exact-key list cannot work: application code cannot know it.
  const storage = fakeStorage({
    'sb-abcdefghijklmnopqrst-auth-token': JSON.stringify({ access_token: 'eyJhb...' }),
    'sb-abcdefghijklmnopqrst-auth-token-code-verifier': 'pkce-abc',
    [GUEST_STORAGE_KEY]: JSON.stringify({ version: 1, logs: [] }),
    'asc.sound': 'off',
  });

  const result = purgeBrowserSession(storage);

  check('the persisted access token is removed', storage.getItem('sb-abcdefghijklmnopqrst-auth-token') === null);
  check('the PKCE verifier alongside it is removed', storage.getItem('sb-abcdefghijklmnopqrst-auth-token-code-verifier') === null);
  check('the guest session is removed', storage.getItem(GUEST_STORAGE_KEY) === null);
  check('app preferences are removed too', storage.getItem('asc.sound') === null);
  check('storage is left genuinely empty', storage.length === 0, `${storage.length} keys survived: ${[...storage._map.keys()].join(', ')}`);
  check('every removal is reported', result.removed.length === 4, `got ${result.removed.length}`);
}

{
  // The other half of the same claim. This origin may serve other apps, and
  // storage.clear() would take them with it.
  const storage = fakeStorage({
    'sb-abcdefghijklmnopqrst-auth-token': '{}',
    'some-other-app.settings': '{"theme":"dark"}',
    'third-party-widget': 'x',
  });

  const result = purgeBrowserSession(storage);

  check('another app on the same origin keeps its data', storage.getItem('some-other-app.settings') === '{"theme":"dark"}');
  check('a third unrelated key survives', storage.getItem('third-party-widget') === 'x');
  check('the session key is still removed', storage.getItem('sb-abcdefghijklmnopqrst-auth-token') === null);
  check('survivors are reported alongside removals', result.kept.length === 2 && result.removed.length === 1);
}

{
  // Prefix matching is what makes this survive a supabase-js upgrade adding a
  // key, and a key this app adds later. Asserted so the choice is explicit: a
  // test that only used the current keys would pass with either implementation.
  check('isSessionKey matches a Supabase token key', isSessionKey('sb-abc-auth-token') === true);
  check('isSessionKey matches a Supabase key on a different project', isSessionKey('sb-zzzzzzzzzzzzzzzzzzzz-auth-token') === true);
  check('isSessionKey matches the guest key', isSessionKey(GUEST_STORAGE_KEY) === true);
  check('isSessionKey rejects an unrelated key', isSessionKey('some-other-app.settings') === false);
  check('isSessionKey rejects a key that merely mentions us', isSessionKey('not-ascension.guest.v1') === false);
  check('isSessionKey rejects an empty key', isSessionKey('') === false);

  // The guest key is asserted rather than assumed: renaming GUEST_STORAGE_KEY
  // without updating the prefixes would orphan real guest data, and that failure
  // is invisible at runtime.
  check('the guest key is covered by the prefix list', isSessionKey(GUEST_STORAGE_KEY) === true);
  check('the prefix list is non-empty', SESSION_KEY_PREFIXES.length > 0);
}

{
  // A browser that throws on storage access must not turn a logout into a stuck
  // page. The redirect happens either way.
  check('a missing storage is a no-op, not a crash', purgeBrowserSession(null).removed.length === 0);
  const hostile = {
    get length() {
      throw new Error('SecurityError');
    },
    key: () => null,
    removeItem: () => {},
  };
  let threw = false;
  try {
    purgeBrowserSession(hostile);
  } catch {
    threw = true;
  }
  check('a hostile storage is contained', threw === false);
}

/* ------------------------------------------------------------------ */
/* 2. The teardown order in AuthContext                                */
/* ------------------------------------------------------------------ */

group('AuthContext ends a session in the order the fix depends on');

const authSource = stripComments(readSrc('context', 'AuthContext.jsx'));

{
  // Scope to endSession's body. Asserting against the whole file would let a
  // match from a sibling function satisfy the order checks.
  const start = at(authSource, 'const endSession = useCallback(');
  const end = at(authSource, '}, []);', start);
  check('endSession is defined', start !== -1);
  const body = start !== -1 && end !== -1 ? authSource.slice(start, end) : '';

  const tokenClear = at(body, "setAccessToken('')");
  const signOutCall = at(body, 'supabaseSignOut()');
  const purge = at(body, 'purgeBrowserSession()');
  // There are two purges on purpose — before and after the sign-out call — so
  // "purged before any network call" and "purged after it" are claims about two
  // different positions, not one. lastIndexOf is the one that has to follow the
  // sign-out, because that is the purge whose whole job is to erase whatever the
  // SDK may have just written back.
  const purgeAfter = body.lastIndexOf('purgeBrowserSession()');
  const redirect = at(body, 'window.location.href');

  check('the cached access token is cleared', tokenClear !== -1);
  check('Supabase is asked to revoke the refresh token', signOutCall !== -1);
  check('storage is purged', purge !== -1);
  check('storage is purged a second time', purgeAfter !== purge, 'one purge cannot both precede and follow the sign-out');
  check('a full page load follows', redirect !== -1);

  check(
    'the token is cleared BEFORE Supabase is signed out',
    tokenClear !== -1 && signOutCall !== -1 && tokenClear < signOutCall,
    `token@${tokenClear} signout@${signOutCall}`
  );
  check(
    'storage is purged again AFTER Supabase signs out, so it cannot re-persist a token',
    signOutCall !== -1 && purgeAfter !== -1 && purgeAfter > signOutCall,
    `signout@${signOutCall} lastPurge@${purgeAfter}`
  );
  check(
    'storage is purged BEFORE any network call, so no credential is on disk while one is pending',
    purge !== -1 && signOutCall !== -1 && purge < signOutCall,
    `firstPurge@${purge} signout@${signOutCall}`
  );
  check(
    'the redirect is LAST, after everything has been cleared',
    purgeAfter !== -1 && redirect !== -1 && redirect > purgeAfter,
    `lastPurge@${purgeAfter} redirect@${redirect}`
  );

  // The bound is the fix for a hang, and a hang is invisible to every other
  // check here: a plain `await` on a network call that never settles leaves the
  // purge and the redirect unreached, which is the original bug reappearing under
  // a slow connection instead of a stale bundle. Asserted by shape because
  // "waits forever" and "waits up to N ms" differ by exactly this much text.
  check('the sign-out wait is bounded, not an unbounded await', !/\bawait\s+supabaseSignOut\(\)/.test(body), 'a bare await hangs on a connection that never settles');
  check('the wait is raced against a timeout', /Promise\.race\(\[/.test(body));
  check('the timeout is a named constant, so the bound is visible and tunable', /SIGNOUT_GRACE_MS/.test(authSource));
  check('the grace period is defined', /const SIGNOUT_GRACE_MS = \d+;/.test(authSource));
  check(
    'a rejected sign-out does not abort the teardown',
    /supabaseSignOut\(\)\.catch\(/.test(body),
    'without this the race rejects, the await throws, and the purge and redirect are skipped'
  );
  check(
    'the redirect target is a named constant, not a bare path in a component',
    /const SIGNED_OUT_PATH =/.test(authSource)
  );

  // The old API surface. signOut() and deleteAccount() are what let two flows
  // each grow their own half-correct version of teardown.
  check('the old signOut() is gone from the context value', !/^\s{6}async signOut\(/m.test(authSource));
  check('the old deleteAccount() is gone from the context value', !/^\s{6}async deleteAccount\(/m.test(authSource));
  check('the old deleteAccount() is gone from the file entirely', !/async deleteAccount\(/.test(authSource));
  check('endSession is exposed to consumers', /^\s{6}endSession,/m.test(authSource));
  check('the unused api import is not carried along', !/import \{ api,/.test(authSource));
}

/* ------------------------------------------------------------------ */
/* 3. Neither flow can skip or reorder the teardown                    */
/* ------------------------------------------------------------------ */

group('Both flows route through endSession, in the right order');

const dashboard = stripComments(readSrc('pages', 'Dashboard.jsx'));

{
  const deleteBlock = dashboard.slice(
    at(dashboard, '<DeleteAccountModal'),
    at(dashboard, '</DeleteAccountModal>')
  );
  const deleteRequest = at(deleteBlock, 'api.profile.delete()');
  const teardown = at(deleteBlock, 'await endSession()');
  const requestSucceeds = at(deleteBlock, 'setDeleting(false);\n              return;');

  check('the delete modal is wired', deleteBlock.length > 0);
  check('the account is deleted with a request', deleteRequest !== -1);
  check('the session is ended after', teardown !== -1);
  check(
    'the DELETE request happens BEFORE the teardown, while the token still exists',
    deleteRequest !== -1 && teardown !== -1 && deleteRequest < teardown,
    `request@${deleteRequest} teardown@${teardown}`
  );
  check(
    'a failed request returns early and never tears the session down',
    requestSucceeds !== -1,
    'a rejected api.profile.delete() would fall through to endSession() and sign the user out with their account still live'
  );
  check(
    'no component assigns window.location directly any more',
    !/window\.location\.href\s*=\s*['"]/.test(dashboard),
    'a redirect here would bypass the storage purge that fixes the deleted-account bug'
  );

  check('endSession is pulled from the auth context', /const \{ endSession \} = useAuth\(\);/.test(dashboard));
  check('the sign-out modal is rendered', /<SignOutModal/.test(dashboard));
  check('the sign-out modal opens from the header', /onRequestSignOut=\{\(\) => setShowSignOut\(true\)\}/.test(dashboard));
  check('the sign-out modal ends the session on confirm', /onConfirm=\{async \(\) => \{\s*setSigningOut\(true\);[\s\S]*await endSession\(\);/.test(dashboard));
  check('the header receives onRequestSignOut', /onRequestSignOut=\{/.test(dashboard));
}

{
  const header = stripComments(readSrc('components', 'Header.jsx'));
  check('the header does not end sessions itself', !/const \{[^}]*\bendSession\b/.test(header), 'the header must only ask');
  check('the header destructures nothing it does not use', !/\bsignOut\b|\bdeleteAccount\b/.test(header));
  check('the sign-out button opens a dialog', /onClick=\{onRequestSignOut\}/.test(header));
  check('the button advertises that it opens a dialog', /aria-haspopup="dialog"/.test(header));
  check('the header no longer imports a session-ender it never calls', !/\{[^}]*\bsignOut\b[^}]*\} = useAuth\(\)/.test(header));
}

/* ------------------------------------------------------------------ */
/* 4. The confirmation dialog is safe to cancel                        */
/* ------------------------------------------------------------------ */

group('The log-out dialog cannot be confirmed by accident');

const signOutModal = stripComments(readSrc('components', 'SignOutModal.jsx'));

{
  check('the dialog is a modal to assistive tech', /role="dialog"/.test(signOutModal) && /aria-modal="true"/.test(signOutModal));
  check('it is labelled by its heading', /aria-labelledby="sign-out-title"/.test(signOutModal));
  check('the heading asks the question', /Are you sure you want to log out\?/.test(signOutModal));
  check('Escape closes it', /e\.key === 'Escape'/.test(signOutModal));
  check('focus is trapped inside it', /e\.key !== 'Tab'[\s\S]*preventDefault\(\)/.test(signOutModal));
  check('focus returns to the trigger on close', /previous\?\.focus\?\.\(\)/.test(signOutModal));
  // Scanned against comment-stripped source: the file explains at length why
  // window.confirm() is not used, and that explanation must not read as a use.
  check('no browser confirm() dialog is used', !/(^|[^.\w])confirm\(/.test(signOutModal));
  check('no native alert() is used either', !/(^|[^.\w])alert\(/.test(signOutModal));

  // The autofocus target is the whole safety argument for this dialog.
  const autofocus = /cancelRef\.current\?\.focus\(\)/.test(signOutModal);
  const confirmRef = /confirmRef\.current\?\.focus\(\)/.test(signOutModal);
  check('focus lands on the cancel button', autofocus);
  check('focus does NOT land on the confirm button', !confirmRef, 'a stray Enter would dismiss the dialog and sign out in one keystroke');
  check('cancel is offered alongside confirm', /Stay signed in/.test(signOutModal) && /Log out/.test(signOutModal));
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
