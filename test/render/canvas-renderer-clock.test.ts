import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasRenderer } from "../../src/render/CanvasRenderer";
import { PlaybackTimeSource } from "../../src/core/TimeSource";

afterEach(() => {
  vi.restoreAllMocks();
});

type Internals = CanvasRenderer & {
  getCurrentPlaybackTime(): number;
  [key: string]: unknown;
};

/**
 * A renderer holding the picture to a time source. The prototype is used
 * directly (the constructor wants no WebGL here), with the fields the clock
 * code reads seeded by hand.
 */
function make(audio: { time: number }) {
  const now = vi.spyOn(performance, "now").mockReturnValue(5_000);
  const source = new PlaybackTimeSource();
  source.setAudio({ mediaTimeAt: () => audio.time });
  const renderer = Object.assign(Object.create(CanvasRenderer.prototype), {
    // A configured picture: with no picture the renderer answers the sound
    // clock for the captions, which a bare prototype is.
    isVideoConfigured: true,
    subtitleClockTimer: null,
    isPlaying: true,
    lastPresentedPts: 4,
    videoFrameRate: 24,
    timeSource: source,
  }) as Internals;
  return { renderer, now, source };
}

describe("CanvasRenderer.getCurrentPlaybackTime — the picture reads the time source", () => {
  it("is exactly the time source's reading, every call, with no clock of its own", () => {
    const audio = { time: 6 };
    const { renderer, now } = make(audio);
    expect(renderer.getCurrentPlaybackTime()).toBe(6);

    // A step the old wall clock would have banked (under its 150ms deadband) or
    // only partly corrected (over it): the picture's time simply is the sound's.
    audio.time = 6.07;
    now.mockReturnValue(5_016);
    expect(renderer.getCurrentPlaybackTime()).toBe(6.07);
    audio.time = 6.4;
    now.mockReturnValue(5_033);
    expect(renderer.getCurrentPlaybackTime()).toBe(6.4);
  });

  it("is not capped to the last audio time plus a margin when the audio stops answering", () => {
    // The old picture clock was held at lastKnownAudioTime + 0.15 while the
    // audio was unhealthy. With no answer from the sound the source carries on
    // from the last time it heard, on the wall clock.
    const audio = { time: 6 };
    const { renderer, now, source } = make(audio);
    source.seek(6);
    source.start();
    expect(renderer.getCurrentPlaybackTime()).toBe(6);

    audio.time = -1;
    now.mockReturnValue(9_000);
    expect(renderer.getCurrentPlaybackTime()).toBeCloseTo(10, 6);
  });

  it("answers -1 when the time source has never been positioned", () => {
    const { renderer } = make({ time: -1 });
    expect(renderer.getCurrentPlaybackTime()).toBe(-1);
  });

  it("answers -1 with no time source at all", () => {
    const { renderer } = make({ time: 6 });
    renderer.timeSource = null;
    expect(renderer.getCurrentPlaybackTime()).toBe(-1);
  });

  it("follows the sound for a source with no picture", () => {
    const audio = { time: 3 };
    const { renderer } = make(audio);
    renderer.isVideoConfigured = false;
    expect(renderer.getCurrentPlaybackTime()).toBe(3);
  });
});

