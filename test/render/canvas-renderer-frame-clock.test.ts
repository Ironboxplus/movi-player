import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasRenderer } from "../../src/render/CanvasRenderer";
import type { SubtitleCue } from "../../src/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * These tests exercise CanvasRenderer's presentation-timing and frame-queue
 * bookkeeping directly on the prototype (the same pattern already used by
 * canvas-renderer-clock.test.ts), bypassing the constructor because it
 * requires a real WebGL2 context that Node doesn't have. Private fields are
 * seeded by hand; the methods under test (clearQueue/spliceQueue/
 * getCurrentPlaybackTime/renderSubtitles) run unmodified. VideoFrame-like
 * objects are plain `{ timestamp, close, clone }` stand-ins — CanvasRenderer
 * only ever reads `.timestamp` and calls `.close()/.clone()` on queued
 * frames, so this exercises the real queue logic, not a mocked decoder.
 */

type FakeFrame = { timestamp: number; close: () => void; clone: () => FakeFrame };
function fakeFrame(timestampMicros: number): FakeFrame {
  const f: FakeFrame = {
    timestamp: timestampMicros,
    close: vi.fn(),
    clone: () => fakeFrame(timestampMicros),
  };
  return f;
}

type RendererInternals = CanvasRenderer & {
  frameQueue: FakeFrame[];
  lastPresentedPts: number;
  presentationStartPts: number;
  presentationStartTime: number;
  syncedToAudio: boolean;
  lastKnownAudioTime: number;
  framesPresented: number;
  justSeeked: boolean;
  isPlaying: boolean;
  playbackRate: number;
  getAudioTime?: () => number;
  _isAudioHealthy?: () => boolean;
  activeSubtitleCue: SubtitleCue | null;
  subtitleOverlay: HTMLElement | null;
  _lastRenderedSubtitleKey: string;
  _lastRenderedSubtitlePlain: string;
  _lastSubtitleLineCount: number;
  rotation: number;
  width: number;
  height: number;
  subtitleControlsPadding: number;
  canvas: unknown;
  getCurrentPlaybackTime(): number;
};

function makeRenderer(): RendererInternals {
  return Object.create(CanvasRenderer.prototype) as RendererInternals;
}

describe("CanvasRenderer.clearQueue — seek/reset semantics", () => {
  it("resets framesPresented to 0 and closes every queued frame (the reset the harness must tolerate)", () => {
    const renderer = makeRenderer();
    const f1 = fakeFrame(1_000_000);
    const f2 = fakeFrame(1_100_000);
    Object.assign(renderer, {
      frameQueue: [f1, f2],
      lastPresentedPts: 4.2,
      presentationStartPts: 4.2,
      presentationStartTime: 12345,
      syncedToAudio: true,
      lastKnownAudioTime: 4.2,
      framesPresented: 87,
      justSeeked: false,
    });

    renderer.clearQueue();

    // This is the behavior the black-box harness must treat as a reset
    // point, not a regression: framesPresented genuinely goes back to 0.
    expect(renderer.framesPresented).toBe(0);
    expect(renderer.lastPresentedPts).toBe(-1);
    expect(renderer.presentationStartPts).toBe(0);
    expect(renderer.presentationStartTime).toBe(0);
    expect(renderer.syncedToAudio).toBe(false);
    expect(renderer.frameQueue).toEqual([]);
    expect(renderer.justSeeked).toBe(true);
    expect(f1.close).toHaveBeenCalledTimes(1);
    expect(f2.close).toHaveBeenCalledTimes(1);
  });
});

describe("CanvasRenderer.spliceQueue — quality-switch handoff must NOT reset the clock", () => {
  it("adopts only frames at/after the splice point and leaves presentation timing untouched", () => {
    const renderer = makeRenderer();
    const kept = fakeFrame(1_000_000); // before splice point: stays
    const evicted = fakeFrame(2_000_000); // at/after splice point: closed
    Object.assign(renderer, {
      frameQueue: [kept, evicted],
      lastPresentedPts: 1.9,
      presentationStartPts: 1.9,
      presentationStartTime: 999,
      syncedToAudio: true,
      justSeeked: false,
    });

    const incomingA = fakeFrame(2_000_000); // adopted
    const incomingB = fakeFrame(1_500_000); // stale relative to splice point: closed, not adopted

    const adopted = renderer.spliceQueue(2_000_000, [
      incomingB as unknown as VideoFrame,
      incomingA as unknown as VideoFrame,
    ]);

    expect(adopted).toBe(1);
    expect(evicted.close).toHaveBeenCalledTimes(1);
    expect(incomingB.close).toHaveBeenCalledTimes(1);
    expect(incomingA.close).not.toHaveBeenCalled();
    // The old frame under the splice point rides out; the new frame at/after
    // it is queued behind it.
    expect(renderer.frameQueue).toEqual([kept, incomingA]);

    // Contract this test locks: unlike clearQueue(), a quality switch must
    // NOT jump the picture, so none of the timing anchors move.
    expect(renderer.lastPresentedPts).toBe(1.9);
    expect(renderer.presentationStartPts).toBe(1.9);
    expect(renderer.presentationStartTime).toBe(999);
    expect(renderer.justSeeked).toBe(false);
  });

  it("returns 0 and adopts nothing when every incoming frame is behind the splice point", () => {
    const renderer = makeRenderer();
    Object.assign(renderer, { frameQueue: [] });

    const stale = fakeFrame(500_000);
    const adopted = renderer.spliceQueue(1_000_000, [stale as unknown as VideoFrame]);

    expect(adopted).toBe(0);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(renderer.frameQueue).toEqual([]);
  });
});

