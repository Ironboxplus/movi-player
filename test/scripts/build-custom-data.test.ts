import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the real generator over the real docs — no fixtures. Its output is what
 * editors read for `<movi-player>` completions, and it is a tracked artifact, so
 * regenerating it must be idempotent and correct.
 *
 * The bug this guards: `docSection` ended an attribute's section at the next
 * `---` rule only. Upstream's docs/api/element.md does not put a rule after
 * every `#### \`attr\`` heading, so a section ran on into later ones and picked
 * up THEIR "**Values:**" list. Every attribute from `src` down came out typed
 * `"canvas"` — the renderer's first value — and editors would have offered
 * `src="canvas"`.
 */
const OUTPUTS = [
  "custom-elements.json",
  "vscode-extension/html-custom-data.json",
  "vscode-extension/css-custom-data.json",
];

function generate() {
  // The generator writes its three tracked artifacts in place. Put them back
  // byte for byte afterwards: on a checkout with core.autocrlf the rewrite alone
  // (LF vs CRLF) would leave the tree dirty after every test run.
  const before = OUTPUTS.map((f) => [f, readFileSync(f)] as const);
  try {
    execFileSync(process.execPath, ["scripts/build-custom-data.mjs"], {
      encoding: "utf8",
    });
    return parseManifest();
  } finally {
    for (const [file, contents] of before) writeFileSync(file, contents);
  }
}

function parseManifest() {
  const manifest = JSON.parse(readFileSync("custom-elements.json", "utf8"));
  const declaration = manifest.modules[0].declarations[0];
  const byName = new Map<string, { type?: { text: string } }>(
    declaration.attributes.map((a: { name: string }) => [a.name, a]),
  );
  return byName;
}

describe("custom element data generation", () => {
  it("does not leak one attribute's documented values onto the others", () => {
    const attributes = generate();

    const renderer = attributes.get("renderer");
    expect(renderer?.type?.text).toContain('"canvas"');

    const leaked = [...attributes]
      .filter(([name, a]) => name !== "renderer" && a.type?.text?.includes('"canvas"'))
      .map(([name]) => name);
    expect(leaked).toEqual([]);
  });

  it("leaves free-form attributes untyped rather than guessing an enum", () => {
    const attributes = generate();

    expect(attributes.get("src")?.type).toBeUndefined();
    expect(attributes.get("autoplay")?.type).toBeUndefined();
  });
});
