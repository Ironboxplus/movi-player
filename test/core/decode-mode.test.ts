import { describe, expect, it } from "vitest";
import { getDecodeMode, isSoftwareDecodePath } from "../../src/core/decodeMode";

/**
 * P2 (docs/PLAN_MERGE.MD §3.4): `decodeMode` is fork-only — upstream has no
 * equivalent. These are the pure state-classification rules everything else
 * (P4's maxAudioBuffered, the backpressure queue caps, isMainThreadSoftware-
 * Decoding) branches on, so every video/audio hardware×software combination
 * is worth pinning directly rather than only indirectly through callers.
 */
describe("decodeMode: video/audio hardware-vs-software classification", () => {
  it("both hardware: nothing is software, nothing is heavy", () => {
    const mode = getDecodeMode({ isSoftware: false }, { isSoftware: false });
    expect(mode).toEqual({
      videoSoftware: false,
      audioSoftware: false,
      softwareHeavy: false,
    });
    expect(isSoftwareDecodePath({ isSoftware: false }, { isSoftware: false })).toBe(false);
  });

  it("video software, audio hardware: softwareHeavy true, isolated to video", () => {
    const mode = getDecodeMode({ isSoftware: true }, { isSoftware: false });
    expect(mode).toEqual({
      videoSoftware: true,
      audioSoftware: false,
      softwareHeavy: true,
    });
  });

  it("video hardware, audio software: softwareHeavy true, isolated to audio (the A5 post-merge norm)", () => {
    const mode = getDecodeMode({ isSoftware: false }, { isSoftware: true });
    expect(mode).toEqual({
      videoSoftware: false,
      audioSoftware: true,
      softwareHeavy: true,
    });
    expect(isSoftwareDecodePath({ isSoftware: false }, { isSoftware: true })).toBe(true);
  });

  it("both software: both flags true", () => {
    const mode = getDecodeMode({ isSoftware: true }, { isSoftware: true });
    expect(mode).toEqual({
      videoSoftware: true,
      audioSoftware: true,
      softwareHeavy: true,
    });
  });

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
});
