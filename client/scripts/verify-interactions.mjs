/**
 * Interaction verification for the production bundle.
 *
 * WHY THIS EXISTS, SEPARATELY FROM verify-runtime.mjs
 *   verify-runtime.mjs proves the app RENDERS: React mounts, the Dashboard
 *   branch is chosen, every lazy chunk evaluates. It does that by dumping the
 *   DOM, which cannot click anything.
 *
 *   So the whole chain was blind to a class of failure where the page looks
 *   perfect and every control is dead. A component whose onClick still
 *   references a binding that was removed from its module scope renders
 *   identically to a working one — same DOM, same markup, same styles — and the
 *   click throws a ReferenceError that nothing logs unless you are watching the
 *   console. That is not hypothetical: it shipped once. `Header` kept
 *   `onClick={() => signOut()}` after `signOut` was removed from its
 *   `useAuth()` destructuring, and every other gate stayed green while the Sign
 *   Out button did nothing at all.
 *
 * WHAT IT ASSERTS
 *   1. EVERY HEADER CONTROL RESPONDS TO A REAL POINTER CLICK.
 *      Dispatched through CDP as pointer/mouse events at the element's real
 *      coordinates, not el.click(). A synthetic click skips hit-testing, so it
 *      cannot detect an element buried under an overlay, and it does not exercise
 *      the mousedown/mouseup ordering a browser actually produces. Both were
 *      real bugs' worth of blind spot.
 *
 *   2. EACH OPENS THE DIALOG IT CLAIMS TO, AND ESCAPE CLOSES IT.
 *      Matched on aria-labelledby/aria-label rather than on visual text, so a
 *      copy change cannot silently un-assert the wiring.
 *
 *   3. THE SIGN-OUT CONFIRMATION IS REAL, AND SO IS THE TEARDOWN.
 *      Clicking Sign Out must not end the session. Confirming it must, and must
 *      land on the sign-in screen rather than an error screen. This is the whole
 *      point of the confirmation, and the original bug: a redirect that
 *      re-authenticates from a surviving token shows "Could not reach the API".
 *
 *   4. NOTHING THROUGHOUT.
 *      Any console error or uncaught exception during any interaction is a
 *      failure, attributed to the step that caused it. This is the assertion that
 *      catches the dead-control class outright, and it is why an empty assertion
 *      list here would be a problem rather than a pass.
 *
 * WHY IT SERVES dist RATHER THAN THE DEV SERVER
 *   So the gate is hermetic and deterministic. A running dev server can hold a
 *   stale transform for a given URL — the failure this script was written after
 *   was served by one — and a gate that depends on whatever a developer happens
 *   to have running is a gate that fails for reasons unrelated to the code.
 *
 * WHAT IT SHARES
 *   The browser harness lives in lib/gate.mjs, alongside verify-runtime.mjs.
 *   Nothing here waits for the network to go quiet, which is what makes it usable
 *   on a machine with no route to Supabase; see that file for why the obvious
 *   alternative was abandoned.
 *
 * SKIPPING
 *   No Chrome/Edge binary means a printed skip and exit 0, matching
 *   verify-runtime.mjs, so a bare CI container does not fail the chain.
 *   --require-browser turns that skip into a failure.
 *
 *   node client/scripts/verify-interactions.mjs
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findBrowser, serveDir, withPage } from './lib/gate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist');
const PORT = 4180;

const requireBrowser = process.argv.includes('--require-browser');

let failures = 0;
const ok = (label) => console.log(`  PASS  ${label}`);
const check = (label, condition, detail) => {
  if (condition) ok(label);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};
const group = (title) => console.log(`\n${title}`);

const browser = findBrowser();
if (!browser) {
  console.log(
    requireBrowser
      ? '  FAIL  no Chrome/Edge binary found and --require-browser was passed'
      : '  SKIP  no Chrome/Edge binary found — interaction check skipped (pass --require-browser to enforce)'
  );
  process.exit(requireBrowser ? 1 : 0);
}

if (!existsSync(resolve(DIST, 'index.html'))) {
  console.log('  FAIL  client/dist/index.html does not exist. Run `npm run build:client` first.');
  process.exit(1);
}

/* ---------------- drive the app ---------------- */

