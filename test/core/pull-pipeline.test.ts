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

const fullHwVideo = { isSoftware: false, worker: false, queueSize: 31 };

/**
 * The read loop pulls from the demuxer into one queue per stream and the
 * decoders are fed from those queues (docs/PLAN_MOVI_PIPELINE.md P1). These
 * lock the two decisions that replaced the decoder-queue backpressure: when
 * to read (a queue is empty or short of readahead, and the queues are under
 * their byte ceiling) and what to feed (as much as each decoder has room
 * for, independently of the other stream).
 */
describe("pull pipeline: when to read", () => {
  it("reads while the queues are empty", async () => {
    const f = await makePipelinePlayer();
    await f.tick();
    expect(f.readPacket).toHaveBeenCalled();
  }, 20_000);

  it("stops reading once every stream has its readahead queued", async () => {
    const f = await makePipelinePlayer({
      video: fullHwVideo,
      audioBuffered: 6,
      queuedVideo: packetRun((t) => videoPacket(t), 10, 15.5, 1 / 24),
      queuedAudio: packetRun((t) => audioPacket(t), 10, 15.5, 0.02),
    });
    await f.tick();
    expect(f.readPacket).not.toHaveBeenCalled();
  }, 20_000);

  // The coupling this replaces: a video decoder at its cap (a hardware decoder
  // waiting for output surfaces) stopped every read, so the audio starved and
  // the player either dropped video deltas to make room or stalled.
  it("keeps reading for audio while the video decoder is full, and feeds what it reads", async () => {
    const f = await makePipelinePlayer({
      video: fullHwVideo,
      audioBuffered: 0,
      queuedVideo: packetRun((t) => videoPacket(t), 10, 15.5, 1 / 24),
      reads: [audioPacket(10), videoPacket(15.5), audioPacket(10.02)],
    });
    await f.tick();
    expect(f.readPacket).toHaveBeenCalled();
    expect(f.audioDecode).toHaveBeenCalledTimes(2);
    expect(f.videoDecode).not.toHaveBeenCalled();
    // The delta read past the full decoder waits in its queue, in order —
    // nothing in the reference chain is thrown away.
    expect(f.player.videoQueue.lastTimestamp).toBeCloseTo(15.5);
  }, 20_000);

  // A full audio side is the mirror case: a rebuffer whose cushion overshot
  // still has to read until the picture has something to show.
  it("keeps reading for video while the audio side is full", async () => {
    const f = await makePipelinePlayer({
      state: "buffering",
      audioBuffered: 8.6,
      rendererQueue: 0,
      queuedAudio: packetRun((t) => audioPacket(t), 10, 15.5, 0.02),
    });
    await f.tick();
    expect(f.readPacket).toHaveBeenCalled();
  }, 20_000);

  it("stops at the byte ceiling even while a stream is short", async () => {
    const f = await makePipelinePlayer({
      video: fullHwVideo,
      audioBuffered: 0,
      audio: { isSoftware: true, worker: true, queueSize: 200 },
      // 70 x 1MB: over the 64MB ceiling, under any readahead.
      queuedVideo: packetRun((t) => videoPacket(t, false, 1024 * 1024), 10, 10 + 70 / 24, 1 / 24),
    });
    await f.tick();
    expect(f.readPacket).not.toHaveBeenCalled();
  }, 20_000);
});

describe("pull pipeline: what to feed", () => {
  it("feeds video only while the decoder has room", async () => {
    const f = await makePipelinePlayer({
      video: { isSoftware: false, worker: false, queueSize: 28 },
      queuedVideo: packetRun((t) => videoPacket(t), 10, 10.5, 1 / 24),
    });
    await f.tick();
    // 28 -> 31: fed until past the hardware cap of 30, the rest stays queued.
    expect(f.videoDecode).toHaveBeenCalledTimes(3);
    expect(f.player.videoQueue.length).toBe(12 - 3);
  }, 20_000);

  it("holds audio in its queue while a seek waits for its first frame, and feeds video", async () => {
    const f = await makePipelinePlayer({
      waitingForVideoSync: true,
      reads: [videoPacket(10, true), audioPacket(10), audioPacket(10.02)],
    });
    f.player.seekTargetTime = 10;
    await f.tick();
    expect(f.videoDecode).toHaveBeenCalledTimes(1);
    expect(f.audioDecode).not.toHaveBeenCalled();
    expect(f.player.audioQueue.length).toBe(2);
  }, 20_000);

  it("a seek empties both queues", async () => {
    const f = await makePipelinePlayer({
      queuedVideo: packetRun((t) => videoPacket(t), 10, 11, 1 / 24),
      queuedAudio: packetRun((t) => audioPacket(t), 10, 11, 0.02),
    });
    f.player.processLoop = vi.fn();
    await f.player.seek(100);
    expect(f.player.videoQueue.length).toBe(0);
    expect(f.player.audioQueue.length).toBe(0);
  }, 20_000);
});

