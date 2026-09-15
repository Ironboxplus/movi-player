import { describe, expect, it, vi } from "vitest";
import { SubtitleDecoder } from "../../src/decode/SubtitleDecoder";
import type { WasmBindings } from "../../src/wasm/bindings";
import type { SubtitleCue, SubtitleTrack } from "../../src/types";

/**
 * A bitmap subtitle packet carrying no image is a PGS display-set CLEAR: the
 * segment that ends a caption. It is an ordinary, frequent event.
 *
 * `SubtitleDecoder.decode()` used to dispatch purely on whether
 * `getSubtitleImageInfo()` returned anything, so a clear fell through to the
 * TEXT branch — it asked a bitmap codec for text, got null, and logged "No
 * text extracted from subtitle" at WARN. Observed on real media 2026-09-15
 * (Memories, hdmv_pgs_subtitle, a 30-byte packet at t=5166.370s), where that
 * warning was the first thing that looked wrong while investigating why no
 * cues rendered — and was unrelated to the actual cause.
 *
 * No cue was emitted on that path before or after; this locks the dispatch,
 * not a behaviour change. `WasmBindings` is the untestable-without-real-WASM
 * external dependency (PLAN_MERGE §5.1's carve-out) and is the only thing
 * substituted; the decoder under test is real.
 */
function makeBindings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    enableDecoder: vi.fn(async () => 0),
    decodeSubtitle: vi.fn(async () => 0),
    getSubtitleTimes: vi.fn(async () => ({ start: 5166.37, end: 5168.37 })),
    getSubtitleImageInfo: vi.fn(async () => null),
    getSubtitleImageData: vi.fn(async () => null),
    getSubtitleText: vi.fn(async () => null),
    freeSubtitle: vi.fn(async () => {}),
    ...overrides,
  } as unknown as WasmBindings & Record<string, ReturnType<typeof vi.fn>>;
}

const imageTrack: SubtitleTrack = {
  id: 3,
  type: "subtitle",
  codec: "hdmv_pgs_subtitle",
  subtitleType: "image",
};

const textTrack: SubtitleTrack = {
  id: 4,
  type: "subtitle",
  codec: "subrip",
  subtitleType: "text",
};

describe("SubtitleDecoder: bitmap display-set clear", () => {
  it("does not ask a bitmap track for text when a packet carries no image", async () => {
    const bindings = makeBindings();
    const decoder = new SubtitleDecoder();
    const cues: SubtitleCue[] = [];
    decoder.setOnCue((cue) => cues.push(cue));
    decoder.setBindings(bindings, false);
    expect(await decoder.configure(imageTrack)).toBe(true);

    await decoder.decode(new Uint8Array(30), 5166.37, false);

    expect(bindings.getSubtitleImageInfo).toHaveBeenCalledTimes(1);
    expect(bindings.getSubtitleText).not.toHaveBeenCalled();
    expect(cues).toHaveLength(0);
    // The packet is still accounted for: the decoded subtitle is released
    // exactly as it is on every other success path.
    expect(bindings.freeSubtitle).toHaveBeenCalledTimes(1);
  });

  it("still reads text for a text track whose packet carries no image", async () => {
    const bindings = makeBindings({
      getSubtitleText: vi.fn(async () => "hello"),
      getSubtitleTimes: vi.fn(async () => ({ start: 10, end: 12 })),
    });
    const decoder = new SubtitleDecoder();
    const cues: SubtitleCue[] = [];
    decoder.setOnCue((cue) => cues.push(cue));
    decoder.setBindings(bindings, false);
    expect(await decoder.configure(textTrack)).toBe(true);

    await decoder.decode(new Uint8Array(64), 10, false);

    expect(bindings.getSubtitleText).toHaveBeenCalledTimes(1);
    expect(cues).toEqual([{ start: 10, end: 12, text: "hello" }]);
  });
});
