/**
 * movi-player/vue — a thin, typed Vue 3 wrapper around the <movi-player> web
 * component. Reflects props → attributes, wires the player's events to Vue
 * emits, and exposes the underlying element via a template ref.
 * Ships as a subpath of the main package: `npm i movi-player`, no extra install.
 *
 *   import { MoviPlayer } from "movi-player/vue";
 *   <MoviPlayer src="video.mkv" controls autoplay @qoe="onQoe" />
 *
 * Note: register `movi-player` as a custom element in your Vue build so it
 * isn't treated as a component, e.g.
 *   app.config.compilerOptions.isCustomElement = (t) => t === "movi-player";
 * (or the equivalent `@vitejs/plugin-vue` option). This wrapper renders it via
 * a render function, so the flag is only needed if you also use the raw tag.
 *
 * This entry registers the default build, whose FFmpeg WASM is embedded in the
 * JS. For the slim build (separate, cacheable movi.wasm) import
 * `movi-player/vue/slim` instead — same components, same props.
 */
import "movi-player/element"; // registers <movi-player> (side effect)

export * from "./wrapper.js";
