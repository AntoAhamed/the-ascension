/**
 * Verifies no privileged credential reaches the client bundle.
 *
 * The strongest form of this check is not "we did not find the service-role key"
 * but "every JWT-shaped string in the bundle is byte-identical to a key that is
 * explicitly supposed to be public". That way a future key of a shape this
 * script has never seen still fails the check, instead of passing because the
 * search pattern did not match it.
 *
 * Reads the real keys from server/.env so it cannot drift from reality.
 *
 *   node scripts/audit-bundle-credentials.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DIST = join(ROOT, 'client', 'dist');

let passed = 0;
const failures = [];

const check = (label, ok, detail) => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(detail ? `${label} -- ${detail}` : label);
    console.log(`  FAIL  ${detail ? `${label} -- ${detail}` : label}`);
  }
};

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

function envValue(key) {
  const text = readFileSync(join(ROOT, 'server', '.env'), 'utf8');
  const m = new RegExp(`^${key}\\s*=\\s*(\\S+)`, 'm').exec(text);
  return m ? m[1].trim() : null;
}

const serviceKey = envValue('SUPABASE_SERVICE_ROLE_KEY');
const anonKey = envValue('SUPABASE_ANON_KEY') ?? envValue('SUPABASE_ANON');

console.log('\nReading real credentials from server/.env');
check('service-role key was found to test against', serviceKey !== null);
check('anon key was found to test against', anonKey !== null);

if (!serviceKey || !anonKey) {
  console.log('\nCannot audit without both keys. Failing loudly rather than passing on an empty check.');
  process.exit(1);
}

// Supabase JWTs: three base64url segments. Matching on the shape means a leaked
// key that is not the one currently in .env is still caught.
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

const files = walk(DIST).filter((f) => /\.(js|css|html|json|svg|map)$/.test(f));
const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');

console.log(`\nScanning ${files.length} built files`);

check('the service-role key is not in the bundle', !text.includes(serviceKey));

// A prefix check, in the hope of catching a key split across concatenated
// literals. The two Supabase keys share their first 110 characters — same
// algorithm header, same issuer, same project ref — so a 40-character prefix is
// satisfied by the anon key and this assertion fails on a perfectly clean build.
// The distinguishing region is the payload's "role" claim and the signature,
// which the assertions below already examine properly.
const divergence = [...serviceKey].findIndex((c, i) => c !== anonKey[i]);
const distinctive = serviceKey.slice(Math.max(divergence, 0), Math.max(divergence, 0) + 32);
check(
  `the service-role key's distinctive region is absent (chars ${divergence}-${divergence + 32})`,
  !text.includes(distinctive),
  `found ${JSON.stringify(distinctive)}`
);

const jwtish = [...new Set(text.match(JWT_SHAPE) ?? [])];
check(`exactly one JWT-shaped string exists in the bundle (${jwtish.length} found)`, jwtish.length === 1, `found ${jwtish.length}`);

if (jwtish.length === 1) {
  const [found] = jwtish;
  check('that JWT is byte-identical to the anon key', found === anonKey);
  check('that JWT is not the service-role key', found !== serviceKey);

  // Decode the payload to confirm the claim, rather than trusting the length.
  let payload = {};
  try {
    payload = JSON.parse(Buffer.from(found.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    /* handled by the assertion below */
  }
  check('the bundled JWT carries role "anon"', payload.role === 'anon', `role is ${payload.role}`);
  check('the service-role key carries role "service_role" (confirming the two differ)', (() => {
    try {
      const p = JSON.parse(Buffer.from(serviceKey.split('.')[1], 'base64url').toString('utf8'));
      return p.role === 'service_role';
    } catch {
      return false;
    }
  })());
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
