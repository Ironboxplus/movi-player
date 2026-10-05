import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioPacket,
  makePipelinePlayer,
  packetRun,
  videoPacket,
} from "../helpers/pipeline-player";

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
});

/**
 * Buffering is decided on how much media the player holds ahead of the
 * playhead, not on how long it has waited and not on what the decoders are
 * doing (docs/PLAN_MOVI_PIPELINE.md P2, mpv's playloop.c): in when an output
 * ran dry AND its packet queue has nothing left to give; out when every
 * active stream holds a second ahead, or the file has ended.
 */
const reads = () => packetRun((t) => videoPacket(t), 100, 130, 1 / 24);

function left(f: Awaited<ReturnType<typeof makePipelinePlayer>>): boolean {
  return f.player.stateManager.getState() !== "buffering";
}

describe("rebuffer exit: forward seconds", () => {
  it("resumes as soon as every stream holds a second ahead, with no minimum dwell (it only just entered)", async () => {
    const f = await makePipelinePlayer({
      state: "buffering",
      rendererQueue: 1,
      audioBuffered: 0.5,
      reads: reads(),
      queuedVideo: packetRun((t) => videoPacket(t), 10, 11.5, 1 / 24),
      queuedAudio: packetRun((t) => audioPacket(t), 10, 11.5, 0.02),
    });
    await f.tick();
    expect(left(f)).toBe(true);
    expect(f.player.audioRenderer.resumeFromBuffering).toHaveBeenCalled();
  }, 20_000);

  it.each([true, false])(
    "keeps buffering while a stream is short, bound or not, with no timer to fall back on (bindav=%s)",
    async (bindAV) => {
      const f = await makePipelinePlayer({
        state: "buffering",
        rendererQueue: 1,
        audioBuffered: 0.5,
        reads: reads(),
        // Video holds 0.3s of packets (+1 decoded frame): short. Audio is
        // fine. The old 3s fallback and 15s bound escape are gone.
        queuedVideo: packetRun((t) => videoPacket(t), 10, 10.3, 1 / 24),
        queuedAudio: packetRun((t) => audioPacket(t), 10, 13, 0.02),
      });
      f.player._bindAV = bindAV;
      await f.tick();
      expect(left(f)).toBe(false);
      expect(f.player.audioRenderer.resumeFromBuffering).not.toHaveBeenCalled();
    },
    20_000,
  );

  it("counts what is already decoded toward the second, so a full pipeline does not wait for the queue", async () => {
    const f = await makePipelinePlayer({
      state: "buffering",
      // 30 frames at 24fps and 1.5s of audio the renderer already holds.
      rendererQueue: 30,
      audioBuffered: 1.5,
      reads: reads(),
    });
    await f.tick();
    expect(left(f)).toBe(true);
  }, 20_000);

  it("resumes at end of file whatever the queues hold", async () => {
    const f = await makePipelinePlayer({
      state: "buffering",
      rendererQueue: 1,
      audioBuffered: 0.5,
    });
    f.player.eofReached = true;
    await f.tick();
    expect(left(f)).toBe(true);
  }, 20_000);

  it("does not wait for seconds the byte ceiling will never let it queue", async () => {
    const big = 100 * 1024;
    const f = await makePipelinePlayer({
      state: "buffering",
      rendererQueue: 1,
      audioBuffered: 0.5,
      reads: reads(),
      // 700 x 100KB over 70ms: far under a second, over the 64MB ceiling.
      queuedVideo: packetRun((t) => videoPacket(t, false, big), 10, 10.07, 0.0001),
      queuedAudio: packetRun((t) => audioPacket(t), 10, 12, 0.02),
    });
    await f.tick();
    expect(left(f)).toBe(true);
  }, 20_000);

  it("still needs a frame to show, however much is queued", async () => {
    const f = await makePipelinePlayer({
      state: "buffering",
      rendererQueue: 0,
      audioBuffered: 0.5,
      reads: reads(),
      queuedVideo: packetRun((t) => videoPacket(t), 10, 13, 1 / 24),
      queuedAudio: packetRun((t) => audioPacket(t), 10, 13, 0.02),
    });
    await f.tick();
    expect(left(f)).toBe(false);
  }, 20_000);

  it("a cold prime still waits for its 2s decoded audio cushion", async () => {
    const queued = {
      queuedVideo: packetRun((t) => videoPacket(t), 10, 13, 1 / 24),
      queuedAudio: packetRun((t) => audioPacket(t), 10, 13, 0.02),
    };
    const thin = await makePipelinePlayer({
      state: "buffering",
      rendererQueue: 5,
      audioBuffered: 1.0,
      reads: reads(),
      ...queued,
    });
    thin.player._primingAudio = true;
    await thin.tick();
    expect(left(thin)).toBe(false);

    const full = await makePipelinePlayer({
      state: "buffering",
      rendererQueue: 5,
      audioBuffered: 2.1,
      reads: reads(),
      ...queued,
    });
    full.player._primingAudio = true;
    await full.tick();
    expect(left(full)).toBe(true);
  }, 20_000);
});