describe("pull pipeline: reading while not playing", () => {
  it("pause-time buffering reads into the queues without decoding", async () => {
    const f = await makePipelinePlayer({
      reads: [videoPacket(10, true), audioPacket(10), videoPacket(10.04)],
    });
    f.player.stateManager.setState("paused");
    await f.player.pauseBufferTick();
    expect(f.readPacket).toHaveBeenCalled();
    expect(f.player.videoQueue.length).toBe(2);
    expect(f.player.audioQueue.length).toBe(1);
    expect(f.videoDecode).not.toHaveBeenCalled();
    expect(f.audioDecode).not.toHaveBeenCalled();
  }, 20_000);

  it("load-time prebuffer reads into the queues without decoding", async () => {
    const f = await makePipelinePlayer({
      reads: [
        videoPacket(0, true),
        ...packetRun((t) => audioPacket(t), 0, 0.6, 0.02),
        videoPacket(0.04),
      ],
    });
    await f.player.prebuffer();
    expect(f.player.videoQueue.length).toBe(2);
    expect(f.player.audioQueue.length).toBe(30);
    expect(f.videoDecode).not.toHaveBeenCalled();
    expect(f.audioDecode).not.toHaveBeenCalled();
  }, 20_000);
});

/**
 * Split (separate-URL) audio has its own demuxer and its own loop
 * (pumpSplitAudio); it reads into its own queue by the same rule — read while
 * short of readahead, feed while the decoder and cushion have room.
 */
describe("pull pipeline: split audio", () => {
  async function splitPlayer(opts: Parameters<typeof makePipelinePlayer>[0], reads: ReturnType<typeof audioPacket>[]) {
    const f = await makePipelinePlayer({ tracks: [videoTrackOnly()], ...opts });
    const queue = [...reads];
    const audioRead = vi.fn(async () => queue.shift() ?? null);
    Object.assign(f.player, {
      audioDemuxer: { readPacket: audioRead },
      _splitAudioTrackId: -1,
      _splitAudioPtsDelta: 0,
      _splitAudioEof: false,
      _lastSplitAudioPts: 0,
    });
    return { ...f, audioRead };
  }

  it("reads into its queue while a seek waits for video, and feeds nothing", async () => {
    const f = await splitPlayer({ waitingForVideoSync: true }, [audioPacket(0), audioPacket(0.02)]);
    await f.player.pumpSplitAudio();
    expect(f.audioRead).toHaveBeenCalled();
    expect(f.audioDecode).not.toHaveBeenCalled();
    expect(f.player.splitAudioQueue.length).toBe(2);
  }, 20_000);

  it("feeds what it reads once nothing holds it back", async () => {
    const f = await splitPlayer({}, [audioPacket(0), audioPacket(0.02)]);
    await f.player.pumpSplitAudio();
    expect(f.audioDecode).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("stops reading once its queue holds the readahead", async () => {
    const f = await splitPlayer({ audio: { isSoftware: true, worker: true, queueSize: 41 } }, []);
    for (const p of packetRun((t) => audioPacket(t), 0, 5.5, 0.02)) f.player.splitAudioQueue.push(p);
    await f.player.pumpSplitAudio();
    expect(f.audioRead).not.toHaveBeenCalled();
    expect(f.audioDecode).not.toHaveBeenCalled();
  }, 20_000);
});

function videoTrackOnly() {
  return { id: 0, type: "video" as const, codec: "hevc", width: 1920, height: 1080, frameRate: 24 };
}
