import { afterEach, describe, expect, it, vi } from "vitest";
import { makePipelinePlayer } from "../helpers/pipeline-player";

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
 * A seek throws the old position's work away (docs/PLAN_MOVI_PIPELINE.md P3,
 * mpv's playloop.c reset): the video decoder is re-armed in place instead of
 * drained, because draining has to emit every queued frame into a free output
 * surface and a renderer that is holding them all never frees one. The
 * frames the new position does not want are dropped on the way out by the
 * seek target's filter, which is mpv's start_pts.
 */
describe("seek discards instead of draining", () => {
  it("re-arms the video decoder with a discarding flush", async () => {
    const f = await makePipelinePlayer({
      video: { isSoftware: false, worker: false, queueSize: 40 },
    });
    await f.player.seek(30);
    expect(f.videoDecoder.flush).toHaveBeenCalledTimes(1);
    expect(f.videoDecoder.flush).toHaveBeenCalledWith({ discard: true });
    expect(f.audioDecoder.flush).toHaveBeenCalledTimes(1);
  }, 20_000);
});
