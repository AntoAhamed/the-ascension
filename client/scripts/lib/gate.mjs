/**
 * Minimal browser-driving harness shared by the runtime and interaction gates.
 *
 * WHY THIS EXISTS, AND WHY IT REPLACED `chrome --dump-dom`
 *   Both gates used to shell out to Chrome with --dump-dom. That turns out to
 *   depend on three things the machine controls, each of which fails silently and
 *   looks like a broken build:
 *
 *     1. NETWORK EGRESS. --dump-dom fires when the page settles. The app's boot
 *        calls Supabase, so on a machine that cannot reach it the page never
 *        settles and Chrome prints nothing at all. Observed here: the gate passed
 *        with egress, and returned a completely empty DOM without it.
 *     2. THE DEFAULT BROWSER PROFILE. Without --user-data-dir, a developer with
 *        Chrome open gets "Failed to create a ProcessSingleton ... Aborting".
 *     3. VIRTUAL TIME. --virtual-time-budget pauses while a request is pending,
 *        which is the same deadlock as (1) wearing a different hat.
 *
 *   A gate that reports "your build is broken" when your network is down trains
 *   you to re-run it until it goes green, which is the opposite of a gate. So
 *   both gates now speak the DevTools protocol over a WebSocket instead: real
 *   time, an isolated profile, and polling for the state under test. Nothing here
 *   waits for the network to be quiet, because nothing under test needs it to be.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not stub the API or Supabase. Guest mode exists precisely so a real
 *   browser can exercise a real Dashboard with no backend, and these gates use
 *   that path rather than faking one.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `probe` is truthy, or give up returning its last value.
 *
 * Every wait in both gates polls rather than sleeping a fixed interval: dialogs
 * animate out and lazy chunks arrive asynchronously, so a single sample taken at
 * a fixed moment reports a control as broken while it is still closing. The probe
 * is re-evaluated every pass, so this cannot pass by sampling once.
 */
