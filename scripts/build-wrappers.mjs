// Builds the framework wrappers into the main package's dist as subpath entries:
//   movi-player/react   ← packages/react/index.tsx      (React.createElement, no JSX)
//   movi-player/vue     ← packages/vue/index.ts         (h() render fn)
//   movi-player/svelte  ← packages/svelte/MoviPlayer.svelte (shipped as source)
//
// Each also has a `/slim` twin (movi-player/react/slim, …) — identical wrapper
// code, but it registers the slim element build (external movi.wasm) instead of
// the embedded one. React/Vue keep the shared implementation in wrapper.tsx /
// wrapper.ts and the entries are one-line shells; Svelte ships components as
// source, so MoviPlayerSlim.svelte is a maintained copy.
//
// react/vue are transpiled with esbuild (types stripped; react/vue/movi-player
// stay as external imports the consumer resolves). Their .tsx/.ts source is
// copied alongside as the `types` target — TypeScript reads it directly and the
// consumer already has the framework types + movi-player/element (self-ref).
// Svelte components are distributed as source; the consumer's compiler builds it.
import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";

const dirs = ["dist/react", "dist/vue", "dist/svelte"];
for (const d of dirs) mkdirSync(d, { recursive: true });

async function transpile(entry, outfile) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: false, // single file, only external imports — leave them as-is
    format: "esm",
    target: "es2020",
    logLevel: "warning",
  });
}

await transpile("packages/react/wrapper.tsx", "dist/react/wrapper.js");
await transpile("packages/react/index.tsx", "dist/react/index.js");
await transpile("packages/react/slim.tsx", "dist/react/slim.js");
await transpile("packages/vue/wrapper.ts", "dist/vue/wrapper.js");
await transpile("packages/vue/index.ts", "dist/vue/index.js");
await transpile("packages/vue/slim.ts", "dist/vue/slim.js");

// Source doubles as the type surface (see header note).
copyFileSync("packages/react/wrapper.tsx", "dist/react/wrapper.tsx");
copyFileSync("packages/react/index.tsx", "dist/react/index.tsx");
copyFileSync("packages/react/slim.tsx", "dist/react/slim.tsx");
copyFileSync("packages/vue/wrapper.ts", "dist/vue/wrapper.ts");
copyFileSync("packages/vue/index.ts", "dist/vue/index.ts");
copyFileSync("packages/vue/slim.ts", "dist/vue/slim.ts");
copyFileSync("packages/svelte/MoviPlayer.svelte", "dist/svelte/MoviPlayer.svelte");
copyFileSync("packages/svelte/MoviPlayerSlim.svelte", "dist/svelte/MoviPlayerSlim.svelte");
copyFileSync("packages/svelte/MoviSource.svelte", "dist/svelte/MoviSource.svelte");
copyFileSync("packages/svelte/MoviTrack.svelte", "dist/svelte/MoviTrack.svelte");

console.log(
  "[wrappers] react + vue transpiled (default + slim), svelte copied → dist/{react,vue,svelte}",
);
