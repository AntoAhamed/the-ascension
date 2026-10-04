/**
 * Maintenance endpoints.
 *
 * The nightly cron job handles decay in-process. This route exists so an external
 * scheduler (Vercel Cron, GitHub Actions, Supabase cron, a platform-native cron)
 * can trigger the same work — needed when the API scales to zero or runs where a
 * long-lived process is not guaranteed.
 *
 * This is NOT a user-authenticated route. There is no Supabase identity here:
 * an external scheduler has no user session, so requiring one would make the
 * endpoint uncallable. It is guarded by a shared secret instead, and that secret
 * is MANDATORY in production (see validateConfig) precisely because the
 * alternative is an open endpoint that mutates every profile in the database.
 */
import { Router } from 'express';
import { asyncHandler, forbidden, unauthorized } from '../lib/errors.js';
import { config } from '../config/env.js';
import { runDecayNow } from '../jobs/decayJob.js';

export const adminRouter = Router();

/**
 * Constant-time comparison so the secret cannot be recovered by timing the
 * rejection. The lengths are compared first as a fast path.
 */
function secretMatches(provided, expected) {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function assertCronSecret(req) {
  // Unreachable in production — validateConfig() refuses to boot without one.
  // Guarded anyway so a misconfiguration can never silently open the endpoint.
  if (!config.cronSecret) {
    throw forbidden(
      'CRON_SECRET is not configured on this server, so the cron endpoint is disabled.'
    );
  }

  const provided = req.get('x-cron-secret') ?? '';
  if (!secretMatches(provided, config.cronSecret)) {
    throw unauthorized('Invalid or missing x-cron-secret header');
  }
}

adminRouter.post(
  '/decay',
  asyncHandler(async (req, res) => {
    assertCronSecret(req);
    const result = await runDecayNow('external trigger');
    // Surface the failure in the status code: a scheduler must be able to see
    // that the run did not work, or it will silently stop retrying.
    if (result.error) {
      // The cause is already logged by runDecayNow. Echoing it into the
      // response would put raw Supabase/Postgres text — function names, schema
      // details — into whatever logs the calling scheduler keeps. The secret
      // keeps strangers out; it does not make disclosure to a third party safe.
      return res.status(500).json({
        error: { code: 'DECAY_FAILED', message: 'Decay reconciliation failed.' },
        // Development only: a local scheduler debugging its own integration
        // needs the reason, and there is no third party to leak it to.
        ...(config.isProd ? {} : { detail: result.error }),
      });
    }
    res.json({ ok: true, corrected: result.corrected });
  })
);

