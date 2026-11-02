import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioPacket,
  flacTrack,
  makePipelinePlayer,
  videoPacket,
  videoTrack,
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
  vi.restoreAllMocks();
});

/**
 * A file whose streams do not end together (upstream 27e9dab, 6043339,
 * f0953e8, 775fa9d, b11f19a). Past the end of one stream its queue is empty
 * because the stream ENDED, not because it is late, and nothing may wait for
 * packets that do not exist.
 */
const FILE = 243.8;

async function tailFile(opts: {
  videoDuration?: number;
  audioDuration?: number;
  at: number;
  state?: "playing" | "buffering";
  rendererQueue?: number;
  audioBuffered?: number;
}) {
  const f = await makePipelinePlayer({
    state: opts.state ?? "playing",
    tracks: [
      { ...videoTrack, duration: opts.videoDuration ?? FILE },
      { ...flacTrack, duration: opts.audioDuration ?? FILE },
    ],
    rendererQueue: opts.rendererQueue ?? 0,
    audioBuffered: opts.audioBuffered ?? 0,
  });
  const p = f.player;
  p.mediaInfo = { duration: FILE, videoFrameRate: 24 };
  p.startTime = 0;
  p.clock.setDuration(FILE);
  p.clock.seek(opts.at);
  p.declareStreamEnds();
  p.audioRenderer.isStreamEnded = vi.fn(() => false);
  p.audioRenderer.endOfStream = vi.fn();
  return f;
}

/** Ticks with the wall clock moved on, enough for the stall window to elapse. */
async function tickThroughStallWindow(f: Awaited<ReturnType<typeof tailFile>>) {
  const base = performance.now();
  let off = 0;
  vi.spyOn(performance, "now").mockImplementation(() => base + off);
  // Stops right after the window: one more tick would see the buffering it
  // just entered and let the resume gate leave it again.
  for (const step of [0, 700]) {
    off = step;
    await f.tick();
  }
}

describe("declared stream ends", () => {
  it("reads each track's own duration, and only counts a gap over a second as a tail", async () => {
    const f = await tailFile({ videoDuration: 80, audioDuration: 243.3, at: 0 });
    expect(f.player.videoEnd()).toBe(80);
    expect(f.player.audioEnd()).toBe(Number.POSITIVE_INFINITY);
  }, 20_000);

  it("knows nothing of a tail when the container declares none", async () => {
    const f = await tailFile({ at: 0 });
    expect(f.player.videoFinished()).toBe(false);
    expect(f.player.audioFinished()).toBe(false);
  }, 20_000);
});

describe("picture ends before the sound", () => {
  it("is not a stall: an empty video queue past the last frame leaves playback running", async () => {
    const f = await tailFile({ videoDuration: 80, at: 85, audioBuffered: 1 });
    f.player._bindAV = true;
    await tickThroughStallWindow(f);
    expect(f.player.stateManager.getState()).toBe("playing");
  }, 20_000);

  it("is a stall for a picture that is merely late (control)", async () => {
    const f = await tailFile({ at: 85, audioBuffered: 1 });
    f.player._bindAV = true;
    await tickThroughStallWindow(f);
    expect(f.player.stateManager.getState()).toBe("buffering");
  }, 20_000);

  it("does not wait for a frame to resume from buffering", async () => {
    const f = await tailFile({
      videoDuration: 80,
      at: 85,
      state: "buffering",
      rendererQueue: 0,
      audioBuffered: 1,
    });
    f.player.eofReached = false;
    f.player.bufferedAheadSeconds = () => 5;
    await f.tick();
    expect(f.player.stateManager.getState()).not.toBe("buffering");
  }, 20_000);

  it("does not count presented frames past the last one", async () => {
    const f = await tailFile({ videoDuration: 80, at: 85 });
    expect(f.player.isPastVideoEnd()).toBe(true);
    f.player.clock.seek(60);
    expect(f.player.isPastVideoEnd()).toBe(false);
  }, 20_000);

  it("holds no reading hostage to a video queue that will never fill", async () => {
    const f = await tailFile({ videoDuration: 80, at: 85, audioBuffered: 1 });
    f.player.audioQueue.push(audioPacket(86));
    // Audio holds plenty; video is empty and finished: nothing else to read for.
    for (let t = 86.02; t < 92; t += 0.02) f.player.audioQueue.push(audioPacket(t));
    expect(f.player.needsMorePackets(5)).toBe(false);
  }, 20_000);
});

