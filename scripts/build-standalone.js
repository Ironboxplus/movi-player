/**
 * Build script for standalone modular bundles
 * Builds each entry point separately to avoid shared chunks
 */

import { build } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import terser from '@rollup/plugin-terser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
// `join`/`readdir`/`rm` are ours — the stale worker-asset sweep below needs
// them; the sync fs calls are upstream's, for the slim/external-WASM outputs.
import { readdir, rm } from 'fs/promises';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

// Bake the package version into the bundle so it can be read at runtime
// (MoviElement.version / VERSION export), jQuery-style.
const PKG_VERSION = JSON.parse(
  readFileSync(resolve(rootDir, 'package.json'), 'utf8'),
).version;

const entries = [
  { name: 'demuxer', path: 'src/demuxer.ts' },
  { name: 'player', path: 'src/player.ts' },
  { name: 'element', path: 'src/element.ts' },
  { name: 'index', path: 'src/index.ts' },
  // Slim build: same <movi-player>, but the WASM ships as a separate
  // movi-slim.wasm (streamed) instead of embedded, and playback auto-falls back
  // to native <video> when that WASM isn't available. `slim: true` swaps the
  // WASM glue via alias and flips the __MOVI_SLIM__ define below.
  { name: 'element.slim', path: 'src/element-slim.ts', slim: true },
];

