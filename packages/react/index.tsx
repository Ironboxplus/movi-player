/**
 * movi-player/react — a thin, typed React wrapper around the <movi-player>
 * web component. Reflects props → attributes/properties, wires the player's
 * events to React callbacks, and forwards a ref to the underlying element.
 * Ships as a subpath of the main package: `npm i movi-player`, no extra install.
 *
 *   import { MoviPlayer } from "movi-player/react";
 *   <MoviPlayer src="video.mkv" controls autoplay onQoe={console.log} />
 *
 * This entry registers the default build, whose FFmpeg WASM is embedded in the
 * JS. For the slim build (separate, cacheable movi.wasm) import
 * `movi-player/react/slim` instead — same components, same props.
 */
import "movi-player/element"; // registers <movi-player> (side effect)

export * from "./wrapper.js";
