/**
 * The port-conflict contract.
 *
 * EADDRINUSE is one of the commonest development failures this server can hit —
 * a previous `node --watch` still alive in another terminal — and it used to
 * produce an unhandled 'error' event: a raw syscall trace, then silence while
 * `node --watch` waited for a file change. The fix makes the same failure print
 * what the developer actually needs (what holds the port, how to find it, how
 * to stop it) and exit 1.
 *
 * This test proves it behaviorally, because the interesting properties are all
 * observable only in a real failure:
 *
 *   - the process EXITS 1 (does not hang, does not crash with a stack);
 *   - the output contains the guidance and NEVER the words "Unhandled 'error'
 *     event", which is the regression this file exists to prevent;
 *   - when the squatter answers /api/health, the output says so — the leftover-
 *     instance case is the common one and gets the most useful message;
 *   - when the squatter is some other program, the message says that instead.
 *
 * ENVIRONMENT NOTE
 *   The server refuses to boot until it can reach Supabase (that check is
 *   deliberate and unchanged), so this test needs the credentials in server/.env
 *   to be real, exactly like npm run dev does. The conflict itself is staged on
 *   a scratch port so the test is safe to run while a real server occupies 4000.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when something is already listening, so the squatter is known to be up. */
async function waitForPort(port, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const taken = await new Promise((resolve) => {
      import('node:http').then(({ get }) => {
        const req = get({ host: '127.0.0.1', port, path: '/', timeout: 500 }, (res) => {
          res.resume();
          resolve(true);
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
      });
    });
    if (taken) return true;
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

/**
 * Run the real server against a port already held by `squatterSource`, and
 * capture how it fails. Returns { code, output }.
 */
async function runConflictScenario(port, squatterSource) {
  const squatter = spawn(process.execPath, ['-e', squatterSource], { stdio: 'ignore' });
  try {
    const up = await waitForPort(port);
    if (!up) {
      return { code: null, output: 'squatter never came up' };
    }

    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(port) },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));

    const code = await Promise.race([
      new Promise((r) => child.on('exit', r)),
      sleep(30_000).then(() => 'TIMEOUT'),
    ]);
    if (code === 'TIMEOUT') child.kill('SIGKILL');
    return { code, output };
  } finally {
    squatter.kill('SIGKILL');
  }
}

/* ------------------------------------------------------------------ */

const SQUAT_AS_API = `
  require('node:http').createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
  }).listen(${'' + 0});
`;

for (const [name, squatter, isApi] of [
  ['occupant is this API', SQUAT_AS_API, true],
  [
    'occupant is another program',
    `require('node:http').createServer((req, res) => { res.writeHead(404); res.end('nope'); }).listen(0);`,
    false,
  ],
]) {
  // One port per scenario so a lingering socket from the first cannot leak into
  // the second.
  const port = isApi ? 4557 : 4558;
  const src = squatter.replace('.listen(0)', `.listen(${port})`);
  const { code, output } = await runConflictScenario(port, src);

  check(`${name}: the server exits 1`, code === 1, `exit=${code}\n${output.slice(-400)}`);
  check(
    `${name}: the banner names the port`,
    output.includes(`PORT ${port} IS ALREADY IN USE`),
    output.slice(-400)
  );
  check(
    `${name}: no unhandled 'error' event`,
    !output.includes("Unhandled 'error' event") && !output.includes('throw er;'),
    'the raw crash this fix replaced is back'
  );
  check(
    `${name}: the output says how to find the holder`,
    output.includes('Get-NetTCPConnection') && output.includes('lsof'),
  );
  check(
    `${name}: the output mentions PORT as the override`,
    output.includes('PORT=<n>')
  );
  if (isApi) {
    check(
      `${name}: the leftover-instance case is called out`,
      output.includes('Another copy of THIS API'),
      output.slice(-500)
    );
  } else {
    check(
      `${name}: a foreign occupant is distinguished from a leftover`,
      !output.includes('Another copy of THIS API') && output.includes('does not answer /api/health'),
      output.slice(-500)
    );
  }
}

/* ------------------------------------------------------------------ */

if (failures.length) {
  console.error(`\ntest-port-conflict: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f}`);
  console.error('');
  process.exit(1);
}

console.log(`test-port-conflict: ${passed} assertions passed`);
