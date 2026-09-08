# movi-player framework wrappers

Thin, typed wrappers around the `<movi-player>` web component so you can drop the
player into React, Vue, or Svelte with real prop/event typing instead of an
untyped custom element. Every wrapper is a shim over the same engine — the
codec/VR/encrypted feature set is identical; only the ergonomics change.

They ship inside the main package as subpath entries — `npm i movi-player` and
import from `movi-player/<framework>`. No extra package to install; your own
`react` / `vue` / `svelte` (declared optional peers) is the only other dep.

| Framework | Import | Slim build |
| --- | --- | --- |
| React | `import { MoviPlayer } from "movi-player/react"` | `movi-player/react/slim` |
| Vue 3 | `import { MoviPlayer } from "movi-player/vue"` | `movi-player/vue/slim` |
| Svelte | `import MoviPlayer from "movi-player/svelte"` | `movi-player/svelte/slim` |

## Slim build

Each wrapper has a `/slim` twin — same components, same props, same events. The
only difference is which element build it registers: the default entry embeds
the FFmpeg WASM in the JS (~11.4 MB), the slim entry keeps it as a separate
`movi.wasm` (~4.2 MB JS + 5.6 MB WASM) that streams, compiles, and caches on its
own.

```tsx
import { MoviPlayer } from "movi-player/react/slim";

<MoviPlayer src="video.mkv" controls wasmurl="/movi.wasm" />;
```

You host `movi.wasm` yourself — it ships at `movi-player/dist/movi.wasm`.
Bundlers that understand `new URL("movi.wasm", import.meta.url)` (Vite, webpack
5, Parcel 2) emit it automatically; otherwise copy it next to your bundle, or
point `wasmurl` at wherever you host it. If the WASM can't be fetched at all,
playback falls back to the browser's native `<video>` on its own.

Don't import both entries in one app — the second one to load finds
`<movi-player>` already defined, so it registers nothing while still shipping its
copy of the engine.

## React

```tsx
import { MoviPlayer } from "movi-player/react";

<MoviPlayer
  src="video.mkv"
  controls
  autoplay
  theme="dark"
  onQoe={(e) => console.log(e.type, e)}
  onReady={(el) => console.log("duration", el.duration)}
/>;
```

`ref` forwards the underlying `MoviElement`, so `ref.current.play()`,
`ref.current.getQoeSession()`, etc. all work and are typed.

## Vue 3

```vue
<script setup lang="ts">
import { MoviPlayer } from "movi-player/vue";
</script>

<template>
  <MoviPlayer src="video.mkv" controls autoplay @qoe="(e) => console.log(e)" />
</template>
```

## Svelte

```svelte
<script>
  import MoviPlayer from "movi-player/svelte";
  let player;
</script>

<MoviPlayer bind:element={player} src="video.mkv" controls autoplay
  on:movi-qoe={(e) => console.log(e.detail)} />
```

## Plain web component (no framework)

```ts
import "movi-player/element"; // registers <movi-player>
const el = document.querySelector("movi-player")!; // typed as MoviElement
el.setAnalyticsBeacon("/qoe"); // POST QoE events
```

## QoE analytics

Every wrapper surfaces the `movi-qoe` event stream (`session_start`, `startup`,
`rebuffer`, `bitrate_switch`, `decode_fallback`, `error`, `heartbeat`, `ended`).
Forward it to Mux / GA4 / your endpoint, or use the built-in beacon sink:

```ts
import { beaconSink } from "movi-player/element";
el.addQoeSink(beaconSink("https://example.com/qoe"));
```

## Theming

Override the documented `--movi-*` custom properties from anywhere in your CSS:

```css
movi-player {
  --movi-primary: #7c5cff;   /* accent / progress fill */
  --movi-chrome-fg: #eaeaea; /* control-bar text/icons */
  --movi-surface: #14141c;   /* menu / panel background */
  --movi-btn-size: 40px;
}
```