async function removeStaleAudioWorkerAssets() {
  const assetsDir = join(rootDir, 'dist', 'assets');
  let files = [];
  try {
    files = await readdir(assetsDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  await Promise.all(
    files
      .filter((file) => /^SoftwareAudioDecoder\.worker-[\w-]+\.js$/.test(file))
      .map((file) => rm(join(assetsDir, file), { force: true })),
  );
}

// Rewrites every console.log/info/warn/error/debug call site to
// globalThis.__movilog?.<level>(...). We do this BEFORE terser runs:
// terser's drop_console only matches the literal console.* property
// path, so once rewritten the calls survive minification and reach
// the on-page dev console panel at runtime (see app/index.html).
//
// Lives as a Rollup plugin (renderChunk) so it sees the merged bundle
// after tree-shaking but before minification.
const movilogRewritePlugin = () => ({
  name: 'movilog-rewrite',
  renderChunk(code) {
    if (!/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(code)) return null;
    const out = code.replace(
      /\bconsole\.(log|info|warn|error|debug)(\s*)\(/g,
      'globalThis.__movilog?.$1$2(',
    );
    return { code: out, map: null };
  },
});

const terserConfig = {
  compress: {
    drop_console: true,
    drop_debugger: true,
    passes: 5,
    unsafe: false,
    unsafe_comps: false,
    unsafe_math: false,
    unsafe_methods: false,
    unsafe_proto: false,
    unsafe_regexp: false,
    unsafe_undefined: false,
    dead_code: true,
    unused: true,
    collapse_vars: true,
    evaluate: true,
    reduce_vars: true,
    inline: 2,
    keep_infinity: false,
  },
  mangle: {
    toplevel: false,
    eval: false,
    keep_classnames: true,
    keep_fnames: false,
    reserved: [
      'Movi',
      'Module',
      'FS',
      'HEAP',
      'HEAPU8',
      'HEAP32',
      'HEAPF64',
      'createMoviModule',
      'startsWith',
      'endsWith',
      'locateFile',
      'wasmBinary',
    ],
  },
  format: {
    comments: false,
    beautify: false,
    ascii_only: false,
  },
};

async function buildEntry(entry, format) {
  const formatExt = format === 'es' ? 'js' : format;
  console.log(`Building ${entry.name}.${formatExt}...`);

  await build({
    configFile: false,
    base: './',
    define: {
      __MOVI_VERSION__: JSON.stringify(PKG_VERSION),
      // Literal so the dead branch tree-shakes out of the default build.
      __MOVI_SLIM__: entry.slim ? 'true' : 'false',
    },
    // The slim entry swaps the embedded WASM glue (dist/wasm/movi.js, base64
    // inside) for the external-WASM glue (dist/wasm/external/movi.js, which
    // streams external/movi.wasm). A regex alias so it matches the relative
    // specifier FFmpegLoader imports ("../../dist/wasm/movi.js"), not just an
    // absolute path — string aliases run against the raw specifier.
    ...(entry.slim
      ? {
          resolve: {
            alias: [
              {
                find: /\/dist\/wasm\/movi\.js$/,
                replacement: '/dist/wasm/external/movi.js',
              },
            ],
          },
        }
      : {}),
    plugins: [
      // Only generate types once for ES format
      ...(format === 'es'
        ? [
            dts({
              insertTypesEntry: true,
              entryRoot: 'src',
              include: [entry.path],
            }),
          ]
        : []),
    ],
    build: {
      // Native class fields output (no __publicField helper). Required
      // by the post-build harden pass: terser's property mangler
      // rewrites `this._foo` accesses, but it does NOT rename the
      // string literal inside `__publicField(this, "_foo", ...)`. With
      // the helper in play, the mangled getter looks up a property
      // that was never installed under its new name → undefined at
      // runtime. All WebCodecs-supporting browsers ship class fields,
      // so dropping the helper costs nothing.
      target: 'es2022',
      // The slim build's whole point is to NOT carry the WASM in the JS. Vite
      // otherwise base64-inlines the movi.wasm that external/movi.js references
      // via `new URL(..., import.meta.url)` — re-embedding exactly what we split
      // out. 0 forces it to be emitted as a separate asset instead.
      ...(entry.slim ? { assetsInlineLimit: 0 } : {}),
      lib: {
        entry: resolve(rootDir, entry.path),
        name: 'Movi',
        formats: [format],
        fileName: () => `${entry.name}.${formatExt}`,
      },
      rollupOptions: {
        external: [],
        // Order matters: rewrite console.* → __movilog FIRST, then terser.
        // Terser disabled for the "no-harden" diagnostic build — toggle via
        // env var MOVI_NO_HARDEN=1. Keeps the movilog rewrite (so consoles
        // still pipe to the extension/output channel) but skips the
        // dead-code / inline / mangle passes that we suspect change
        // Asyncify timing in production.
        plugins: process.env.MOVI_NO_HARDEN === "1"
          ? [movilogRewritePlugin()]
          : [movilogRewritePlugin(), terser(terserConfig)],
        output: {
          globals: {},
          assetFileNames: (assetInfo) => {
            if (assetInfo.name?.endsWith('.wasm')) {
              return 'wasm/[name][extname]';
            }
            return '[name][extname]';
          },
        },
      },
      sourcemap: false,
      minify: false,
      emptyOutDir: false,
      chunkSizeWarningLimit: 10000,
      outDir: resolve(rootDir, 'dist'),
    },
  });
}

/**
 * Un-inline the WASM from the slim bundle.
 *
 * Vite's library mode base64-inlines the movi.wasm that external/movi.js
 * references via `new URL(..., import.meta.url)`, ignoring assetsInlineLimit —
 * a lib has no stable base URL to emit assets against, so it always inlines.
 * That re-embeds exactly what the slim build exists to split out.
 *
 * So we do it after the fact, deterministically: replace the inlined data URL
 * (the FIRST arg of `new URL(...)`) with a plain "movi.wasm" reference, leaving
 * the SECOND arg — Vite's own base resolution, `import.meta.url` for ESM and a
 * document/require expression for CJS — untouched, so both formats resolve the
 * file next to their own bundle. Then drop movi.wasm beside them.
 */
function externalizeSlimWasm() {
  const wasmSrc = resolve(rootDir, 'dist/wasm/external/movi.wasm');
  if (!existsSync(wasmSrc)) {
    throw new Error(
      `Slim build: ${wasmSrc} is missing — run \`npm run build:wasm\` first ` +
        `(it emits dist/wasm/external/movi.{js,wasm}).`,
    );
  }
  copyFileSync(wasmSrc, resolve(rootDir, 'dist/movi.wasm'));

  const dataUrl = /new URL\("data:application\/wasm;base64,[A-Za-z0-9+/=]+"/g;
  for (const file of ['dist/element.slim.js', 'dist/element.slim.cjs']) {
    const p = resolve(rootDir, file);
    const before = readFileSync(p, 'utf8');
    const after = before.replace(dataUrl, 'new URL("movi.wasm"');
    if (after === before) {
      throw new Error(
        `Slim build: no inlined WASM data URL found in ${file} to externalize ` +
          `— the Vite inlining behaviour may have changed; re-check the fixup.`,
      );
    }
    writeFileSync(p, after);
  }
  console.log('✓ slim WASM externalized → dist/movi.wasm (bundle no longer embeds it)');
}

async function buildAll() {
  console.log('Building standalone modular bundles...\n');
  await removeStaleAudioWorkerAssets();

  let builtSlim = false;
  for (const entry of entries) {
    // Build ES format
    await buildEntry(entry, 'es');

    // Build CJS format
    await buildEntry(entry, 'cjs');

    if (entry.slim) builtSlim = true;
    console.log(`✓ ${entry.name} built\n`);
  }

  if (builtSlim) externalizeSlimWasm();

  console.log('✓ All standalone bundles built successfully!');
}

buildAll().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
