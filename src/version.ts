/**
 * The package version, baked in at build time.
 *
 * `__MOVI_VERSION__` is replaced with the literal string from package.json by
 * the Vite `define` in scripts/build-standalone.js (production) and
 * vite.config.ts (dev server). The `typeof` guard keeps a plain `tsc` /
 * vitest run — where the define never happens — from throwing a
 * ReferenceError; it falls back to a clearly-not-a-release marker instead.
 */
declare const __MOVI_VERSION__: string | undefined;

export const VERSION: string =
  typeof __MOVI_VERSION__ !== "undefined" ? __MOVI_VERSION__ : "0.0.0-dev";
