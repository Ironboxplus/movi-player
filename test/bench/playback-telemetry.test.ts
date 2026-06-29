import { describe, expect, it } from "vitest";
import {
  normalizeMoviStats,
  normalizePlaybackSample,
  summarize,
} from "../../scripts/benchmark-playback.mjs";

describe("playback benchmark telemetry", () => {
  it("reads numeric movi stats from the stats panel keys", () => {
    expect(
      normalizeMoviStats({
        "Audio Buffered Seconds": 1.25,
        "Audio Decoder Queue": 2,
        "Video Decoder Queue": 3,
        "Audio Worker Queue Depth": 4,
        "Audio Worker In Flight": 5,
        "Audio Worker Reorder Backlog": 6,
        "Audio Worker Stale Drops": 7,
        "Decode Path": "Software-heavy",
        "Audio Underrun Risk": "Low",
      }),
    ).toEqual({
      decodePath: "Software-heavy",
      audioUnderrunRisk: "Low",
      audioBufferedSeconds: 1.25,
      audioDecoderQueue: 2,
      videoDecoderQueue: 3,
      audioWorkerQueueDepth: 4,
      audioWorkerInFlight: 5,
      audioWorkerReorderBacklog: 6,
      audioWorkerStaleDrops: 7,
    });
  });

  it("prefers movi renderer clocks over hidden video element telemetry", () => {
    const sample = normalizePlaybackSample({
      wallMs: 1000,
      video: {
        currentTime: 0,
        presentedFrames: 0,
        droppedFrames: 3,
      },
      moviRenderer: {
        currentTime: 42.5,
        framesPresented: 1020,
        frameQueue: 8,
        videoFrameRate: 24,
        syncedToAudio: true,
      },
      audioRenderer: {
        currentMediaTime: 42.45,
        maxScheduledMediaTime: 43.1,
        scheduledCount: 500,
        activeSources: 16,
        isPlaying: true,
      },
      movi: normalizeMoviStats(),
    });

    expect(sample.video).toEqual({
      currentTime: 42.5,
      presentedFrames: 1020,
      droppedFrames: 3,
      source: "movi",
    });
    expect(sample.audio.currentMediaTime).toBe(42.45);
    expect(sample.moviRenderer.frameQueue).toBe(8);
  });

  it("summarizes playback and decoder telemetry deltas", () => {
    const summary = summarize([
      {
        wallMs: 0,
        video: { currentTime: 10, presentedFrames: 100, droppedFrames: 1 },
        movi: {
          audioBufferedSeconds: 0.8,
          audioDecoderQueue: 1,
          videoDecoderQueue: 2,
          audioWorkerQueueDepth: 0,
          audioWorkerInFlight: 0,
          audioWorkerReorderBacklog: 0,
          audioWorkerStaleDrops: 0,
          decodePath: "Software-heavy",
          audioUnderrunRisk: "Low",
        },
      },
      {
        wallMs: 2_000,
        video: { currentTime: 12, presentedFrames: 160, droppedFrames: 4 },
        movi: {
          audioBufferedSeconds: 1.1,
          audioDecoderQueue: 3,
          videoDecoderQueue: 5,
          audioWorkerQueueDepth: 2,
          audioWorkerInFlight: 1,
          audioWorkerReorderBacklog: 0,
          audioWorkerStaleDrops: 4,
          decodePath: "Software-heavy",
          audioUnderrunRisk: "Medium",
        },
      },
    ]);

    expect(summary.presentedFps).toBe(30);
    expect(summary.mediaRate).toBe(1);
    expect(summary.audioMediaRate).toBe(0);
    expect(summary.droppedFrames).toBe(3);
    expect(summary.sampleSource).toBe("video");
    expect(summary.lastAudioBufferedSeconds).toBe(1.1);
    expect(summary.lastAudioDecoderQueue).toBe(3);
    expect(summary.lastVideoDecoderQueue).toBe(5);
    expect(summary.lastAudioWorkerQueueDepth).toBe(2);
    expect(summary.lastAudioWorkerInFlight).toBe(1);
    expect(summary.lastAudioWorkerReorderBacklog).toBe(0);
    expect(summary.lastAudioWorkerStaleDrops).toBe(4);
    expect(summary.lastDecodePath).toBe("Software-heavy");
    expect(summary.lastAudioUnderrunRisk).toBe("Medium");
  });

  it("summarizes movi renderer frame rate and audio clock rate", () => {
    const summary = summarize([
      {
        wallMs: 0,
        video: { currentTime: 0, presentedFrames: 0, droppedFrames: 0 },
        moviRenderer: {
          currentTime: 300,
          framesPresented: 7200,
        },
        audioRenderer: {
          currentMediaTime: 300,
        },
        movi: normalizeMoviStats({
          "Decode Path": "Software-heavy",
          "Audio Underrun Risk": "Low",
        }),
      },
      {
        wallMs: 10_000,
        video: { currentTime: 0, presentedFrames: 0, droppedFrames: 0 },
        moviRenderer: {
          currentTime: 310,
          framesPresented: 7440,
        },
        audioRenderer: {
          currentMediaTime: 309.9,
        },
        movi: normalizeMoviStats({
          "Decode Path": "Software-heavy",
          "Audio Underrun Risk": "Low",
        }),
      },
    ]);

    expect(summary.presentedFps).toBe(24);
    expect(summary.mediaRate).toBe(1);
    expect(summary.audioMediaRate).toBeCloseTo(0.99);
    expect(summary.sampleSource).toBe("movi");
  });
});
