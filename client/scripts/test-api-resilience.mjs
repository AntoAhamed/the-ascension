/**
 * The cold-start contract.
 *
 * The API sleeps when idle, and the first request after idle can hang for the
 * better part of a minute before the instance boots. The bug report that
 * prompted this file was "signed up fine, then immediately 'Could not reach the
 * API'" — authentication is Supabase-side and always works; the profile fetch
 * that follows it was dying against a waking server.
 *
 * The fix has three parts and all three are tested here:
 *
 *   1. fetchWithRetry gives every request a per-attempt timeout long enough to
 *      outlast a normal boot, and retries the failures a waking proxy produces:
 *      network rejection, timeout, 502/503/504. Tested BEHAVIOURALLY with a
 *      stub fetch and a fake sleep, because a retry policy that has never been
 *      observed retrying is a hypothesis, not a feature.
 *
 *   2. api.warmup() pings the public health endpoint, without a token, at app
 *      start — the boot cost is paid while the visitor reads the sign-in form.
 *      Tested statically (api.js cannot be imported here: import.meta.env) plus
 *      behaviourally for the parts that are importable.
 *
 *   3. A production bundle with no VITE_API_URL can no longer be built at all.
 *      That was the deployable version of this bug: auth fine, every API call
 *      sent to the static host. Tested by calling the real
 *      assertClientEnvForBuild with fake env maps.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { stripJsComments } from '../../scripts/lib/strip-js-comments.mjs';
import {
  fetchWithRetry,
  maxAttemptsFor,
  RETRYABLE_STATUSES,
  REQUEST_TIMEOUT_MS,
} from '../src/lib/fetchWithRetry.js';
import { ApiError } from '../src/lib/apiError.js';
import { assertClientEnvForBuild } from '../vite.config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function eq(label, actual, expected) {
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const fakeRes = (status) => ({ status, ok: status >= 200 && status < 300 });
const networkFail = () => Promise.reject(new TypeError('fetch failed'));
const instant = () => Promise.resolve();

/**
 * A fetch that never answers but honours the abort signal — which is what a
 * real fetch does when a connection is held open. A stub that ignores abort
 * would hang forever and proves nothing about the timeout.
 */
const hangUntilAborted = (_url, init) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });

/** A sleep that records its delays and resolves immediately. */
function recordingSleep(delays) {
  return (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
}

async function expectNetworkError(promise, label) {
  try {
    await promise;
    check(label, false, 'resolved instead of rejecting');
  } catch (err) {
    check(label, err instanceof ApiError && err.code === 'NETWORK', `got ${err?.name}: ${err?.message}`);
    return err;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 1. The happy path costs exactly one fetch
 * ------------------------------------------------------------------ */

{
  let calls = 0;
  const res = await fetchWithRetry({
    url: 'https://api.test/api/profile',
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(fakeRes(200));
    },
    sleep: instant,
  });
  eq('a 200 on the first try is returned', res.status, 200);
  eq('a 200 on the first try costs one fetch', calls, 1);
}

/* ------------------------------------------------------------------ *
 * 2. Retryable failures are retried, with backoff, then returned
 * ------------------------------------------------------------------ */

{
  // Two network rejections then success (a GET: 3 attempts available).
  let calls = 0;
  const delays = [];
  const res = await fetchWithRetry({
    url: 'https://api.test/api/profile',
    fetchImpl: () => {
      calls += 1;
      return calls < 3 ? networkFail() : Promise.resolve(fakeRes(200));
    },
    sleep: recordingSleep(delays),
  });
  eq('network rejections then a 200 resolves', res.status, 200);
  eq('it cost three fetches', calls, 3);
  eq('the backoff schedule was 1.5s then 4s', JSON.stringify(delays), JSON.stringify([1500, 4000]));
}

for (const status of [502, 503, 504]) {
  let calls = 0;
  const res = await fetchWithRetry({
    url: 'https://api.test/api/profile',
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(fakeRes(calls === 1 ? status : 200));
    },
    sleep: instant,
  });
  eq(`a ${status} is retried and the later 200 returned`, res.status, 200);
  eq(`a ${status} cost two fetches`, calls, 2);
  check(`${status} is in the retryable set`, RETRYABLE_STATUSES.has(status));
}

{
  // A final 502 after all attempts is RETURNED, not thrown — the caller parses
  // the error body like any other response.
  const res = await fetchWithRetry({
    url: 'https://api.test/api/profile',
    fetchImpl: () => Promise.resolve(fakeRes(502)),
    sleep: instant,
  });
  eq('a persistent 502 comes back as a response for the caller to parse', res.status, 502);
}

{
  // Everything else is final on the first answer: 400, 401, 404, 409, 500.
  for (const status of [400, 401, 404, 409, 500]) {
    let calls = 0;
    const res = await fetchWithRetry({
      url: 'https://api.test/api/profile',
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(fakeRes(status));
      },
      sleep: instant,
    });
    eq(`a ${status} is not retried`, calls, 1);
    eq(`a ${status} is returned as-is`, res.status, status);
  }
}