const stopServer = await serveDir(DIST, PORT);

try {
  await withPage(browser, PORT, '/', async ({ evaluate, click, key, navigate, drainNoise, sleep, waitUntil }) => {
    const pressEscape = () => key('Escape');

    const dialogs = () =>
      evaluate(`(() => Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => ({
        labelledby: d.getAttribute('aria-labelledby'),
        ariaLabel: d.getAttribute('aria-label'),
        text: (d.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
      })))()`);

    const dialogList = async () => (await dialogs()).value ?? [];

    const hasDialog = (key) => async () => (await dialogList()).some(key);

    /**
     * Click a button identified by its exact label inside a container, for real.
     *
     * Needed because the sign-out dialog's two buttons are equally real
     * candidates and only their labels tell them apart — "Log out" confirms,
     * "Stay signed in" does not. Selecting by position would be a guess, and
     * guessing on the one button that ends a session is not acceptable.
     */
    const clickButtonIn = async (containerSelector, textLiteral) => {
      const found = await evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(containerSelector)});
        const btn = Array.from(root?.querySelectorAll('button') ?? [])
          .find((b) => (b.innerText || '').trim().toLowerCase() === ${JSON.stringify(textLiteral.toLowerCase())});
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return { offscreen: true };
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (found.threw) return { error: found.threw };
      if (!found.value) return { missing: true };
      if (found.value.offscreen) return { offscreen: true };
      return click(found.value);
    };

    /**
     * Escape until nothing is open, and report whether that worked.
     *
     * Run before each group, because a dialog left open covers the header and
     * every control beneath it. Without this, one undetected dialog turns into a
     * cascade of unrelated-looking failures in later groups — which is not just
     * noisy, it points the reader at the wrong file. Asserted rather than assumed
     * so the leak is reported where it originated.
     */
    const ensureNoDialogs = async (label) => {
      for (let i = 0; i < 5; i += 1) {
        if ((await dialogList()).length === 0) return true;
        await pressEscape();
        await sleep(400);
      }
      const still = await dialogList();
      check(`no dialog was left open before this step${label ? ` (${label})` : ''}`, still.length === 0, JSON.stringify(still));
      return still.length === 0;
    };

    /**
     * Each entry: the control, and how the dialog it opens must be identified.
     *
     * The identification is recorded rather than inferred, because it is the
     * contract a screen reader depends on and a copy edit must not silently
     * un-assert the wiring. Both forms are legitimate — `aria-labelledby` pointing
     * at a heading, or a flat `aria-label` — and this app currently uses both, so
     * which one a given modal uses is recorded explicitly here instead of being
     * assumed uniform.
     */
    const CONTROLS = [
      { label: 'About and How It Works', expect: { ariaLabel: 'About and How It Works' } },
      { label: 'Feedback and Support', expect: { ariaLabel: 'Feedback and Support' } },
    ];

    group('The app boots into the signed-out screen');
    {
      const booted = await evaluate(`(() => ({
        hasExplore: !!Array.from(document.querySelectorAll('button')).find((b) => /explore/i.test(b.innerText)),
        rootSize: document.getElementById('root')?.innerHTML.length ?? 0,
      }))()`);
      check('the auth screen rendered', booted.value?.rootSize > 0);
      check('guest entry is available', booted.value?.hasExplore === true);
      const startup = drainNoise();
      check('nothing threw while booting', startup.length === 0, startup.join(' | '));
    }

    group('Guest mode reaches a Dashboard whose controls are all live');
    {
      await evaluate(`Array.from(document.querySelectorAll('button')).find((b) => /explore/i.test(b.innerText))?.click()`);
      await sleep(2500);
      const header = await evaluate(`!!document.querySelector('header')`);
      check('the header rendered', header.value === true);

      // The desktop counterpart of the mobile pass below: at 1280px the menu
      // must stay hidden and the full control row must be what is shown.
      const responsive = await evaluate(`(() => {
        const menuBtn = document.querySelector('header [aria-label="More options"]');
        const about = document.querySelector('header [aria-label="About and How It Works"]');
        return {
          menuHidden: menuBtn ? menuBtn.getBoundingClientRect().width === 0 : null,
          aboutVisible: about ? about.getBoundingClientRect().width > 0 : false,
        };
      })()`);
      check('the overflow menu stays hidden on desktop', responsive.value?.menuHidden === true, JSON.stringify(responsive.value));
      check('the desktop controls are visible', responsive.value?.aboutVisible === true, JSON.stringify(responsive.value));
    }

    for (const { label, expect } of CONTROLS) {
      group(`"${label}" opens its dialog`);
      await ensureNoDialogs(label);
      drainNoise();
      const result = await click(`header [aria-label="${label}"]`);
      check('the control is present and not covered', result.clicked === true, JSON.stringify(result));

      const matches = (d) => (expect.labelledby ? d.labelledby === expect.labelledby : d.ariaLabel === expect.ariaLabel);
      const opened = await waitUntil(hasDialog(matches));
      check(`${expect.labelledby ?? expect.ariaLabel} is open`, Boolean(opened), JSON.stringify(await dialogList()));

      // Only meaningful once the dialog was actually detected above. Asserting
      // "not open" after a failed detection would pass for the wrong reason,
      // which is how a broken control hides behind a green line — and is exactly
      // how the covered-by-the-previous-modal failure got reported downstream.
      if (opened) {
        await pressEscape();
        const closed = await waitUntil(async () => !(await dialogList()).some(matches));
        check('Escape closes it', closed === true, JSON.stringify(await dialogList()));
      }

      const noiseSeen = drainNoise();
      check('nothing threw', noiseSeen.length === 0, noiseSeen.join(' | '));
    }

    group('Sign out asks before it acts');
    {
      await ensureNoDialogs('before the sign-out click');
      drainNoise();
      const before = await evaluate(`({ path: location.pathname, hasSignOut: !!document.querySelector('header [aria-label="Sign out"]') })`);
      check('the session is live before the click', before.value?.hasSignOut === true);

      const result = await click('header [aria-label="Sign out"]');
      check('the control is present and not covered', result.clicked === true, JSON.stringify(result));

      const dialog = (await waitUntil(hasDialog((d) => d.labelledby === 'sign-out-title')))
        ? (await dialogList()).find((d) => d.labelledby === 'sign-out-title')
        : null;
      check('the confirmation is open', Boolean(dialog), JSON.stringify(await dialogList()));
      check('it asks the question', /log out/i.test(dialog?.text ?? ''), dialog?.text);

      const afterClick = await evaluate(`({ path: location.pathname, hasSignOut: !!document.querySelector('header [aria-label="Sign out"]') })`);
      check(
        'the session was NOT ended by opening the dialog',
        Boolean(dialog) && afterClick.value?.hasSignOut === true && afterClick.value?.path === before.value?.path,
        JSON.stringify(afterClick.value)
      );

      const focus = await evaluate(`({
        tag: document.activeElement?.tagName ?? null,
        text: (document.activeElement?.innerText ?? '').trim(),
      })`);
      check('focus lands on the safe action', /stay signed in/i.test(focus.value?.text ?? ''), JSON.stringify(focus.value));
      check('focus does NOT land on the destructive action', !/^log out$/i.test(focus.value?.text ?? ''), JSON.stringify(focus.value));

      const noiseSeen = drainNoise();
      check('nothing threw', noiseSeen.length === 0, noiseSeen.join(' | '));

      await pressEscape();
      const closed = await waitUntil(async () => !(await dialogList()).some((d) => d.labelledby === 'sign-out-title'));
      check('Escape closes it', closed === true, JSON.stringify(await dialogList()));
      drainNoise();
    }

    group('Confirming it ends the session and lands on the sign-in screen');
    {
      await ensureNoDialogs('before the sign-out confirmation');
      const opened = await waitUntil(async () => {
        if ((await dialogList()).some((d) => d.labelledby === 'sign-out-title')) return true;
        const r = await click('header [aria-label="Sign out"]');
        return r.clicked === true ? false : r;
      });
      check('the dialog is open', opened === true, JSON.stringify(await dialogList()));

      const clicked = await clickButtonIn('[aria-labelledby="sign-out-title"]', 'Log out');
      check('the confirm button exists and was clicked', clicked.clicked === true, JSON.stringify(clicked));

      // Generous, and deliberately so: the teardown waits out SIGNOUT_GRACE_MS for
      // Supabase before it redirects, and this machine may have no route to
      // Supabase at all. A test that fails because the network is slow is a test
      // about the network.
      //
      // The probe settles on "the navigation committed AND something rendered",
      // not on the path alone. The auth screen is a lazy chunk, so the path
      // changes while the document is still blank; returning on the path alone
      // would sample an empty DOM and report the sign-in screen as missing.
      // Waiting for either the sign-in screen or the error screen to appear tells
      // "arrived and wrong" apart from "not arrived yet" — opposite bugs that
      // must not look alike.
      const landed = await waitUntil(
        async () => {
          const state = await evaluate(`({
            path: location.pathname,
            signInVisible: /sign in|continue with/i.test(document.body.innerText),
            apiErrorVisible: /could not reach the api/i.test(document.body.innerText),
            sessionKeys: Object.keys(localStorage).filter((k) => /^(sb-|asc|ascension\\.)/.test(k)),
          })`);
          const v = state.value;
          return v?.path === '/login' && (v.signInVisible || v.apiErrorVisible) ? v : false;
        },
        { timeout: 15000 }
      );

      const detail = JSON.stringify(
        landed || (await evaluate(`({ path: location.pathname, sessionKeys: Object.keys(localStorage), text: document.body.innerText.slice(0, 120) })`)).value
      );
      check('the app redirected to the signed-out path', Boolean(landed), detail);
      check('the sign-in screen is shown', landed?.signInVisible === true, detail);
      check(
        'no "Could not reach the API" error screen',
        landed?.apiErrorVisible === false,
        'the session was not fully cleared, so the reload re-authenticated and failed to load a profile'
      );
      check('no session keys survive in localStorage', (landed?.sessionKeys?.length ?? -1) === 0, detail);

      const noiseSeen = drainNoise();
      check('nothing threw', noiseSeen.length === 0, noiseSeen.join(' | '));
    }

    group('A guest is never offered the destructive control');
    {
      await evaluate(`localStorage.clear()`);
      await navigate('/');
      await evaluate(`Array.from(document.querySelectorAll('button')).find((b) => /explore/i.test(b.innerText))?.click()`);
      await sleep(2500);
      drainNoise();
      const state = await evaluate(`({
        deleteControl: !!document.querySelector('header [aria-label="Delete account"]'),
        signOutControl: !!document.querySelector('header [aria-label="Sign out"]'),
      })`);
      check('the delete-account control is absent', state.value?.deleteControl === false, JSON.stringify(state.value));
      check('sign out remains available', state.value?.signOutControl === true, JSON.stringify(state.value));
      const noiseSeen = drainNoise();
      check('nothing threw', noiseSeen.length === 0, noiseSeen.join(' | '));
    }
  });
} catch (err) {
  failures += 1;
  console.log(`  FAIL  the browser could not be driven: ${err.message}`);
}