describe("rebuffer entry: an output ran dry AND its queue is empty", () => {
  async function stalled(opts: {
    queuedVideo?: ReturnType<typeof videoPacket>[];
    queuedAudio?: ReturnType<typeof audioPacket>[];
    videoDecoderQueue?: number;
    underrunning?: boolean;
    rendererQueue: number;
    audioBuffered: number;
  }) {
    const f = await makePipelinePlayer({
      rendererQueue: opts.rendererQueue,
      audioBuffered: opts.audioBuffered,
      video: {
        isSoftware: false,
        worker: false,
        queueSize: opts.videoDecoderQueue ?? 0,
      },
      reads: reads(),
      queuedVideo: opts.queuedVideo,
      queuedAudio: opts.queuedAudio,
    });
    f.player._bindAV = true;
    f.player.audioRenderer.isUnderrunning = () => opts.underrunning ?? false;
    // The stall window opened a second ago: the detector acts this pass.
    f.player._stallStartTime = performance.now() - 1000;
    f.player._stallStartFrames = 0;
    return f;
  }
  const entered = (f: Awaited<ReturnType<typeof stalled>>) =>
    f.player.stateManager.getState() === "buffering";

  it("video output empty and video queue empty: buffers", async () => {
    const f = await stalled({ rendererQueue: 0, audioBuffered: 0.5 });
    await f.tick();
    expect(entered(f)).toBe(true);
  }, 20_000);

  it("video output empty but packets still queued: a slow decoder is not a stall", async () => {
    const f = await stalled({
      rendererQueue: 0,
      audioBuffered: 0.5,
      queuedVideo: packetRun((t) => videoPacket(t), 10, 11, 1 / 24),
    });
    await f.tick();
    expect(entered(f)).toBe(false);
  }, 20_000);

  it("video output empty, queue empty, but the decoder is still chewing: not a stall either", async () => {
    const f = await stalled({
      rendererQueue: 0,
      audioBuffered: 0.5,
      videoDecoderQueue: 12,
    });
    await f.tick();
    expect(entered(f)).toBe(false);
  }, 20_000);

  it("audio underrunning and audio queue empty: buffers", async () => {
    const f = await stalled({
      rendererQueue: 10,
      audioBuffered: 0.5,
      underrunning: true,
    });
    await f.tick();
    expect(entered(f)).toBe(true);
  }, 20_000);

  it("audio underrunning with audio packets queued: decode behind realtime, not a stall", async () => {
    const f = await stalled({
      rendererQueue: 10,
      audioBuffered: 0.5,
      underrunning: true,
      queuedAudio: packetRun((t) => audioPacket(t), 10, 11, 0.02),
    });
    await f.tick();
    expect(entered(f)).toBe(false);
  }, 20_000);
});
