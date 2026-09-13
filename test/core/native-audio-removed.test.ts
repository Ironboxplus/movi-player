import { afterEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "../helpers/browser-globals";

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
 * P1 (docs/PLAN_MERGE.MD §3.4): the native `<audio>` split-audio path was
 * deleted in favor of the WASM split-audio demuxer for every rendition.
 * `releaseNativeAudio()`/`adoptNativeAudio()` stay on the class only because
 * external callers (e.g. a sibling NativeVideoWrapper engine) duck-type onto
 * whichever engine is currently live during a hand-off — they must be
 * confirmed no-ops on this engine, not a residual entry point back into a
 * second, independently-clocked audio path.
 */
describe("MoviPlayer P1: native <audio> path is unreachable", () => {
  async function makePlayer() {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    return new MoviPlayer({});
  }

  it("releaseNativeAudio() never hands back a live element — this engine owns no <audio>", async () => {
    const player = await makePlayer();
    expect(player.releaseNativeAudio()).toBeNull();
  }, 20_000);

  it("adoptNativeAudio() stops and strips a handed-over element instead of adopting it", async () => {
    const player = await makePlayer();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { revokeObjectURL, createObjectURL: vi.fn() });

    const pause = vi.fn();
    const removeAttribute = vi.fn();
    const load = vi.fn();
    const el = {
      pause,
      removeAttribute,
      load,
      __moviObjectUrl: "blob:carried-over",
      __moviLogicalUrl: "https://example.invalid/audio.mp4",
    } as unknown as HTMLAudioElement;

    player.adoptNativeAudio(el);

    // Stopped, not resumed under this engine's clock.
    expect(pause).toHaveBeenCalledTimes(1);
    expect(removeAttribute).toHaveBeenCalledWith("src");
    expect(load).toHaveBeenCalledTimes(1);
    // The blob URL it was carrying is released, not leaked or kept alive by a
    // second reference this engine holds.
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:carried-over");
    expect((el as any).__moviObjectUrl).toBeUndefined();
    expect((el as any).__moviLogicalUrl).toBeUndefined();
  }, 20_000);

  it("adoptNativeAudio() tolerates an element whose pause()/load() throw (no crash, no adoption)", async () => {
    const player = await makePlayer();
    vi.stubGlobal("URL", { revokeObjectURL: vi.fn(), createObjectURL: vi.fn() });
    const el = {
      pause: () => {
        throw new Error("already detached");
      },
      removeAttribute: vi.fn(),
      load: vi.fn(),
    } as unknown as HTMLAudioElement;

    expect(() => player.adoptNativeAudio(el)).not.toThrow();
  }, 20_000);
});
