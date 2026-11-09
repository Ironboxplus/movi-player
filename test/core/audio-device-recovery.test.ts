import { afterEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "../helpers/browser-globals";
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
  vi.restoreAllMocks();
});

/**
 * What the player does when the audio device comes back (AudioRenderer drops
 * what the dead context held and reports it): restart the sound at the
 * playhead, but only while playing.
 */
describe("MoviPlayer: audio device recovered", () => {
  it("registers itself with the audio renderer", async () => {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player: any = new MoviPlayer({});
    expect(player.audioRenderer.onContextRecovered).toBeTypeOf("function");
    const spy = vi.spyOn(player, "onAudioContextRecovered").mockImplementation(() => {});
    player.audioRenderer.onContextRecovered();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("while playing, seeks to the playhead and holds off the desync net", async () => {
    const { player } = await makePipelinePlayer();
    player.seek = vi.fn(async () => {});
    vi.spyOn(player.clock, "getTime").mockReturnValue(754.25);
    const before = performance.now();

    player.onAudioContextRecovered();

    expect(player.seek).toHaveBeenCalledWith(754.25);
    expect(player._lastDesyncSeekTime).toBeGreaterThanOrEqual(before);
  });

  it("not while buffering, whose resume restarts at the playhead anyway", async () => {
    const { player } = await makePipelinePlayer({ state: "buffering" });
    player.seek = vi.fn(async () => {});
    player.onAudioContextRecovered();
    expect(player.seek).not.toHaveBeenCalled();
  });
});
