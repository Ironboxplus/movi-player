/**
 * movi-player/vue/slim — the same Vue 3 wrapper as `movi-player/vue`, on top of
 * the slim element build: the FFmpeg WASM ships as a separate `movi.wasm`
 * instead of embedded in the JS, so the bundle is ~4.2 MB rather than ~11.4 MB
 * and the engine streams+compiles from a cacheable asset.
 *
 *   import { MoviPlayer } from "movi-player/vue/slim";
 *   <MoviPlayer src="video.mkv" controls wasmurl="/movi.wasm" />
 *
 * You host `movi.wasm` yourself (it ships at `movi-player/dist/movi.wasm`).
 * Bundlers that understand `new URL("movi.wasm", import.meta.url)` emit it
 * automatically; otherwise copy it next to your bundle or point the `wasmurl`
 * attribute at it. If the WASM can't be fetched, playback falls back to the
 * browser's native <video> on its own.
 */
import "movi-player/element/slim"; // registers <movi-player> (side effect)

export * from "./wrapper.js";
