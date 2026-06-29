#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

function normalize(filePath) {
  return filePath.replace(/\\/g, "/");
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function getPackFiles() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "npm pack --dry-run failed");
  }
  const stdout = result.stdout;
  const entries = JSON.parse(stdout);
  const pack = entries[0];
  if (!pack?.files) {
    throw new Error("npm pack --dry-run did not return a file list");
  }
  return pack.files.map((file) => normalize(file.path));
}

const files = await getPackFiles();
const fileSet = new Set(files);

const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/element.js",
  "dist/player.js",
  "dist/demuxer.js",
  "dist/wasm/movi.js",
];

for (const file of required) {
  if (!fileSet.has(file)) {
    fail(`Package is missing required file: ${file}`);
  }
}

const workerAssets = files.filter((file) =>
  /^dist\/assets\/SoftwareAudioDecoder\.worker-[^/]+\.js$/.test(file),
);
if (workerAssets.length === 0) {
  fail(
    "Package is missing SoftwareAudioDecoder worker asset under dist/assets. " +
      "DTS software audio would fall back or fail at runtime.",
  );
}

const bundleFiles = [
  "dist/index.js",
  "dist/element.js",
  "dist/player.js",
  "dist/demuxer.js",
];
const referencedWorkers = new Set();
for (const bundle of bundleFiles) {
  if (!fileSet.has(bundle)) continue;

  const code = await readFile(bundle, "utf8");
  const refs = code.match(/assets\/SoftwareAudioDecoder\.worker-[\w-]+\.js/g) ?? [];
  if (refs.length === 0) {
    fail(`Bundle does not reference the software audio worker asset: ${bundle}`);
    continue;
  }
  if (code.includes('new URL("/assets/SoftwareAudioDecoder.worker-')) {
    fail(`Bundle uses an absolute /assets worker URL: ${bundle}`);
  }
  for (const ref of refs) {
    const packedPath = `dist/${ref}`;
    referencedWorkers.add(packedPath);
    if (!fileSet.has(packedPath)) {
      fail(`${bundle} references a worker asset missing from npm pack: ${packedPath}`);
    }
  }
}

const unreferencedWorkers = workerAssets.filter(
  (workerAsset) => !referencedWorkers.has(workerAsset),
);
if (unreferencedWorkers.length > 0) {
  fail(
    "Package would include unreferenced software audio worker assets. " +
      "Start from a clean dist/ before packing:\n" +
      unreferencedWorkers.map((file) => `  - ${file}`).join("\n"),
  );
}

const staleArtifacts = files.filter(
  (file) =>
    file.startsWith("dist/wasm/wasm/") ||
    /^dist\/wasm\/.+\.(bak|old)(\.|$)/.test(file) ||
    /^dist\/wasm\/.+\.speed$/.test(file),
);
if (staleArtifacts.length > 0) {
  fail(
    "Package would include stale or duplicated local WASM artifacts:\n" +
      staleArtifacts.map((file) => `  - ${file}`).join("\n"),
  );
}

if (process.exitCode) {
  process.exit();
}

console.log(
  JSON.stringify(
    {
      files: files.length,
      workerAssets,
      referencedWorkers: [...referencedWorkers],
      wasm: "dist/wasm/movi.js",
    },
    null,
    2,
  ),
);
