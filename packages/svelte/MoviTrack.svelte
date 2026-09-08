<!--
  movi-player/svelte — a typed <track> (subtitles / captions) for a <MoviPlayer>
  child list. `format` maps to the non-standard `data-format` the element reads.

  NOTE: the prop is `isDefault`, not `default` (reserved word in Svelte).

    <script>
      import MoviPlayer from "movi-player/svelte";
      import MoviTrack from "movi-player/svelte/MoviTrack";
    </script>
    <MoviPlayer src="video.mp4" controls>
      <MoviTrack src="en.vtt" srcLang="en" label="English" isDefault />
    </MoviPlayer>
-->
<script lang="ts">
  export let src: string;
  export let kind: "subtitles" | "captions" = "subtitles";
  export let srcLang: string | undefined = undefined;
  export let label: string | undefined = undefined;
  export let format: "vtt" | "srt" | undefined = undefined;
  export let isDefault = false;
</script>

<track
  {src}
  {kind}
  {label}
  srclang={srcLang}
  data-format={format}
  data-default={isDefault ? "" : undefined}
/>
