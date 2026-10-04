import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build-time configuration guard.
 *
 * Vite inlines every VITE_ variable into the bundle at build time, so a
 * production build against an unconfigured .env succeeds and ships a client that
 * cannot sign anybody in. The failure then appears as a live site whose login
 * form does nothing — the most expensive kind of deployment bug, because nothing
 * about the deploy looks wrong.
 *
 * The server already refuses to boot without real credentials
 * (server/src/config/env.js). This is the same rule for the browser half, and it
 * runs while Vite is reading its config, before a single module is transformed,
 * so a broken build never produces an artefact at all.
 *
 * Only enforced for `vite build`. In development a missing key still gets you a
 * running dev server, because the sign-in screen explains exactly what to set and
 * a hard failure there is just an obstacle.
 */

/** Values shipped in .env.example, which means "copied but never filled in". */
const PLACEHOLDERS = ['your-anon-key', 'your-project-ref', ''];

function assertNoPhantomDeps() {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const declared = Object.keys(pkg.dependencies ?? {});

  // Every import across src, including dynamic ones.
  const source = walk(resolve(process.cwd(), 'src'))
    .filter((f) => /\.jsx?$/.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  const imported = new Set();
  for (const m of source.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.')) continue;
    // Scoped packages keep both segments: @scope/name/sub -> @scope/name
    const parts = spec.split('/');
    imported.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }

  const unused = declared.filter((d) => !imported.has(d));
  if (unused.length === 0) return;

  throw new Error(
    '\n\n' +
      '  REFUSING TO BUILD - unused dependencies are declared.\n\n' +
      unused.map((d) => `    x ${d} is in package.json but nothing in src/ imports it`).join('\n') +
      '\n\n' +
      '  An unused dependency is not free: it is installed, updated, audited and\n' +
      '  eligible for its own CVEs, forever, while contributing nothing to the\n' +
      '  bundle. If it was added for a feature that has since been removed, delete\n' +
      '  it here and re-run `npm install` to prune the lockfile.\n\n'
  );
}

/** Recursively collect files under a directory. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

function assertClientEnvForBuild(env) {
  const url = (env.VITE_SUPABASE_URL ?? '').trim();
  const anonKey = (env.VITE_SUPABASE_ANON_KEY ?? '').trim();

  const problems = [];
  if (!url) problems.push('VITE_SUPABASE_URL is missing or blank');
  else if (url.includes('your-project-ref')) {
    problems.push('VITE_SUPABASE_URL is still the placeholder from .env.example');
  }
  if (!anonKey) problems.push('VITE_SUPABASE_ANON_KEY is missing or blank');
  else if (PLACEHOLDERS.includes(anonKey)) {
    problems.push('VITE_SUPABASE_ANON_KEY is still the placeholder from .env.example');
  }

  if (problems.length === 0) return;

  throw new Error(
    '\n\n' +
      '  REFUSING TO BUILD — the client is not configured.\n\n' +
      problems.map((p) => `    x ${p}`).join('\n') +
      '\n\n' +
      '  Vite inlines VITE_ variables into the bundle, so this build would ship a site\n' +
      "  whose sign-in form cannot authenticate anyone. Fill in client/.env first:\n\n" +
      '    VITE_SUPABASE_URL        Project Settings -> API\n' +
      '    VITE_SUPABASE_ANON_KEY   Project Settings -> API -> anon (publishable)\n\n' +
      '  Both are safe to expose. Never put the service_role or Gemini keys in this\n' +
      '  file — everything here is shipped to every visitor.\n\n' +
      '  To build anyway (e.g. just to check the bundle compiles), use:\n' +
      '    vite build --mode development\n' +
      '  On a CI runner, set the two variables as build-time environment variables.\n\n'
  );
}

export default defineConfig(({ mode }) => {
  // loadEnv rather than process.env: Vite's own precedence is that .env files win
  // over the ambient shell, and reading it any other way would let a stale shell
  // variable satisfy a check that the bundle it actually produced then fails.
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  if (mode === 'production') assertClientEnvForBuild(env);

  // Unconditional, unlike the env check: a phantom dependency is a defect in every
  // mode, and `vite dev` is exactly when someone adds a library and forgets to
  // remove it again.
  assertNoPhantomDeps();

  return {
    plugins: [react()],
    server: {
      port: 5173,
      /**
       * strictPort: fail instead of quietly moving.
       *
       * Vite's default behaviour when 5173 is taken is to take 5174 and say
       * nothing beyond the new URL in its banner. That single silent move was the
       * root cause of a CORS outage: the API's allowlist said 5173, the browser
       * was loading from 5174, every /api call failed preflight, and the error
       * named neither port — "No 'Access-Control-Allow-Origin' header is
       * present". Refusing to start turns that into an immediate, unambiguous
       * "Port 5173 is already in use", which takes seconds to diagnose.
       *
       * Note this makes `npm run dev` fail hard if something else holds the port.
       * That is the correct trade: an app that silently moved to a port other
       * services and configs do not know about is worse than one that declines
       * to start. Free the port, or pass `--port` deliberately.
       */
      strictPort: true,
      proxy: {
        // Lets the client call /api/* on the same origin during development,
        // which sidesteps CORS entirely while you are working locally.
        //
        // The target is normalised the same way src/lib/api.js normalises it, so
        // VITE_API_URL may be written with or without a trailing /api and both
        // resolve to a single /api prefix. Without this, a /api-terminated value
        // produced /api/api/profile and a 404 whose message named neither cause.
        '/api': {
          target: (env.VITE_API_URL || 'http://localhost:4000').replace(/\/api\/?$/, ''),
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      // A source map embeds the full original source of every module, so shipping
      // one to production publishes that source to anyone who asks for it. The map
      // is still generated locally for debugging; publishing is opt-in via
      // VITE_PUBLISH_SOURCEMAPS=true, which is what an error-monitoring deploy
      // wants and a normal one does not.
      sourcemap: env.VITE_PUBLISH_SOURCEMAPS === 'true',
      rollupOptions: {
        output: {
          /**
           * Vendor chunking.
           *
           * The point is cache lifetime, not raw size. Every file emitted under a
           * content hash is re-downloaded by a returning user the moment that
           * hash changes, so an app-code change should not invalidate the ~300 KB
           * of third-party code that did not change with it. Splitting by package
           * gives each dependency its own long-lived chunk.
           *
           * Matched on the module id rather than listed by entry name, because the
           * Supabase SDK is really five packages with shared transitive
           * dependencies (realtime-js, storage-js, auth-js and the crypto helpers
           * they pull in) and an entry-name list would scatter them across the
           * entry chunk and vendor alike.
           *
           * Both `[\\/]` forms are matched: Rollup reports ids with forward
           * slashes, but being explicit costs nothing and keeps this correct if
           * that ever differs by platform. `react[\\/]` deliberately does NOT match
           * `react-dom`-style siblings it was not asked for — the trailing slash
           * is what pins it to the package directory and stops `react-is` or
           * `react-refresh` from being swept in.
           */
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;

            if (/node_modules[\\/]@?supabase[\\/]/.test(id)) return 'supabase';
            if (/node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) {
              return 'motion';
            }
            if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
            if (/node_modules[\\/]lucide-react[\\/]/.test(id)) return 'icons';

            // Dynamically imported by lib/confetti.js on the first celebration.
            // Giving it its own chunk — rather than letting the catch-all sweep
            // it into the statically loaded vendor bucket — is what keeps that
            // laziness real: a chunk is only fetched when something imports it,
            // and nothing imports this one at boot.
            if (/node_modules[\\/]canvas-confetti[\\/]/.test(id)) return 'confetti';

            return 'vendor';
          },
        },
      },
    },
  };
});
