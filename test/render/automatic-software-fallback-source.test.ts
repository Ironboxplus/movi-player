import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/render/MoviElement.ts", "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("MoviElement automatic software fallback", () => {
  it("continues normal initialization instead of showing the unsupported overlay", () => {
    const start = source.indexOf(
      "Using automatic software video decoder fallback",
    );
    const end = source.indexOf("// Apply properties", start);
    const branch = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(branch).toContain('this.brokenIndicator.style.display = "none"');
    expect(branch).toContain("this._isUnsupported = false");
    expect(branch).not.toContain("handleUnsupportedVideo(");
    expect(branch).not.toMatch(/\breturn;/);
  });
});
