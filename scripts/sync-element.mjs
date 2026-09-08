/**
 * Fans the freshly built player bundle out to every target that ships its own
 * copy:
 *   dist/element.slim.js + dist/movi.wasm → chrome-extension/dist/
 *                                         → firefox-extension/dist/
 *   dist/element.js                       → vscode-extension/webview/dist/
 *                                         → desktop/renderer/vendor/
 *
 * The two browser extensions take the slim bundle. AMO's linter refuses to
 * parse a JS file over 5MB, and the full build is 11.8MB because it carries the
 * FFmpeg engine inside it — so a Firefox submission fails validation outright.
 * Slim leaves the JS at 4.6MB and puts the engine beside it as movi.wasm, which
 * the linter never opens because it isn't JS. Same element, same API: the
 * bundle reaches the engine through `new URL("movi.wasm", import.meta.url)`, so
 * the only requirement is that the two land in the SAME directory.
 *
 * These copies are gitignored, so nothing here shows up in a commit — but a
 * stale one DOES get published. Shipping a stale vscode webview bundle once
 * cost a whole patch bump, because the marketplace can't overwrite a published
 * version.
 *
 * Deliberately does NOT build: dist/ is produced by `npm run build:ts`, which
 * stays under the author's control. If dist/ is missing we stop; if it looks
 * older than src/ we warn loudly and copy anyway (the caller may know better).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Both are produced by the same build, so either one dates it.
const FULL = ["dist/element.js"];
const SLIM = ["dist/element.slim.js", "dist/movi.wasm"];

const targets = [
  ["chrome-extension", "chrome-extension/dist", SLIM],
  ["firefox-extension", "firefox-extension/dist", SLIM],
  ["vscode-extension", "vscode-extension/webview/dist", FULL],
  ["desktop", "desktop/renderer/vendor", FULL],
];

const missing = [...new Set(targets.flatMap(([, , files]) => files))].filter(
  (f) => !existsSync(resolve(repoRoot, f)),
);
if (missing.length) {
  console.error(
    `\n✗ not found: ${missing.join(", ")}\n` +
      "  Build the player bundle first:\n" +
      "    npm run build:ts        (or full: npm run build)\n",
  );
  process.exit(1);
}

const src = resolve(repoRoot, "dist", "element.js");

/** Newest mtime under a directory, so a stale bundle can't slip through unnoticed. */
async function newestMtime(dir) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    const t = entry.isDirectory() ? await newestMtime(full) : statSync(full).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

function ago(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 90) return `${mins} minute(s)`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} hour(s)` : `${Math.round(hours / 24)} day(s)`;
}

const builtAt = statSync(src).mtimeMs;
const srcTouchedAt = await newestMtime(resolve(repoRoot, "src"));
if (srcTouchedAt > builtAt) {
  // console.log, not console.warn: stderr interleaves unpredictably with the
  // stdout progress below, and a staleness warning that surfaces AFTER
  // "all targets in sync" reads like it doesn't apply.
  console.log(
    `\n⚠ src/ was edited ${ago(srcTouchedAt - builtAt)} AFTER dist/element.js was built.\n` +
      "  You are about to fan out a stale bundle. Run `npm run build:ts` first\n" +
      "  unless you meant to ship the older build.",
  );
}

const hash = (p) => createHash("md5").update(readFileSync(p)).digest("hex");
const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);

console.log("");
for (const f of [...new Set(targets.flatMap(([, , files]) => files))]) {
  const p = resolve(repoRoot, f);
  console.log(`${f.padEnd(22)} ${mb(p).padStart(5)} MB  ${hash(p).slice(0, 8)}`);
}
console.log("");

for (const [label, dir, files] of targets) {
  await mkdir(resolve(repoRoot, dir), { recursive: true });
  for (const f of files) {
    const from = resolve(repoRoot, f);
    const dst = resolve(repoRoot, dir, f.replace(/^dist\//, ""));
    await copyFile(from, dst);
    // Verify rather than trust: a truncated copy is exactly the failure this
    // script exists to prevent, and it's silent otherwise.
    if (hash(dst) !== hash(from)) {
      console.error(`✗ ${label}: copy verification FAILED (${f})`);
      process.exit(1);
    }
  }
  console.log(`✓ ${label.padEnd(17)} → ${dir}/  (${files.map((f) => f.replace(/^dist\//, "")).join(" + ")})`);
}

console.log("\n✓ all targets in sync\n");
