// Bundles JASSUB for the black-box page the way the docs say a host does it:
// the library and its worker go through a bundler (their imports are bare
// package names a browser cannot resolve), the WebAssembly builds are served
// as files. The package is installed by the workflow, not by this repo.
//
//   node scripts/blackbox-fonts/build-jassub.mjs <out-dir>
import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const out = resolve(process.argv[2] ?? "jassub-bundle");
const dist = resolve("node_modules", "jassub", "dist");
await mkdir(out, { recursive: true });

await build({
  stdin: { contents: 'export { default } from "jassub";', resolveDir: process.cwd() },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(out, "jassub.bundle.js"),
});
await build({
  entryPoints: [join(dist, "worker", "worker.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(out, "worker.bundle.js"),
});
// The library reads these relative to itself.
await cp(join(dist, "wasm"), join(out, "wasm"), { recursive: true });
await cp(join(dist, "default.woff2"), join(out, "default.woff2"));
console.log("jassub bundled into", out);
