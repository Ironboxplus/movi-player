import { describe, expect, it } from "vitest";
import {
  canDelaySubtitles,
  externalCueIndex,
} from "../../src/core/SubtitleDelay";

const cues = [
  { start: 10, end: 12 },
  { start: 20, end: 22 },
];

describe("externalCueIndex", () => {
  it("picks the cue under the playhead with no delay", () => {
    expect(externalCueIndex(cues, 11, 0)).toBe(0);
    expect(externalCueIndex(cues, 15, 0)).toBe(-1);
  });

  it("shows a cue later by a positive delay", () => {
    // 10–12 with +5 s is on screen 15–17.
    expect(externalCueIndex(cues, 11, 5)).toBe(-1);
    expect(externalCueIndex(cues, 16, 5)).toBe(0);
    expect(externalCueIndex(cues, 26, 5)).toBe(1);
  });

  it("shows a cue earlier by a negative delay", () => {
    // 20–22 with -3 s is on screen 17–19.
    expect(externalCueIndex(cues, 18, -3)).toBe(1);
    expect(externalCueIndex(cues, 21, -3)).toBe(-1);
  });
});

describe("canDelaySubtitles", () => {
  it("offers the delay for a subtitle file on a network source", () => {
    expect(canDelaySubtitles({ fileSource: false, externalActive: true })).toBe(
      true,
    );
  });

  it("offers it for anything on a local file", () => {
    expect(canDelaySubtitles({ fileSource: true, externalActive: false })).toBe(
      true,
    );
  });

  it("does not for an in-band track on a network source", () => {
    expect(
      canDelaySubtitles({ fileSource: false, externalActive: false }),
    ).toBe(false);
  });
});
