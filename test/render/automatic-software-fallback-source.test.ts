import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Static guard, deliberately. The behaviour it protects — "a software fallback
// that is the only way this file will ever play must not raise the blocking
// 'Try Software Decoding' overlay" — is exercised for real against the decoder
// in test/decode/video-decoder.test.ts ("software fallback reports why the CPU
// is decoding"). What CANNOT be reached without a browser is MoviElement.load(),
// which needs a custom-element registry, a shadow root and a live player; so the
// element's half of the contract is asserted on the source of the branch.
//
// The fork carried this as a hand-rolled suppression block AFTER the overlay
// call ("Using automatic software video decoder fallback" → hide the broken
// indicator, clear _isUnsupported). Upstream removes the need for it by gating
// the overlay on WHY the CPU is decoding, which is strictly finer: the fork's
// block suppressed the prompt for every software path, including the
// hardware-refused one where offering the trade is the right thing to do.
const source = readFileSync("src/render/MoviElement.ts", "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("MoviElement automatic software fallback", () => {
  it("only offers the software-decoding trade when hardware refused", () => {
    const start = source.indexOf(
      "// Check for software decoding fallback (only for MoviPlayer/Canvas mode)",
    );
    const end = source.indexOf("// Apply properties", start);
    const branch = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);

    // The gate itself: without this clause an "unmapped" fallback (MPEG-2,
    // Motion JPEG) dead-ends a file that was already decoding.
    expect(branch).toContain(
      'this.player.softwareDecodeReason() === "hardware-refused"',
    );
    // …and the overlay is still reachable, for the case that IS a trade.
    expect(branch).toContain("handleUnsupportedVideo(");
  });

  it("clears the unsupported state on every load, not just the software path", () => {
    const reset = source.indexOf("// Reset unsupported state");
    expect(reset).toBeGreaterThan(0);
    const branch = source.slice(reset, reset + 400);
    expect(branch).toContain("this._isUnsupported = false");
    expect(branch).toContain('this.brokenIndicator.style.display = "none"');
  });
});
