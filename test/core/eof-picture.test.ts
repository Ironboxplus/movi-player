import { afterEach, describe, expect, it, vi } from "vitest";
import { makePipelinePlayer, packetRun, videoPacket, videoTrack } from "../helpers/pipeline-player";

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
 * The end of a picture-only file (upstream f266004, 1147919). The clock arms
 * the ending half a second before the duration; the picture running out
 * finishes it. And the decoder is asked for its reorder tail once the last
 * packet has gone in, because WebCodecs holds those frames until a flush.
 */
async function atEof(opts: { rendererQueue: number; quietMs: number; queuedVideo?: any[] }) {
  const f = await makePipelinePlayer({
    tracks: [videoTrack],
    rendererQueue: opts.rendererQueue,
    queuedVideo: opts.queuedVideo,
  });
  const p = f.player;
  p.eofReached = true;
  p.eofSince = performance.now();
  p.clock.setDuration(1422);
  p.clock.seek(1421.8); // inside the half-second the clock arms
  p.videoDecoder.msSinceLastFrame = () => opts.quietMs;
  const ended = vi.spyOn(p, "handleEnded").mockImplementation(() => {});
  return { f, p, ended };
}

describe("end of a picture-only file", () => {
  it("does not end while decoded frames are still waiting to be shown", async () => {
    const { f, ended } = await atEof({ rendererQueue: 3, quietMs: 500 });
    await f.tick();
    expect(ended).not.toHaveBeenCalled();
  }, 20_000);

  it("does not end between decoder callbacks", async () => {
    const { f, ended } = await atEof({ rendererQueue: 0, quietMs: 40 });
    await f.tick();
    expect(ended).not.toHaveBeenCalled();
  }, 20_000);

  it("ends once the picture has run out and the decoder has gone quiet", async () => {
    const { f, ended } = await atEof({ rendererQueue: 0, quietMs: 500 });
    await f.tick();
    expect(ended).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("gives up waiting for a frame that can never come due", async () => {
    const { f, ended } = await atEof({ rendererQueue: 2, quietMs: 500 });
    await f.tick();
    expect(ended).not.toHaveBeenCalled();
    const t0 = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(t0 + 2500);
    await f.tick();
    expect(ended).toHaveBeenCalledTimes(1);
  }, 20_000);
});

describe("asking the decoder for its reorder tail", () => {
  it("flushes once, after the last queued packet has gone to the decoder", async () => {
    const { f, p } = await atEof({ rendererQueue: 2, quietMs: 500 });
    await f.tick();
    await f.tick();
    expect(p.videoDecoder.flush).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("does not flush while packets are still queued behind the decoder", async () => {
    const { f, p } = await atEof({
      rendererQueue: 2,
      quietMs: 500,
      queuedVideo: packetRun((t) => videoPacket(t), 1420, 1421, 1 / 24),
    });
    // A decoder at its cap keeps the queued packets where they are.
    p.videoDecoder.queueSize = 1000;
    await f.tick();
    expect(p.videoDecoder.flush).not.toHaveBeenCalled();
  }, 20_000);

  it("flushes again for a later end of file", async () => {
    const { f, p } = await atEof({ rendererQueue: 2, quietMs: 500 });
    await f.tick();
    p.eofReached = false;
    p.eofSince = 0;
    p.eofReached = true;
    p.eofSince = performance.now() + 1;
    await f.tick();
    expect(p.videoDecoder.flush).toHaveBeenCalledTimes(2);
  }, 20_000);
});