{
  // Persistent network failure: GET exhausts 3 attempts, then NETWORK.
  let calls = 0;
  const err = await expectNetworkError(
    fetchWithRetry({
      url: 'https://api.test/api/profile',
      fetchImpl: () => {
        calls += 1;
        return networkFail();
      },
      sleep: instant,
    }),
    'persistent network failure rejects with a NETWORK ApiError'
  );
  eq('a GET made exactly 3 attempts', calls, 3);
  eq('the failure says why', err?.details?.reason, 'network');
  check('the message mentions the server may be starting', /starting up|waking/i.test(err?.message ?? ''));
}

/* ------------------------------------------------------------------ *
 * 3. Mutations get fewer attempts (duplicate-safe by schema backstop)
 * ------------------------------------------------------------------ */

eq('GET gets 3 attempts', maxAttemptsFor('GET'), 3);
eq('HEAD gets 3 attempts', maxAttemptsFor('HEAD'), 3);
eq('POST gets 2 attempts', maxAttemptsFor('POST'), 2);
eq('DELETE gets 2 attempts', maxAttemptsFor('DELETE'), 2);
eq('PATCH gets 2 attempts', maxAttemptsFor('PATCH'), 2);

{
  let calls = 0;
  await expectNetworkError(
    fetchWithRetry({
      url: 'https://api.test/api/submissions',
      init: { method: 'POST' },
      fetchImpl: () => {
        calls += 1;
        return networkFail();
      },
      sleep: instant,
    }),
    'a failing POST rejects with NETWORK'
  );
  eq('a POST stops after 2 attempts, not 3', calls, 2);
}

/* ------------------------------------------------------------------ *
 * 4. The per-attempt timeout
 * ------------------------------------------------------------------ */

check('the default timeout is 45s (outlasts a normal boot)', REQUEST_TIMEOUT_MS === 45_000);

{
  // A fetch that never settles must be cut off by the timeout, then retried.
  let calls = 0;
  const delays = [];
  const started = Date.now();
  const err = await expectNetworkError(
    fetchWithRetry({
      url: 'https://api.test/api/profile',
      fetchImpl: (...args) => {
        calls += 1;
        return hangUntilAborted(...args);
      },
      sleep: recordingSleep(delays),
      timeoutMs: 40,
      maxAttempts: 2,
    }),
    'a hanging request is failed by the timeout, not left pending'
  );
  eq('both attempts were made', calls, 2);
  eq('the failure is labelled a timeout', err?.details?.reason, 'timeout');
  check('the message tells the user the server may be waking', /waking up/i.test(err?.message ?? ''));
  check(
    'it took roughly two timeouts, not minutes',
    Date.now() - started < 2_000,
    `took ${Date.now() - started}ms`
  );
}

/* ------------------------------------------------------------------ *
 * 5. The caller's AbortSignal always wins, and is never retried
 * ------------------------------------------------------------------ */

{
  // Abort mid-flight: rejects as AbortError, exactly one fetch, no retry.
  const caller = new AbortController();
  let calls = 0;
  let caught = null;
  const promise = fetchWithRetry({
    url: 'https://api.test/api/profile',
    init: { signal: caller.signal },
    fetchImpl: (...args) => {
      calls += 1;
      return hangUntilAborted(...args);
    },
    sleep: instant,
    timeoutMs: 10_000,
  });
  setTimeout(() => caller.abort(), 20);
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  eq('a mid-flight abort rejects with AbortError', caught?.name, 'AbortError');
  eq('an abort is not retried', calls, 1);
}

{
  // Abort during the backoff wait: the retry never happens.
  const caller = new AbortController();
  let calls = 0;
  let caught = null;
  const promise = fetchWithRetry({
    url: 'https://api.test/api/profile',
    init: { signal: caller.signal },
    fetchImpl: () => {
      calls += 1;
      return networkFail();
    },
    // A sleep that would hang forever if the abort did not interrupt it.
    sleep: () => new Promise(() => {}),
  });
  setTimeout(() => caller.abort(), 30);
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  eq('aborting during backoff rejects with AbortError', caught?.name, 'AbortError');
  eq('the retry never fired', calls, 1);
}

{
  // An already-aborted signal performs no fetch at all.
  const caller = new AbortController();
  caller.abort();
  let calls = 0;
  let caught = null;
  try {
    await fetchWithRetry({
      url: 'https://api.test/api/profile',
      init: { signal: caller.signal },
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(fakeRes(200));
      },
      sleep: instant,
    });
  } catch (err) {
    caught = err;
  }
  eq('a pre-aborted signal rejects with AbortError', caught?.name, 'AbortError');
  eq('a pre-aborted signal performs no fetch', calls, 0);
}

/* ------------------------------------------------------------------ *
 * 6. Wiring: api.js routes every call through the policy
 * ------------------------------------------------------------------ */

function readCode(...segments) {
  return stripJsComments(readFileSync(resolve(HERE, '..', ...segments), 'utf8'));
}