describe("CanvasRenderer late frames — the picture never shows what it is too late for", () => {
  type Queue = { timestamp: number; close: () => void; clone: () => unknown }[];
  function frame(pts: number) {
    return { timestamp: Math.round(pts * 1e6), close: vi.fn(), clone: () => frame(pts) };
  }
  function withQueue(pts: number[], time: number) {
    const { renderer } = make({ time });
    const frames = pts.map(frame);
    Object.assign(renderer, {
      // A copy: the renderer splices its own queue, and the test keeps the frames.
      frameQueue: [...frames] as unknown as Queue,
      lastPresentedPts: 10,
      framesPresented: 100,
      justSeeked: false,
      framesDropped: 0,
      framesSkippedLate: 0,
      _backwardsRefused: 0,
    });
    const select = (renderer as unknown as {
      selectFrameForPresentation(t: number): unknown;
    }).selectFrameForPresentation.bind(renderer);
    return { renderer, frames, select };
  }

  it("drops a frame whose interval ended longer ago than half a frame, and shows nothing", () => {
    // 24fps: frame 12.0 covers 12.0 to 12.0417, and may be shown until ~20.8ms
    // after that. At 12.2 it is far past.
    const { renderer, frames, select } = withQueue([12.0], 12.2);
    expect(select(12.2)).toBeNull();
    expect(frames[0].close).toHaveBeenCalledOnce();
    expect(renderer.getQueueSize()).toBe(0);
    expect(renderer.getFrameStats().dropped).toBe(1);
  });

  it("shows the latest due frame when it is on time, skipping the ones it superseded", () => {
    const { frames, select } = withQueue([12.0, 12.0417, 12.0833], 12.09);
    expect(select(12.09)).toBe(frames[2]);
  });

  it("drops the whole run of late frames up to the latest due one", () => {
    const { renderer, frames, select } = withQueue([12.0, 12.0417, 12.0833, 12.125], 12.3);
    expect(select(12.3)).toBeNull();
    expect(renderer.getQueueSize()).toBe(0);
    for (const f of frames) expect(f.close).toHaveBeenCalledOnce();
    expect(renderer.getFrameStats().dropped).toBe(4);
  });

  it("keeps a frame that is not due yet", () => {
    const { renderer, select } = withQueue([12.2], 12.0);
    expect(select(12.0)).toBeNull();
    expect(renderer.getQueueSize()).toBe(1);
  });

  it("does not show a frame much earlier than the clock", () => {
    // Used to be shown whenever it was within a full frame interval: a
    // permanent lead on the sound of up to 42ms at 24fps.
    const { select } = withQueue([12.04], 12.0);
    expect(select(12.0)).toBeNull();
  });

  it("allows a late frame inside the acceptable drift", () => {
    // Ended 15ms ago at 24fps: inside the 20.8ms half frame.
    const { frames, select } = withQueue([12.0], 12.0417 + 0.015);
    expect(select(12.0417 + 0.015)).toBe(frames[0]);
  });

  it("discardLateFrames drops what is too late and leaves what is on screen alone", () => {
    const { renderer } = withQueue([12.0, 12.0417, 13.0], 12.5);
    expect(renderer.discardLateFrames(12.5)).toBe(2);
    expect(renderer.getQueueSize()).toBe(1);
    expect(renderer.getLastPresentedTime()).toBe(10);
  });
});

describe("CanvasRenderer.getVideoUnderflowMs", () => {
  function underflowRig() {
    const { renderer, now } = make({ time: 12 });
    Object.assign(renderer, { frameQueue: [], lastPresentedPts: 11.9, _underflowSince: 0 });
    const track = (t: number) =>
      (renderer as unknown as { trackUnderflow(t: number): void }).trackUnderflow(t);
    return { renderer, now, track };
  }

  it("is zero while the frame on screen covers the clock", () => {
    const { renderer, track } = underflowRig();
    track(11.95);
    expect(renderer.getVideoUnderflowMs()).toBe(0);
  });

  it("counts up from the moment the picture stops covering the clock", () => {
    const { renderer, now, track } = underflowRig();
    track(12.2); // 11.9 + 1 frame + 20ms ended before this
    now.mockReturnValue(5_000 + 2_500);
    track(14.7);
    expect(renderer.getVideoUnderflowMs()).toBe(2_500);
  });

  it("resets once a frame is on time again", () => {
    const { renderer, now, track } = underflowRig();
    track(12.2);
    now.mockReturnValue(7_000);
    (renderer as unknown as { lastPresentedPts: number }).lastPresentedPts = 14.69;
    track(14.7);
    expect(renderer.getVideoUnderflowMs()).toBe(0);
  });

  it("is not an underflow while the next frame is queued and not yet due", () => {
    const { renderer, track } = underflowRig();
    Object.assign(renderer, {
      frameQueue: [{ timestamp: 13_000_000, close: vi.fn(), clone: vi.fn() }],
    });
    track(12.5);
    expect(renderer.getVideoUnderflowMs()).toBe(0);
  });

  it("does not start counting before anything has been presented", () => {
    const { renderer, track } = underflowRig();
    Object.assign(renderer, { lastPresentedPts: -1 });
    track(12.5);
    expect(renderer.getVideoUnderflowMs()).toBe(0);
  });
});