describe("CanvasRenderer.getCurrentPlaybackTime — paused/pre-anchor semantics", () => {
  it("while paused, pins to the last presented frame rather than advancing the wall clock", () => {
    const renderer = makeRenderer();
    Object.assign(renderer, {
      isPlaying: false,
      lastPresentedPts: 3.5,
      presentationStartPts: 0,
    });

    expect(renderer.getCurrentPlaybackTime()).toBe(3.5);
  });

  it("while paused before any frame has presented, falls back to the anchor pts", () => {
    const renderer = makeRenderer();
    Object.assign(renderer, {
      isPlaying: false,
      lastPresentedPts: -1,
      presentationStartPts: 1.25,
    });

    expect(renderer.getCurrentPlaybackTime()).toBe(1.25);
  });

  it("while paused with neither a presented frame nor an anchor, reports -1 (not started)", () => {
    const renderer = makeRenderer();
    Object.assign(renderer, {
      isPlaying: false,
      lastPresentedPts: -1,
      presentationStartPts: 0,
    });

    expect(renderer.getCurrentPlaybackTime()).toBe(-1);
  });
});

describe("CanvasRenderer subtitle overlay — show/hide contract", () => {
  function fakeOverlay() {
    const style: Record<string, string> = {};
    return {
      style,
      textContent: "",
      innerHTML: "",
      classList: { toggle: vi.fn(), contains: vi.fn(() => false) },
      querySelector: vi.fn(() => null),
      getBoundingClientRect: undefined,
    } as unknown as HTMLElement;
  }

  it("hides the overlay and clears its content when there is no active cue", () => {
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    const renderer = makeRenderer();
    const overlay = fakeOverlay();
    Object.assign(renderer, {
      activeSubtitleCue: null,
      subtitleOverlay: overlay,
      _lastRenderedSubtitleKey: "prev-key",
      _lastRenderedSubtitlePlain: "prev text",
      _lastSubtitleLineCount: 2,
      rotation: 0,
      width: 1920,
      height: 1080,
      subtitleControlsPadding: 0,
      canvas: null,
    });

    (renderer as unknown as { renderSubtitles(): void }).renderSubtitles();

    expect(overlay.style.display).toBe("none");
    expect(overlay.innerHTML).toBe("");
    expect(renderer._lastRenderedSubtitleKey).toBe("");
    expect(renderer._lastRenderedSubtitlePlain).toBe("");
    expect(renderer._lastSubtitleLineCount).toBe(0);
  });

  // NOT COVERED: the "show a non-empty text cue" branch past this point
  // measures the actual on-screen font via `document.createElement("div")` +
  // `window.getComputedStyle` + a 2D canvas `measureText()` pass (see
  // CanvasRenderer.ts:4110-4192, the karaoke width-anchoring probe). Faking
  // that faithfully needs a real DOM (jsdom/happy-dom), which this repo does
  // not currently pull in for `vitest.config.ts`'s `environment: "node"`.
  // Stubbing `document.createElement` well enough to satisfy it would mean
  // scripting the answer the measurement is supposed to produce — exactly
  // the "cheat the return value" case §5.1/§4.9 rule out. Left as a real gap;
  // the two branches above (no cue, and cue with empty text) are the ones
  // reachable without a DOM and are covered for real.

  it("hides a text overlay when the active cue has no text (e.g. a cleared karaoke line)", () => {
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    const renderer = makeRenderer();
    const overlay = fakeOverlay();
    Object.assign(renderer, {
      activeSubtitleCue: { start: 0, end: 5, text: "" } as SubtitleCue,
      subtitleOverlay: overlay,
      _lastRenderedSubtitleKey: "",
      _lastRenderedSubtitlePlain: "",
      _lastSubtitleLineCount: 0,
      rotation: 0,
      width: 1920,
      height: 1080,
      subtitleControlsPadding: 0,
      canvas: null,
    });

    (renderer as unknown as { renderSubtitles(): void }).renderSubtitles();

    expect(overlay.style.display).toBe("none");
  });
});