const apiSrc = readCode('src', 'lib', 'api.js');

check('api.js imports fetchWithRetry', /import\s*\{\s*fetchWithRetry\s*\}\s*from\s*'\.\/fetchWithRetry\.js'/.test(apiSrc));
check(
  'request() delegates to fetchWithRetry',
  /const res = await fetchWithRetry\(\{[\s\S]*?url: `\$\{BASE\}\$\{path\}`/.test(apiSrc),
  'a bare fetch here would bypass the timeout and the retry policy'
);
check(
  'no bare fetch remains in api.js',
  !/await fetch\(/.test(apiSrc),
  'every call must carry the cold-start policy'
);

// warmup: unauthenticated, guest-safe, failure-proof.
const warmupStart = apiSrc.indexOf('warmup:');
const warmupEnd = apiSrc.indexOf('profile:', warmupStart);
check('warmup() exists on the api object', warmupStart !== -1 && warmupEnd > warmupStart);
{
  const body = warmupStart !== -1 ? apiSrc.slice(warmupStart, warmupEnd) : '';
  check('warmup() skips guests', /asGuest\(\)/.test(body));
  check('warmup() sends no Authorization header', !/Authorization/.test(body), 'it runs before sign-in; there is no token yet');
  check('warmup() swallows every failure', /catch\s*\{\s*return false/.test(body), 'a warm-up that can surface an error is a bug generator');
  check('warmup() allows up to 60s for a cold boot', /60_000/.test(body));
  check('warmup() targets the health endpoint', /`\$\{BASE\}\/health`/.test(body));
}

const appSrc = readCode('src', 'App.jsx');
check('App.jsx fires the warm-up on mount', /useEffect\(\(\)\s*=>\s*\{\s*api\.warmup\(\);?\s*\}, \[\]\)/.test(appSrc));

/* ------------------------------------------------------------------ *
 * 7. The build guard: a misconfigured bundle cannot ship
 * ------------------------------------------------------------------ */

const GOOD_ENV = {
  VITE_SUPABASE_URL: 'https://abcdefgh.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'a-real-looking-anon-key',
  VITE_API_URL: 'https://ascension-api.onrender.com',
};

function expectGuard(env, label, shouldThrow, fragment = '', markers = {}) {
  // Platform markers change the localhost verdict, so they are pinned per call:
  // every marker is deleted, then the ones this case wants are set.
  const KEYS = ['VERCEL', 'CI', 'NETLIFY', 'RENDER'];
  const saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(markers)) process.env[key] = value;

  let threw = null;
  try {
    assertClientEnvForBuild(env);
  } catch (err) {
    threw = err;
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  check(label, shouldThrow ? threw !== null : threw === null, threw ? threw.message.split('\n').find((l) => l.trim().startsWith('x')) ?? threw.message : 'no error');
  if (shouldThrow && fragment) {
    check(`${label} names the cause`, (threw?.message ?? '').includes(fragment), threw?.message?.slice(0, 200));
  }
}

expectGuard(GOOD_ENV, 'a fully configured env builds', false);
expectGuard({ ...GOOD_ENV, VITE_API_URL: 'https://api.example.com/' }, 'a trailing slash is accepted (the client normalises it)', false);
expectGuard(
  { ...GOOD_ENV, VITE_API_URL: '' },
  'a missing VITE_API_URL is a hard failure',
  true,
  // The exact phrase matters: an empty value must be called missing, not merely
  // malformed. Without this, collapsing the two checks into one passes every
  // behavioral assertion while mislabelling the cause.
  'missing or blank'
);
expectGuard(
  { VITE_SUPABASE_URL: GOOD_ENV.VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY: GOOD_ENV.VITE_SUPABASE_ANON_KEY },
  'an absent VITE_API_URL is a hard failure',
  true,
  'VITE_API_URL'
);
expectGuard(
  { ...GOOD_ENV, VITE_API_URL: 'api.example.com' },
  'a scheme-less VITE_API_URL is a hard failure',
  true,
  'absolute URL'
);
{
  // This case warns by design; capture it so the suite output stays signal-only.
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  expectGuard(
    { ...GOOD_ENV, VITE_API_URL: 'http://localhost:4000' },
    'localhost passes a local build (with a warning)',
    false
  );
  console.warn = realWarn;
  check(
    'the local-build localhost warning is actually printed',
    warnings.some((w) => w.includes('localhost'))
  );
}
expectGuard(
  { ...GOOD_ENV, VITE_API_URL: 'http://localhost:4000' },
  'localhost fails the build on Vercel',
  true,
  'localhost',
  { VERCEL: '1' }
);
expectGuard(
  { ...GOOD_ENV, VITE_API_URL: 'http://localhost:4000' },
  'localhost fails the build in CI',
  true,
  'localhost',
  { CI: 'true' }
);

/* ------------------------------------------------------------------ */

if (failures.length) {
  console.error(`\ntest-api-resilience: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f}`);
  console.error('');
  process.exit(1);
}

console.log(`test-api-resilience: ${passed} assertions passed`);
