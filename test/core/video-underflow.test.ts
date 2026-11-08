import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioPacket,
  makePipelinePlayer,
  packetRun,
  videoPacket,
} from "../helpers/pipeline-player";
import { VIDEO_UNDERFLOW_THRESHOLD_MS } from "../../src/core/TimeSource";

vi.mock("../../dist/wasm/movi.js", () => ({ default: vi.fn(async () => ({})) }));
vi.mock("dashjs", () => ({ MediaPlayer: vi.fn() }));
vi.mock("shaka-player/dist/shaka-player.compiled", () => ({
  default: {
    Player: { isBrowserSupported: vi.fn(() => false) },
    polyfill: { installAll: vi.fn() },
    net: { NetworkingEngine: { RequestType: { LICENSE: 1 } } },
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A picture that cannot keep up while the sound is fine (Chromium's video
 * underflow: renderer_impl.cc OnBufferingStateChange, deferred by
 * video_underflow_threshold_ in renderer_impl.h). The renderer measures how long
 * it has been without an on-time frame; the player decides. Past the threshold
 * it goes through the same buffering state as every other stall: the clock and
 * the sound stop together, the picture is caught up to the held clock, and the
 * existing resume gate lets go.
 */
const reads = () => packetRun((t) => videoPacket(t), 100, 130, 1 / 24);

async function playing(opts: Parameters<typeof makePipelinePlayer>[0] = {}) {
  const f = await makePipelinePlayer({
    state: "playing",
    audioBuffered: 1.5,
    rendererQueue: 0,
    reads: reads(),
    queuedVideo: packetRun((t) => videoPacket(t), 10, 12, 1 / 24),
    queuedAudio: packetRun((t) => audioPacket(t), 10, 12, 0.02),
    ...opts,
  });
  f.player.clock.seek(10);
  f.player.clock.start();
  return f;
}

describe("video underflow while the sound is fine", () => {
  it("enters buffering once the picture has had no on-time frame for the threshold", async () => {
    const f = await playing({ videoUnderflowMs: VIDEO_UNDERFLOW_THRESHOLD_MS + 100 });
    await f.tick();

    expect(f.player.stateManager.getState()).toBe("buffering");
    // Sound and clock stop together, and the picture's loop with them.
    expect(f.player.audioRenderer.suspendForBuffering).toHaveBeenCalledOnce();
    expect(f.player.clock.isPlaying()).toBe(false);
    expect(f.player.videoRenderer.stopPresentationLoop).toHaveBeenCalled();
    expect(f.player.wasPlayingBeforeRebuffer).toBe(true);
    expect(f.player._catchingUpVideo).toBe(true);
  }, 20_000);

  it("waits out a shorter gap: the sound is not glitched for a hitch in the picture", async () => {
    const f = await playing({ videoUnderflowMs: VIDEO_UNDERFLOW_THRESHOLD_MS - 100 });
    await f.tick();

    expect(f.player.stateManager.getState()).toBe("playing");
    expect(f.player.audioRenderer.suspendForBuffering).not.toHaveBeenCalled();
    expect(f.player.clock.isPlaying()).toBe(true);
  }, 20_000);

  it("is not an underflow once the picture has nothing left to show", async () => {
    const f = await playing({
      videoUnderflowMs: VIDEO_UNDERFLOW_THRESHOLD_MS + 100,
      queuedVideo: [],
      video: { isSoftware: false, worker: false, queueSize: 0 },
    });
    f.player.eofReached = true;
    await f.tick();

    expect(f.player.audioRenderer.suspendForBuffering).not.toHaveBeenCalled();
  }, 20_000);

  it("catches the picture up to the held clock, and resumes only with a frame that is on time", async () => {
    const f = await playing({ videoUnderflowMs: VIDEO_UNDERFLOW_THRESHOLD_MS + 100 });
    await f.tick();
    expect(f.player.stateManager.getState()).toBe("buffering");
    const heldAt = f.player.clock.getTime();

    // While held, whatever the decoder delivers is behind the clock: it is
    // discarded against the held time, so a "queued frame" means an on-time one.
    let queued = 0;
    const renderer = f.player.videoRenderer;
    renderer.getQueueSize = () => queued;
    renderer.discardLateFrames = vi.fn(() => {
      queued = 0;
      return 4;
    });
    queued = 4; // late frames arrive
    await f.tick();
    expect(renderer.discardLateFrames).toHaveBeenCalledWith(heldAt);
    expect(f.player.stateManager.getState()).toBe("buffering");
    expect(f.player.audioRenderer.resumeFromBuffering).not.toHaveBeenCalled();

    // The decoder reaches the clock: a frame survives the discard.
    renderer.discardLateFrames = vi.fn(() => 0);
    queued = 2;
    f.player.audioRenderer.getBufferedDuration = () => 1.5;
    await f.tick();
    expect(f.player.audioRenderer.resumeFromBuffering).toHaveBeenCalledOnce();
    expect(f.player.stateManager.getState()).not.toBe("buffering");
    expect(f.player._catchingUpVideo).toBe(false);
  }, 20_000);

  it("does not discard anything while buffering for some other reason", async () => {
    const f = await makePipelinePlayer({
      state: "buffering",
      rendererQueue: 1,
      audioBuffered: 0.5,
      reads: reads(),
      queuedVideo: packetRun((t) => videoPacket(t), 10, 11.5, 1 / 24),
      queuedAudio: packetRun((t) => audioPacket(t), 10, 11.5, 0.02),
    });
    await f.tick();
    expect(f.player.videoRenderer.discardLateFrames).not.toHaveBeenCalled();
  }, 20_000);
});
