import { afterEach, describe, expect, it, vi } from "vitest";
import { makePipelinePlayer, videoTrack } from "../helpers/pipeline-player";

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
 * A speed change must not stop the picture (upstream 181ee7a, 8e77c8a). The
 * corrective seek flushes both decoders and throws the frame queue away; it is
 * only worth paying when the audio read-ahead has something to pivot on and
 * cannot carry the change itself.
 */
async function playing(opts: { video?: boolean; canCarry: boolean }) {
  const f = await makePipelinePlayer({
    tracks: opts.video ? [videoTrack] : undefined,
    rendererQueue: 10,
    audioBuffered: opts.canCarry ? 1 : 0.1,
  });
  const p = f.player;
  p.seek = vi.fn(async () => {});
  p.videoRenderer.setPlaybackRate = vi.fn();
  p.videoDecoder.setPlaybackRate = vi.fn();
  p.audioRenderer.setPlaybackRate = vi.fn();
  p.audioRenderer.canCarryRateChange = vi.fn(() => opts.canCarry);
  p.audioRenderer.isStreamEnded = vi.fn(() => false);
  return f;
}

describe("a speed change while playing", () => {
  it("applies at once and does not seek when the audio can carry it", async () => {
    const f = await playing({ canCarry: true });
    f.player.setPlaybackRate(2);
    expect(f.player.clock.getPlaybackRate()).toBe(2);
    expect(f.player.seek).not.toHaveBeenCalled();
  }, 20_000);

  it("does not seek a file with no sound, which has no read-ahead to pivot", async () => {
    const f = await playing({ video: true, canCarry: false });
    f.player.setPlaybackRate(2);
    expect(f.player.clock.getPlaybackRate()).toBe(2);
    expect(f.player.seek).not.toHaveBeenCalled();
  }, 20_000);

  it("holds the rate while the audio cushion is missing, then applies it without a seek", async () => {
    const f = await playing({ canCarry: false });
    const p = f.player;
    p.setPlaybackRate(2);
    expect(p.clock.getPlaybackRate()).toBe(1);
    expect(p.seek).not.toHaveBeenCalled();

    await f.tick();
    expect(p.clock.getPlaybackRate()).toBe(1);

    p.audioRenderer.canCarryRateChange = vi.fn(() => true);
    await f.tick();
    expect(p.clock.getPlaybackRate()).toBe(2);
    expect(p.seek).not.toHaveBeenCalled();
  }, 20_000);

  it("holds a slow-down the same way as a speed-up", async () => {
    const f = await playing({ canCarry: true });
    const p = f.player;
    p.setPlaybackRate(2);
    expect(p.clock.getPlaybackRate()).toBe(2);
    p.audioRenderer.canCarryRateChange = vi.fn(() => false);
    p.setPlaybackRate(1);
    expect(p.clock.getPlaybackRate()).toBe(2);
    expect(p.seek).not.toHaveBeenCalled();
    p.audioRenderer.canCarryRateChange = vi.fn(() => true);
    await f.tick();
    expect(p.clock.getPlaybackRate()).toBe(1);
    expect(p.seek).not.toHaveBeenCalled();
  }, 20_000);

  it("takes the corrective seek once waiting has gone on too long", async () => {
    const f = await playing({ canCarry: false });
    const p = f.player;
    p.setPlaybackRate(2);
    const t0 = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(t0 + 1600);
    await f.tick();
    expect(p.clock.getPlaybackRate()).toBe(2);
    expect(p.seek).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("forgets a held change when the viewer asks for the rate it already has", async () => {
    const f = await playing({ canCarry: false });
    const p = f.player;
    p.setPlaybackRate(2);
    p.setPlaybackRate(1);
    p.audioRenderer.canCarryRateChange = vi.fn(() => true);
    await f.tick();
    expect(p.clock.getPlaybackRate()).toBe(1);
  }, 20_000);

  it("applies a held change when the viewer pauses", async () => {
    const f = await playing({ canCarry: false });
    const p = f.player;
    p.startPauseBuffering = vi.fn();
    p.setPlaybackRate(2);
    p.pause();
    expect(p.clock.getPlaybackRate()).toBe(2);
    expect(p.seek).not.toHaveBeenCalled();
  }, 20_000);
});
