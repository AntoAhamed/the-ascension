/**
 * Auth middleware.
 *
 * The browser signs in with Supabase Auth (client-side) and sends the resulting
 * JWT as `Authorization: Bearer <token>`. We validate that token against
 * Supabase on every request, which yields a trustworthy user id. All database
 * work then happens through the service-role client.
 *
 * There is no bypass of any kind. An absent, malformed, expired, or foreign token
 * is a 401, and `req.user` is populated from Supabase's answer alone — never
 * from a request header, query parameter, or body.
 */
import { asyncHandler, unauthorized } from '../lib/errors.js';
import { getSupabasePublic } from '../config/supabaseAdmin.js';

function extractBearer(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = extractBearer(req);
  if (!token) throw unauthorized('Missing Authorization: Bearer <token> header');

  const { data, error } = await getSupabasePublic().auth.getUser(token);
  if (error || !data?.user) throw unauthorized('Your session is invalid or expired. Please sign in again.');

  req.user = { id: data.user.id, email: data.user.email ?? null };
  next();
});
