<!--
  movi-player/svelte — a typed <source> for a <MoviPlayer> child list. Maps its
  friendly props to the attributes the element parses (`height` → `data-height`,
  `srcLang` → `srclang`, `isDefault` → `data-default`).

  Svelte forwards unknown attributes to native elements without complaint, so a
  raw <source data-height="1080" srclang="en"> works too — this just gives you
  typed props and autocomplete.

  NOTE: the prop is `isDefault`, not `default` — `default` is a reserved word
  and cannot be a Svelte prop name.

    <script>
      import MoviPlayer from "movi-player/svelte";
      import MoviSource from "movi-player/svelte/MoviSource";
    </script>
    <MoviPlayer controls>
      <MoviSource src="4k.mp4" height={2160} badge="HDR" isDefault />
      <MoviSource src="en.m4a" kind="audio" srcLang="en" label="English" />
    </MoviPlayer>
-->
<script lang="ts">
  export let src: string;
  export let type: string | undefined = undefined;
  export let kind: "audio" | undefined = undefined;
  export let srcLang: string | undefined = undefined;
  export let label: string | undefined = undefined;
  export let height: number | undefined = undefined;
  export let fps: number | undefined = undefined;
  export let badge: string | undefined = undefined;
  export let bandwidth: number | undefined = undefined;
  export let isDefault = false;
</script>

<source
  {src}
  {type}
  {kind}
  {label}
  srclang={srcLang}
  data-height={height}
  data-fps={fps}
  data-badge={badge}
  data-bandwidth={bandwidth}
  data-default={isDefault ? "" : undefined}
/>
