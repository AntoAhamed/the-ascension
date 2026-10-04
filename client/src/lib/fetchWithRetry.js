/**
 * Fetch with a per-attempt timeout and bounded retry, for one specific enemy:
 * the cold start.
 *
 * The API runs on a host that sleeps when idle (Render's free tier stops a
 * service after 15 minutes without traffic). The first request to a sleeping
 * instance is held while the machine boots — commonly 30 to 50 seconds — and a
 * plain fetch either hangs with no feedback or dies when an intermediary gives
 * up first (502/503/504 from the platform's proxy). Presented to a user who has
 * *just signed in*, that looks like "account created, app broken".
 *
 * So every request gets:
 *   - a 45-second timeout per attempt, long enough to outlast a normal boot;
 *   - retry with backoff on network rejection, on timeout, and on 502/503/504 —
 *     the three statuses a waking proxy produces before the app is up;
 *   - no retry on anything else. A 400 or 401 is the server giving a real
 *     answer; repeating the question would just delay it.
 *
 * RETRYING MUTATIONS
 *   Mutations get two attempts rather than three. The unsafe case is a request
 *   that succeeded server-side but whose response was lost, making the retry a
 *   duplicate. Here it is survivable by design: submit_daily_log raises P0001
 *   on a second accepted entry for the day, which the client already translates
 *   into a friendly "already submitted". A DELETE that arrives twice gets a 404
 *   the second time, which the caller's error handling already renders. That is
 *   a price worth paying: the alternative is the far more common failure —
 *   nothing works at all for the first minute after idle.
 *
 * THE ABORT CONTRACT
 *   Callers pass their own AbortSignal (useGameData cancels superseded
 *   requests, SubmissionEngine cancels on unmount). A caller abort is NOT a
 *   failure and must never be retried: it propagates as the original
 *   AbortError, unchanged, immediately. Internally each attempt runs on its own
 *   controller so the timeout can abort one attempt without touching the
 *   caller's signal.
 *
 * `fetchImpl` and `sleep` are injectable because this policy is exactly the
 * kind that rots untested: the tests drive it with a stub fetch and a fake
 * clock, and assert on attempts, delays and which errors propagate.
 */
import { ApiError } from './apiError.js';

/** Long enough for a sleeping instance's normal boot, short enough to give up. */
export const REQUEST_TIMEOUT_MS = 45_000;

/** The statuses a waking proxy answers with before the app behind it is up. */
export const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/** Reads are safe to repeat; mutations are survivable (see above), not free. */
export function maxAttemptsFor(method = 'GET') {
  const m = String(method).toUpperCase();
  return m === 'GET' || m === 'HEAD' ? 3 : 2;
}

/** Delays between attempts: first retry after 1.5s, second after 4s. */
const BACKOFF_MS = [1_500, 4_000];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} args
 * @param {string} args.url
 * @param {RequestInit} [args.init]          may include the caller's AbortSignal
 * @param {typeof fetch} [args.fetchImpl]
 * @param {(ms:number)=>Promise<void>} [args.sleep]
 * @param {number} [args.timeoutMs]          per attempt, not overall
 * @param {number} [args.maxAttempts]        defaults to maxAttemptsFor(method)
 * @returns {Promise<Response>}              the last response, even a retryable
 *                                           502/503/504, so the caller can read
 *                                           its error body
 */
export async function fetchWithRetry({
  url,
  init = {},
  fetchImpl = fetch,
  sleep = defaultSleep,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxAttempts = maxAttemptsFor(init.method),
}) {
  const callerSignal = init.signal ?? null;
  let lastError = null;
  /** The most recent response — survives the loop so the final 502/503/504 can
   * be handed back for the caller to parse. */
  let response = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A caller that already cancelled gets no fetch at all.
    if (callerSignal?.aborted) throw abortError();

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forwardAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', forwardAbort, { once: true });

    let failure = null;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      failure = err;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    }

    if (failure) {
      // Caller cancellation is not a failure mode: out now, unchanged.
      if (!timedOut && (callerSignal?.aborted || failure?.name === 'AbortError')) {
        throw failure;
      }
      lastError = new ApiError(
        0,
        'NETWORK',
        timedOut
          ? 'The API did not answer in time. The server may still be waking up after being idle — that can take up to a minute. Please try again.'
          : 'Could not reach the API. If the server was idle it may still be starting up. Please try again in a moment.',
        { reason: timedOut ? 'timeout' : 'network', attempts: attempt }
      );
    } else if (!RETRYABLE_STATUSES.has(response.status)) {
      // Any non-retryable response — success or a real error — is final.
      return response;
    } else {
      lastError = null; // retryable status: loop, and return it if we run out
    }

    if (attempt < maxAttempts) {
      // Sleep between attempts — but a caller abort must cut the wait short.
      try {
        await waitWithAbort(sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]), callerSignal);
      } catch (err) {
        throw err ?? abortError();
      }
    }
  }

  if (lastError) throw lastError;
  // The final attempt produced a 502/503/504: hand it back so the caller can
  // parse the body's error shape like any other response.
  return response;
}

/** DOMException-shaped AbortError without depending on DOMException existing. */
function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * A sleep that a caller abort can interrupt. Rejects with the signal's reason
 * (an AbortError for a plain abort()) so cancellation during backoff is
 * indistinguishable from cancellation mid-flight.
 */
function waitWithAbort(sleepPromise, signal) {
  if (!signal) return sleepPromise;
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    sleepPromise.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}
