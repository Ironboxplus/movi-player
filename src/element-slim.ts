/**
 * Movi Element — slim build entry.
 *
 * Same `<movi-player>` element and the exact same API as `movi-player/element`;
 * only how the WASM ships differs. The build wires two things onto this entry
 * (see scripts/build-standalone.js):
 *
 *   1. an alias that swaps the embedded `dist/wasm/movi.js` for
 *      `dist/wasm/movi-slim.js`, so the FFmpeg WASM streams+compiles from a
 *      separate `movi-slim.wasm` asset instead of a base64 blob inside the JS —
 *      a far smaller bundle and a cacheable, streaming-compiled engine.
 *   2. the `__MOVI_SLIM__` define, which turns on automatic native `<video>`
 *      fallback: because a consumer may not host the extra `.wasm`, a source the
 *      WASM engine can't open falls through to native playback on its own, with
 *      no `fallback="native"` attribute required. HLS/DASH already play via
 *      Shaka without the WASM, so those keep working regardless.
 *
 * Consumers load THIS file instead of `element.js` and additionally host
 * `movi-slim.wasm` next to it. Everything they write against `<movi-player>`
 * stays identical.
 */
export * from "./element";
