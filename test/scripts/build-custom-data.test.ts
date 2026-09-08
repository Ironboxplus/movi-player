import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
function generate() {
  execFileSync(process.execPath, ["scripts/build-custom-data.mjs"], {
    encoding: "utf8",
  });
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
