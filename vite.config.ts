import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
).version;

// Production build is handled by scripts/build-standalone.js (not this config)
// This config is only used for dev server (vite dev) and vitest
export default defineConfig({
  // Keep the dev server / vitest in sync with the same version define the
  // production build injects, so MoviElement.version works there too.
  define: {
    __MOVI_VERSION__: JSON.stringify(pkgVersion),
  },
  worker: {
    format: 'es',
  },
  // Don't let Vite pre-bundle the generated WASM glue into node_modules/.vite.
  // It's a ~6 MB emscripten module rebuilt via `npm run build:wasm`; if Vite
  // caches it as an optimized dep, the dev server keeps serving a STALE copy
  // after a WASM rebuild (no [movi] logs, old behaviour). Excluding it makes
  // the dev server always read the fresh dist/wasm/movi.js.
  optimizeDeps: {
    exclude: ['movi'],
  },
  server: {
    allowedHosts: true,
    // Black-box runs start the dev server with MOVI_DEV_NO_HMR=1. With HMR on,
    // saving any watched source file reloads the page under test mid-session:
    // on 2026-09-15 an edit to src/source/HttpSource.ts during the Good Will
    // Hunting run re-initialised the element and the report read it as "middle
    // seek never recovers". hmr:false stops file changes from reaching the
    // page; scripts/blackbox-page-guard.mjs still names any reload that slips
    // through (e.g. a vite.config.ts edit, which restarts the server).
    hmr: process.env.MOVI_DEV_NO_HMR === '1' ? false : undefined,
    watch: {
      // A crash dump must not be able to kill the dev server. Git Bash drops
      // `bash.exe.stackdump` in the CWD when it faults, and Windows keeps that
      // file locked while it is being written; chokidar's watcher then throws
      // EBUSY on it, and the error propagates out of the FSWatcher and takes
      // the whole `vite` process down. Observed twice on 2026-09-15, both
      // times presenting as "dev server started, then silently died" — which
      // reads like a harness failure, not a stray file. Also covers the
      // black-box run artefacts, which change constantly during a sweep and
      // are of no interest to HMR.
      ignored: ['**/*.stackdump', '**/.blackbox-results/**', '**/coverage/**'],
    },
    headers: {
      // 'same-origin-allow-popups' (not 'same-origin') so Google Identity
      // Services OAuth popups can post the token back to the opener — plain
      // 'same-origin' severs that link and GIS falsely reports 'popup_closed'.
      // COEP is intentionally NOT set: it's only useful together with
      // COOP 'same-origin' to earn crossOriginIsolated (SharedArrayBuffer),
      // which we've given up here — and 'require-corp' both blocks cross-origin
      // subresources and further breaks the OAuth popup. The player does NOT
      // need SAB: single-threaded WASM + Asyncify I/O, HttpSource plain-buffer
      // fallback. SAB was only a zero-copy optimisation.
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
  },
});
