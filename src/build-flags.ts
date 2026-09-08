/**
 * Compile-time build flags, injected via Vite `define`.
 *
 * `__MOVI_SLIM__` is `true` only in the slim entry's build (see
 * scripts/build-standalone.js), `false` everywhere else. The `typeof` guard
 * keeps a bare `tsc` / vitest run — where no define happens — from throwing.
 * Because the value is a literal after `define`, the dead branch tree-shakes
 * away, so the default build carries none of the slim-only code.
 */
declare const __MOVI_SLIM__: boolean | undefined;

/**
 * The slim build ships the WASM as a separate `movi-slim.wasm` (streamed,
 * cached) instead of base64-embedded, and — because a consumer may not host
 * that extra file — auto-falls back to native `<video>` playback when the WASM
 * engine can't be loaded, even without a `fallback="native"` attribute.
 */
export const IS_SLIM: boolean =
  typeof __MOVI_SLIM__ !== "undefined" ? __MOVI_SLIM__ : false;

/**
 * Which bundle is running: `"slim"` (WASM streamed from a separate
 * `movi.wasm`) or `"full"` (WASM embedded in the JS).
 *
 * Deliberately NOT folded into {@link VERSION} — both builds ship the same
 * release, and a `0.4.0+slim` string would break every consumer that compares
 * versions for equality. This is the separate axis, and the one worth having in
 * a bug report: the two bundles differ in how the engine loads and in what
 * happens when it can't.
 */
export const BUILD: "slim" | "full" = IS_SLIM ? "slim" : "full";
