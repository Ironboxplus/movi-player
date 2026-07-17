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
