/**
 * Typed HTTP error + a global error handler that produces consistent,
 * non-leaky responses.
 */
export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Resource not found') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (msg, code = 'CONFLICT') => new HttpError(409, code, msg);
export const upstream = (msg, details) => new HttpError(502, 'UPSTREAM_ERROR', msg, details);

/**
 * Wraps an async route handler so rejected promises reach the error middleware.
 * (Express 4 does not do this for you.)
 */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ */
/* Supabase / Postgres error translation                                */
/* ------------------------------------------------------------------ */

/**
 * Our schema signals business rules with custom SQLSTATEs:
 *   P0001 -> already submitted today
 *   P0002 -> profile missing
 *   23505 -> unique violation (our backstop for one-log-per-day)
 */
export function translateDbError(error) {
  const message = String(error?.message ?? '');
  const code = error?.code;

  if (code === 'P0001' || /already completed/i.test(message)) {
    return conflict('You have already submitted your daily task today. Come back after UTC midnight.', 'ALREADY_SUBMITTED');
  }
  if (code === 'P0002' || /profile not found/i.test(message)) {
    return notFound('Profile not found. Sign out and back in to provision it.');
  }
  // revoke_today_log() raises this when there is no accepted log for today:
  // either the day is already spent, or it rolled over and is now locked.
  if (code === 'P0003' || /no accepted submission/i.test(message)) {
    return conflict(
      'There is no submission of yours from today to replace. Once the UTC day rolls over, entries become permanent.',
      'NOTHING_TO_REVOKE'
    );
  }
  if (code === '23505' || /duplicate key/i.test(message)) {
    return conflict('That submission already exists.', 'ALREADY_SUBMITTED');
  }
  if (code === '23514' || /check constraint/i.test(message)) {
    // Postgres phrases this as e.g. `new row for relation "profiles" violates
    // check constraint "profiles_points_check"`. That names the table, the
    // column and the constraint — the schema, which is the one thing a caller
    // must not be able to read back out of a 400. The caller gets the same
    // actionable sentence either way; the raw text goes to the server log.
    console.error('[db] check-constraint violation:', message);
    return badRequest(
      'The submission failed a database constraint. It probably contains a value the rules do not allow.'
    );
  }
  return null;
}