/**
 * Supabase clients.
 *
 *  supabaseAdmin  — service-role key. Bypasses RLS. Server-side ONLY.
 *  supabasePublic — anon key, used purely to verify incoming JWTs.
 *
 * Both are lazily constructed and cached. Lazily so that importing this module
 * during the config validation in env.js does not open a socket to a project
 * that may not be configured yet; cached so the HTTP agent is reused across
 * every request instead of rebuilt per call.
 *
 * The service-role key is read from the server's environment and never appears
 * in a response, a log line, or anything Vite would bundle. All browser traffic
 * is authenticated with the anon key and authorised by the API.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from './env.js';

let admin = null;
let pub = null;

function build(key) {
  return createClient(config.supabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export function getSupabaseAdmin() {
  if (!admin) admin = build(config.supabaseServiceRoleKey);
  return admin;
}

/** Used only for auth.getUser() token verification. */
export function getSupabasePublic() {
  if (!pub) pub = build(config.supabaseAnonKey);
  return pub;
}