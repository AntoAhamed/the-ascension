/**
 * Feedback intake.
 *
 * POST /api/feedback
 *   A user reports a bug, asks for a feature, appeals a grade, or says anything
 *   else. Stored in the `feedback` table for the operator to read directly — no
 *   third-party ticket service, no outbound email, nothing that leaves the
 *   project's own database.
 *
 * Design notes:
 *   - The write uses the service-role client, which bypasses RLS. That is safe
 *     only because `user_id` is taken from the verified JWT in `req.user.id` and
 *     never from the request body. There is no field here a caller could use to
 *     file feedback as somebody else.
 *   - The type is constrained to a known set rather than accepted as free text.
 *     This is a support inbox: an unrecognised type is a client bug or someone
 *     probing the endpoint, and silently filing it under "general" would hide
 *     both. Rejecting is what makes the column trustworthy for triage.
 *   - Reads are deliberately not exposed. Feedback is not the user's to read back,
 *     and adding a GET here would mean deciding who may see whose reports — which
 *     is a policy question, not a technical one. The operator reads the table
 *     directly in the Supabase dashboard.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getSupabaseAdmin } from '../config/supabaseAdmin.js';

export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

/** The four buckets the UI offers. Kept in sync with FeedbackModal.jsx. */
export const FEEDBACK_TYPES = ['bug', 'feature', 'appeal', 'general'];

const MAX_MESSAGE = 4000;

const feedbackSchema = z.object({
  feedbackType: z.enum(FEEDBACK_TYPES, {
    errorMap: () => ({ message: 'Choose one of the listed feedback types.' }),
  }),
  message: z
    .string()
    .trim()
    .min(10, 'Tell us a little more — at least 10 characters.')
    .max(MAX_MESSAGE, `Keep feedback under ${MAX_MESSAGE} characters.`),
});

/**
 * Abuse boundary.
 *
 * Keyed on user id rather than IP so a shared office is not throttled as one, and
 * generous because the endpoint is cheap — it writes one row and costs no Gemini
 * call. It exists to stop a script from filling the table, not to ration a user.
 */
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'You have sent a lot of feedback recently. Try again in an hour.',
    },
  },
});

feedbackRouter.post(
  '/',
  feedbackLimiter,
  asyncHandler(async (req, res) => {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        parsed.error.issues.map((i) => i.message).join('; '),
        parsed.error.issues
      );
    }

    const { feedbackType, message } = parsed.data;

    const { error } = await getSupabaseAdmin().from('feedback').insert({
      // From the verified JWT, never the body.
      user_id: req.user.id,
      feedback_type: feedbackType,
      message,
    });

    if (error) throw error;

    // 201 with no body worth returning: there is no id the client could use (no
    // read endpoint exists) and echoing the row back would only invite the UI to
    // display a stored copy of what the user just typed.
    res.status(201).json({ ok: true });
  })
);