export async function waitUntil(probe, { timeout = 10000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ */
/* browser discovery                                                   */
/* ------------------------------------------------------------------ */

export function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/* ------------------------------------------------------------------ */
/* static server                                                       */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Serve a built directory, rewriting unknown paths to index.html.
 *
 * The fallback is not a convenience. This app has no router, so the path it
 * redirects to after a session ends is only ever resolved by the host rewriting
 * unknown paths to index.html — the same requirement Google OAuth documents.
 * A gate that served files without the rewrite would disagree with every real
 * deployment and quietly excuse a broken redirect.
 */
export async function serveDir(dir, port) {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = join(dir, pathname);
      try {
        await readFile(file);
      } catch {
        file = join(dir, 'index.html');
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  await new Promise((r) => server.listen(port, r));
  return () => server.close();
}

/* ------------------------------------------------------------------ */
/* the page                                                            */
/* ------------------------------------------------------------------ */

/**
 * Launch a browser, drive a page, and tear everything down.
 *
 * Always use an isolated profile (see the header comment for what happens
 * otherwise). The profile is removed afterwards so repeated runs do not litter
 * temp for the life of the machine.
 */
export async function withPage(browserPath, port, path, fn, { settle = 4000, window = '1280,900' } = {}) {
  const debugPort = port + 1;
  const profile = join(tmpdir(), `ascension-gate-${process.pid}`);
  rmSync(profile, { recursive: true, force: true });

  const chrome = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=' + window,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let ws;
  const dispose = async () => {
    try { ws?.close(); } catch { /* already closed */ }
    try { chrome.kill(); } catch { /* already gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* already gone */ }
  };
  const onSigint = () => {
    dispose();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  try {
    ws = await connect(debugPort);
    // `send` resolves the whole CDP message, so replies nest under `result`.
    // Reading sessionId off the top level silently yields undefined, which sends
    // every later command to the browser target instead of the page — where they
    // return nothing at all, with no error to say so.
    const { result: { sessionId: S } } = await ws.send('Target.attachToTarget', {
      targetId: (await ws.send('Target.createTarget', { url: 'about:blank' })).result.targetId,
      flatten: true,
    });
    if (!S) throw new Error('the browser did not hand back a page session');

    await ws.send('Runtime.enable', {}, S);
    await ws.send('Log.enable', {}, S);
    await ws.send('Page.enable', {}, S);

    /**
     * Console errors and uncaught exceptions, drained per step.
     *
     * Drained rather than read once at the end because a failure has to name the
     * interaction that caused it. A single end-of-run dump attributes every error
     * to whatever happened last, which is usually the wrong thing.
     */
    let noise = [];
    ws.onEvent((msg) => {
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        noise.push(`console.error: ${msg.params.entry.text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        noise.push(`uncaught: ${(d.exception?.description ?? d.text ?? 'unknown').split('\n')[0]}`);
      }
    });

    /** Evaluate in the page. Returns `{ value }`, or `{ threw }` if it raised. */
    const evaluate = async (expression) => {
      const r = await ws.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, S);
      if (r.result?.exceptionDetails) {
        return { threw: r.result.exceptionDetails.exception?.description ?? 'evaluate threw' };
      }
      return { value: r.result?.result?.value };
    };

    const drainNoise = () => {
      const seen = noise;
      noise = [];
      return seen;
    };

    /**
     * Click for real: hit-tested coordinates, then pointer/mouse events.
     *
     * Not el.click(), which skips hit-testing entirely and so cannot detect a
     * control buried under an overlay.
     *
     * Takes either a CSS selector or a point. A point is for the cases a
     * selector cannot express — chiefly "the button in this dialog whose label is
     * exactly this", where two buttons are equally real candidates and only their
     * labels tell them apart.
     */
    const click = async (target) => {
      let x;
      let y;
      if (typeof target === 'object' && target !== null) {
        ({ x, y } = target);
      } else {
        const probe = await evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(target)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return { offscreen: true };
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const top = document.elementFromPoint(x, y);
          return { x, y, covered: !(el.contains(top) || top === el), covering: top?.tagName ?? null };
        })()`);
        if (probe.threw) return { error: probe.threw };
        if (!probe.value) return { missing: true };
        if (probe.value.offscreen) return { offscreen: true };
        if (probe.value.covered) return { covered: true, by: probe.value.covering };
        ({ x, y } = probe.value);
      }

      await ws.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, S);
      await sleep(90);
      await ws.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }, S);
      await sleep(70);
      await ws.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 }, S);
      await sleep(400);
      return { clicked: true };
    };

    /**
     * Press a key. Escape is the one both gates need, and it is the one that has
     * to reach a listener on `window` while focus sits inside a dialog, so it is
     * dispatched with its virtual key code rather than as a bare key name.
     */
    const key = async (name) => {
      const vk = name === 'Escape' ? 27 : name === 'Tab' ? 9 : name === 'Enter' ? 13 : 0;
      const payload = { key: name, code: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await ws.send('Input.dispatchKeyEvent', { type: 'keyDown', ...payload }, S);
      await ws.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload }, S);
      await sleep(400);
    };

    const origin = `http://localhost:${port}`;

    await ws.send('Page.navigate', { url: `${origin}${path}` }, S);
    await sleep(settle);

    /** Re-navigate within the same page, for a second look at a fresh load. */
    const navigate = async (to, wait = settle) => {
      await ws.send('Page.navigate', { url: `${origin}${to}` }, S);
      await sleep(wait);
    };

    return await fn({ evaluate, click, key, navigate, drainNoise, sleep, waitUntil, ws, S });
  } finally {
    process.off('SIGINT', onSigint);
    await dispose();
  }
}

/** A CDP connection with a `send` that resolves replies and records events. */
async function connect(debugPort) {
  let endpoint = null;
  for (let i = 0; i < 80 && !endpoint; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      endpoint = (await res.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  if (!endpoint) throw new Error('the browser never exposed a debugging endpoint');

  const ws = new WebSocket(endpoint);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('could not open the DevTools socket'));
  });

  let seq = 0;
  const inFlight = new Map();
  const listeners = [];

  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && inFlight.has(msg.id)) {
      inFlight.get(msg.id)(msg);
      inFlight.delete(msg.id);
      return;
    }
    for (const fn of listeners) fn(msg);
  };

  return {
    onEvent: (fn) => listeners.push(fn),
    send: (method, params = {}, sessionId) =>
      new Promise((res) => {
        const id = ++seq;
        inFlight.set(id, res);
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      }),
  };
}