describe("sound ends before the picture", () => {
  it("is not a stall: an empty audio buffer past the last sample leaves playback running", async () => {
    const f = await tailFile({ audioDuration: 193.4, at: 200, rendererQueue: 5 });
    f.player._bindAV = true;
    await tickThroughStallWindow(f);
    expect(f.player.stateManager.getState()).toBe("playing");
  }, 20_000);

  it("is a stall for sound that is merely late (control)", async () => {
    const f = await tailFile({ at: 200, rendererQueue: 5 });
    f.player._bindAV = true;
    await tickThroughStallWindow(f);
    expect(f.player.stateManager.getState()).toBe("buffering");
  }, 20_000);

  it("lets go of the audio clock so the picture can carry the clock", async () => {
    const f = await tailFile({ audioDuration: 193.4, at: 200, rendererQueue: 5 });
    await f.tick();
    expect(f.player.audioRenderer.endOfStream).toHaveBeenCalled();
  }, 20_000);

  it("does not wait for a cushion of sound that the file does not contain", async () => {
    const f = await tailFile({
      audioDuration: 193.4,
      at: 200,
      state: "buffering",
      rendererQueue: 5,
      audioBuffered: 0,
    });
    f.player.bufferedAheadSeconds = () => 5;
    await f.tick();
    expect(f.player.stateManager.getState()).not.toBe("buffering");
  }, 20_000);

  it("ends on the clock, not on a playout head that no longer exists", async () => {
    const f = await tailFile({ audioDuration: 193.4, at: 243.5, rendererQueue: 0 });
    f.player.eofReached = true;
    f.player.eofSince = performance.now();
    f.player.videoDecoder.msSinceLastFrame = () => 500;
    f.player.audioRenderer.getMaxScheduledMediaTime = () => 193.4;
    const ended = vi.spyOn(f.player, "handleEnded").mockImplementation(() => {});
    await f.tick();
    expect(ended).toHaveBeenCalled();
  }, 20_000);
});

describe("stream ends learned at the end of the file", () => {
  async function bare() {
    const f = await tailFile({ at: 0 });
    return f.player;
  }

  it("takes the last packet of a stream seen in the pass as its end", async () => {
    const p = await bare();
    p.beginReadPass(0);
    for (let t = 0; t < 193.4; t += 1) p.notePassPacket(audioPacket(t));
    for (let t = 0; t < FILE; t += 1) p.notePassPacket(videoPacket(t));
    p.markEof();
    expect(p.audioEnd()).toBeCloseTo(193.02, 2);
    expect(p.videoEnd()).toBe(Number.POSITIVE_INFINITY);
  }, 20_000);

  it("a pass that began past the sound and saw none gives only an upper bound", async () => {
    const p = await bare();
    p.beginReadPass(200);
    for (let t = 200; t < FILE; t += 1) p.notePassPacket(videoPacket(t));
    p.markEof();
    expect(p.audioEnd()).toBe(200);
  }, 20_000);

  it("a later pass through the sound sharpens the bound, and never loosens an exact end", async () => {
    const p = await bare();
    p.beginReadPass(200);
    for (let t = 200; t < FILE; t += 1) p.notePassPacket(videoPacket(t));
    p.markEof();
    p.resetEof(0);
    for (let t = 0; t < 193.4; t += 1) p.notePassPacket(audioPacket(t));
    for (let t = 0; t < FILE; t += 1) p.notePassPacket(videoPacket(t));
    p.markEof();
    const exact = p.audioEnd();
    expect(exact).toBeGreaterThan(190);
    p.resetEof(210);
    for (let t = 210; t < FILE; t += 1) p.notePassPacket(videoPacket(t));
    p.markEof();
    expect(p.audioEnd()).toBe(exact);
  }, 20_000);

  it("a freshly loaded source seeked into the silent tail is already past the sound", async () => {
    const p = await bare();
    p.beginReadPass(220);
    for (let t = 220; t < FILE; t += 1) p.notePassPacket(videoPacket(t));
    p.markEof();
    p.clock.seek(225);
    expect(p.audioFinished()).toBe(true);
  }, 20_000);

  it("ignores a stream that merely stops a moment before the file", async () => {
    const p = await bare();
    p.beginReadPass(0);
    for (let t = 0; t < FILE - 0.5; t += 1) p.notePassPacket(audioPacket(t));
    for (let t = 0; t < FILE; t += 1) p.notePassPacket(videoPacket(t));
    p.markEof();
    expect(p.audioEnd()).toBe(Number.POSITIVE_INFINITY);
  }, 20_000);
});
