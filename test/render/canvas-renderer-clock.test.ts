import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasRenderer } from "../../src/render/CanvasRenderer";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CanvasRenderer audio-clock guard", () => {
  it("does not let normal-rate 24fps video run ahead while audio is unhealthy", () => {
    vi.spyOn(performance, "now").mockReturnValue(5_000);

    const renderer = Object.create(CanvasRenderer.prototype) as CanvasRenderer & {
      isPlaying: boolean;
      presentationStartTime: number;
      presentationStartPts: number;
      playbackRate: number;
      videoFrameRate: number;
      getAudioTime: () => number;
      _isAudioHealthy: () => boolean;
      lastKnownAudioTime: number;
      syncedToAudio: boolean;
      framesPresented: number;
      getCurrentPlaybackTime(): number;
    };

    Object.assign(renderer, {
      // A configured picture: upstream 0.4.1 answers the audio clock when there
      // is no picture (isVideoConfigured false), which a bare prototype is.
      isVideoConfigured: true,
      subtitleClockTimer: null,
      isPlaying: true,
      presentationStartTime: 1_000,
      presentationStartPts: 5,
      playbackRate: 1,
      videoFrameRate: 24,
      getAudioTime: () => 6,
      _isAudioHealthy: () => false,
      lastKnownAudioTime: 6,
      syncedToAudio: true,
      framesPresented: 221,
    });

    expect(renderer.getCurrentPlaybackTime()).toBeCloseTo(6.15, 6);
  });
});

describe("CanvasRenderer releaseAudioSync", () => {
  let now: ReturnType<typeof vi.spyOn>;
  function make(audio: { time: number; healthy: boolean }) {
    now = vi.spyOn(performance, "now").mockReturnValue(5_000);
    const renderer = Object.create(CanvasRenderer.prototype) as CanvasRenderer & {
      getCurrentPlaybackTime(): number;
      [key: string]: unknown;
    };
    Object.assign(renderer, {
      // A configured picture: upstream 0.4.1 answers the audio clock when there
      // is no picture (isVideoConfigured false), which a bare prototype is.
      isVideoConfigured: true,
      subtitleClockTimer: null,
      isPlaying: true,
      presentationStartTime: 1_000,
      presentationStartPts: 5,
      playbackRate: 1,
      videoFrameRate: 24,
      getAudioTime: () => audio.time,
      _isAudioHealthy: () => audio.healthy,
      lastKnownAudioTime: -1,
      syncedToAudio: false,
      framesPresented: 221,
    });
    return renderer;
  }

  it("stops pinning the picture to the old track once released", () => {
    const audio = { time: 6, healthy: true };
    const renderer = make(audio);
    // Following audio at 6s, then the track switch empties the audio side.
    renderer.getCurrentPlaybackTime();
    audio.time = -1;
    audio.healthy = false;
    now.mockReturnValue(9_000);
    expect(renderer.getCurrentPlaybackTime()).toBeCloseTo(6.15, 6);

    renderer.releaseAudioSync();
    // Wall clock from the 6s anchor taken at t=5000: 4s later.
    expect(renderer.getCurrentPlaybackTime()).toBeCloseTo(10, 6);
  });

  it("still pins the picture when the audio drops out without a release", () => {
    const audio = { time: 6, healthy: true };
    const renderer = make(audio);
    renderer.getCurrentPlaybackTime();
    audio.healthy = false;
    now.mockReturnValue(9_000);
    expect(renderer.getCurrentPlaybackTime()).toBeCloseTo(6.15, 6);
  });

  it("syncs to the new audio once it is healthy again", () => {
    const audio = { time: 6, healthy: true };
    const renderer = make(audio);
    renderer.getCurrentPlaybackTime();
    audio.time = -1;
    audio.healthy = false;
    renderer.releaseAudioSync();
    now.mockReturnValue(9_000);
    expect(renderer.getCurrentPlaybackTime()).toBeCloseTo(10, 6);

    audio.time = 10.1;
    audio.healthy = true;
    // Within 0.4s: soft sync, the wall clock carries on.
    expect(renderer.getCurrentPlaybackTime()).toBeCloseTo(10, 6);
    expect(renderer.syncedToAudio).toBe(true);

    renderer.releaseAudioSync();
    audio.time = 12;
    // Beyond 0.4s: hard re-anchor onto the audio.
    expect(renderer.getCurrentPlaybackTime()).toBe(12);
  });
});
