<!--
  movi-player/svelte/slim — the same wrapper as movi-player/svelte, on top of
  the slim element build: the FFmpeg WASM ships as a separate movi.wasm instead
  of embedded in the JS, so the bundle is ~4.2 MB rather than ~11.4 MB and the
  engine streams+compiles from a cacheable asset.

    <script>
      import MoviPlayer from "movi-player/svelte/slim";
    </script>
    <MoviPlayer src="video.mkv" controls wasmurl="/movi.wasm" />

  You host movi.wasm yourself (it ships at movi-player/dist/movi.wasm). Bundlers
  that understand new URL("movi.wasm", import.meta.url) emit it automatically;
  otherwise copy it next to your bundle or point the wasmurl attribute at it. If
  the WASM can't be fetched, playback falls back to the browser's native <video>
  on its own.

  Svelte components ship as source, so this is a deliberate copy of
  MoviPlayer.svelte with one line changed (the element import). Keep the two in
  sync — any markup/event change here belongs there too.
-->
<script lang="ts">
  import "movi-player/element/slim"; // registers <movi-player> (side effect)
  import type { MoviElement } from "movi-player/element";

  /** The underlying element instance (bind:element to reach the player API). */
  export let element: MoviElement | null = null;
</script>

<!-- The default slot forwards <source>/<track> children to the element for
     multi-quality, external audio, and subtitles. -->
<movi-player
  bind:this={element}
  {...$$restProps}
  on:timeupdate
  on:play
  on:pause
  on:ended
  on:error
  on:errordisplay
  on:movi-qoe
>
  <slot />
</movi-player>