/* ---------------- the mobile pass ----------------
 *
 * The header used to overflow a phone: ~520px of shrink-0 controls in one
 * non-wrapping row against a 375px viewport, with the sign-out button off the
 * right edge of the screen. The fix moves everything non-essential into an
 * overflow menu below `sm`.
 *
 * Run at the smallest window headless Chrome reliably allows (~500px — see
 * gate.mjs on why CDP device emulation is not used). At 503px the layout is
 * already below `sm`, so every mobile-only branch is exercised, and the
 * assertions are chosen to be meaningful at any narrow width rather than at
 * one exact device size:
 *
 *   - nothing scrolls sideways (the user-visible failure);
 *   - the responsive switch happened (menu shown, desktop row hidden);
 *   - the header's INTRINSIC content fits a 375px phone — measured as the sum
 *     of its fixed children, gaps and padding, which does not depend on the
 *     width the window happened to get;
 *   - the menu itself works: opens, receives focus, Escape closes and restores
 *     focus, and its Sign out opens the same confirmation dialog as desktop.
 */

try {
  await withPage(
    browser,
    PORT,
    '/',
    async ({ evaluate, click, key, drainNoise, sleep, waitUntil }) => {
      group('Mobile layout: nothing scrolls sideways and the header fits');
      {
        await sleep(3000);
        const authFit = await evaluate(
          `({ iw: window.innerWidth, sw: document.documentElement.scrollWidth })`
        );
        check(
          'the sign-in screen does not scroll sideways',
          (authFit.value?.sw ?? 1e9) <= (authFit.value?.iw ?? 0),
          JSON.stringify(authFit.value)
        );

        await evaluate(
          `Array.from(document.querySelectorAll('button')).find((b) => /explore/i.test(b.innerText))?.click()`
        );
        await sleep(3000);
        drainNoise();

        const layout = await evaluate(`(() => {
          const menuBtn = document.querySelector('header [aria-label="More options"]');
          const desktopAbout = document.querySelector('header [aria-label="About and How It Works"]');
          return {
            mobileMq: matchMedia('(max-width: 639px)').matches,
            menuVisible: menuBtn ? menuBtn.getBoundingClientRect().width > 0 : null,
            desktopRowHidden: desktopAbout ? desktopAbout.getBoundingClientRect().width === 0 : null,
          };
        })()`);
        check('the viewport is in the mobile band', layout.value?.mobileMq === true, JSON.stringify(layout.value));
        check('the overflow-menu button is shown', layout.value?.menuVisible === true, JSON.stringify(layout.value));
        check('the desktop control row is hidden', layout.value?.desktopRowHidden === true, JSON.stringify(layout.value));

        const dashFit = await evaluate(
          `({ iw: window.innerWidth, sw: document.documentElement.scrollWidth })`
        );
        check(
          'the dashboard does not scroll sideways',
          (dashFit.value?.sw ?? 1e9) <= (dashFit.value?.iw ?? 0),
          JSON.stringify(dashFit.value)
        );

        // The viewport-independent fit check: the row's fixed content plus its
        // gaps and padding must fit the smallest common phone width, whatever
        // width this window actually got. The flex-1 spacer is excluded — its
        // job is to absorb slack, and it is exactly what shrinks.
        const intrinsic = await evaluate(`(() => {
          const row = document.querySelector('header > div');
          if (!row) return null;
          const cs = getComputedStyle(row);
          const gap = parseFloat(cs.columnGap) || 0;
          const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
          let fixed = 0;
          let visible = 0;
          for (const el of row.children) {
            if (getComputedStyle(el).display === 'none') continue;
            visible += 1;
            if (el.classList.contains('flex-1')) continue;
            fixed += el.getBoundingClientRect().width;
          }
          return { total: fixed + gap * (visible - 1) + pad, fixed, gap, pad, visible };
        })()`);
        check(
          'the header content fits a 375px phone',
          (intrinsic.value?.total ?? 1e9) <= 375,
          JSON.stringify(intrinsic.value)
        );

        const noiseBoot = drainNoise();
        check('nothing threw', noiseBoot.length === 0, noiseBoot.join(' | '));
      }

      group('Mobile menu: opens, focuses, closes, and signs out through the dialog');
      {
        drainNoise();
        const openResult = await click('header [aria-label="More options"]');
        check('the menu button is present and not covered', openResult.clicked === true, JSON.stringify(openResult));

        const menuOpen = await waitUntil(
          async () => (await evaluate(`!!document.querySelector('[role="menu"]')`)).value === true
        );
        check('the menu opens', Boolean(menuOpen));

        const focusInside = await evaluate(
          `document.activeElement?.closest('[role="menu"]') !== null`
        );
        check('focus moved into the menu', focusInside.value === true);

        const items = (await evaluate(
          `Array.from(document.querySelectorAll('[role="menuitem"]')).map((b) => b.innerText.trim())`
        )).value ?? [];
        check('About is offered', items.some((t) => /about/i.test(t)), JSON.stringify(items));
        check('Feedback is offered', items.some((t) => /feedback/i.test(t)), JSON.stringify(items));
        check('sound is offered', items.some((t) => /sound/i.test(t)), JSON.stringify(items));
        check('Sign out is offered', items.some((t) => /sign out/i.test(t)), JSON.stringify(items));
        check('Delete account is NOT offered to a guest', !items.some((t) => /delete/i.test(t)), JSON.stringify(items));

        await key('Escape');
        const closed = await waitUntil(
          async () => (await evaluate(`!!document.querySelector('[role="menu"]')`)).value === false
        );
        check('Escape closes the menu', Boolean(closed));
        const focusBack = await evaluate(
          `document.activeElement === document.querySelector('header [aria-label="More options"]')`
        );
        check('focus returns to the trigger', focusBack.value === true);

        // Sign out from the menu must land on the same confirmation dialog as
        // the desktop button — matched on the dialog's question, not on pixels.
        await click('header [aria-label="More options"]');
        await waitUntil(async () => (await evaluate(`!!document.querySelector('[role="menu"]')`)).value === true);
        const signOutClicked = await evaluate(`(() => {
          const item = Array.from(document.querySelectorAll('[role="menuitem"]'))
            .find((b) => (b.innerText || '').trim().toLowerCase() === 'sign out');
          if (!item) return { missing: true };
          item.click();
          return { clicked: true };
        })()`);
        check('the menu Sign out exists and was clicked', signOutClicked.value?.clicked === true, JSON.stringify(signOutClicked.value));

        const dialogShown = await waitUntil(async () =>
          (await evaluate(`Array.from(document.querySelectorAll('[role="dialog"]'))
            .some((d) => /log out/i.test(d.innerText || ''))`)).value === true
        );
        check('the confirmation dialog opens', Boolean(dialogShown));
        // The menu's exit animation keeps it in the DOM for ~140ms after it
        // closes, so this waits for gone rather than sampling once.
        const menuGone = await waitUntil(
          async () => (await evaluate(`!!document.querySelector('[role="menu"]')`)).value === false
        );
        check('the menu closed behind the dialog', Boolean(menuGone));

        await key('Escape');
        await waitUntil(async () =>
          (await evaluate(`document.querySelectorAll('[role="dialog"]').length`)).value === 0
        );

        const noiseSeen = drainNoise();
        check('nothing threw', noiseSeen.length === 0, noiseSeen.join(' | '));
      }
    },
    { window: '500,900', settle: 5000 }
  );
} catch (err) {
  failures += 1;
  console.log(`  FAIL  the mobile pass could not be driven: ${err.message}`);
} finally {
  stopServer();
}

console.log(`\n${failures === 0 ? 'all interactions verified' : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
