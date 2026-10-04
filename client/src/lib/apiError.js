/**
 * The error type every API call rejects with.
 *
 * Kept in its own module so guestApi.js can throw the same error without
 * importing api.js, which imports guestApi.js. A cycle would work as long as the
 * class is only referenced inside function bodies, but that is a property to
 * maintain rather than a design to rely on. api.js re-exports it, so existing
 * `import { ApiError } from '../lib/api.js'` keeps working.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}