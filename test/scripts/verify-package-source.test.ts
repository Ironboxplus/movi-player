import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("scripts/verify-package.mjs", "utf8");

describe("package worker verification", () => {
  it("verifies the software video worker as well as the audio worker", () => {
    expect(source).toContain('name: "SoftwareAudioDecoder"');
    expect(source).toContain('name: "SoftwareVideoDecoder"');
  });
});
