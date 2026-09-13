import { describe, expect, it } from "vitest";
import { getDecodeMode, isSoftwareDecodePath } from "../../src/core/decodeMode";

/**
 * P2 (docs/PLAN_MERGE.MD §3.4): `decodeMode` is fork-only — upstream has no
 * equivalent.
 *
 * Deliberately NOT a hardware×software truth table here. `softwareHeavy =
 * videoSoftware || audioSoftware` is a one-line OR — enumerating all four
 * boolean combinations would just restate that formula in test syntax: if
 * the OR is ever wrong, one case (or `getDecodeMode`'s callers, which react
 * to `softwareHeavy` on every tick) already fails, and no combination-level
 * case tells you anything the implementation doesn't already say. A truth
 * table like that breaks in lockstep with any implementation change and
 * catches nothing an implementation change wouldn't already surface —
 * exactly the kind of test that produces false confidence, not regression
 * protection.
 *
 * What's actually worth pinning is the one real *decision* this module
 * makes: how to classify a decoder that hasn't reported anything yet.
 */
describe("decodeMode: undetermined decoders default to hardware, not software", () => {
  it("missing decoders (not yet configured) classify as hardware, not software", () => {
    // A decoder that hasn't attached yet must not be read as "software" —
    // that would make every pre-configure tick (e.g. right after a source
    // switch) trip the software-heavy backpressure/buffer branches.
    expect(getDecodeMode(null, undefined)).toEqual({
      videoSoftware: false,
      audioSoftware: false,
      softwareHeavy: false,
    });
    expect(getDecodeMode(undefined, null)).toEqual({
      videoSoftware: false,
      audioSoftware: false,
      softwareHeavy: false,
    });
  });

  it("a probe without an isSoftware field (e.g. a bare {}) reads as hardware", () => {
    expect(getDecodeMode({}, {})).toEqual({
      videoSoftware: false,
      audioSoftware: false,
      softwareHeavy: false,
    });
  });

  it("isSoftwareDecodePath agrees with getDecodeMode on the same undetermined input", () => {
    // Same decision, exposed as its own export for callers that only need
    // the boolean (not the full breakdown) — pinned so the two can't drift
    // if one is ever changed without the other.
    expect(isSoftwareDecodePath(undefined, undefined)).toBe(false);
  });
});
