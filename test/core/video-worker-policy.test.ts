import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../dist/wasm/movi.js", () => ({
  default: vi.fn(async () => ({})),
}));
vi.mock("dashjs", () => ({ MediaPlayer: vi.fn() }));
vi.mock("shaka-player/dist/shaka-player.compiled", () => ({
  default: {
    Player: { isBrowserSupported: vi.fn(() => false) },
    polyfill: { installAll: vi.fn() },
    net: { NetworkingEngine: { RequestType: { LICENSE: 1 } } },
  },
}));

async function makePlayer(videoWorker: boolean) {
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const { MoviPlayer } = await import("../../src/core/MoviPlayer");
  const player = Object.create(MoviPlayer.prototype) as any;
  player.videoDecoder = {
    isSoftware: true,
    getStats: () => ({ worker: videoWorker ? {} : undefined }),
  };
  player.audioDecoder = {
    isSoftware: false,
    getStats: () => ({ worker: undefined }),
  };
  return player;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The first `await import` here pulls in the whole MoviPlayer module graph,
// which after the 0.4.0 merge is large enough to exceed the 5s default on a
// cold transform — and does so reliably under `--coverage`, whose V8
// instrumentation runs over every module regardless of the report filter. The
// assertions themselves are instant; this is import cost, not a hang. Same
// allowance the other MoviPlayer-importing suites already make.
describe("software video Worker scheduling policy", () => {
  it("does not classify Worker video decode as main-thread software work", async () => {
    expect((await makePlayer(true)).isMainThreadSoftwareDecoding()).toBe(false);
  }, 20_000);

  it("still classifies the legacy software video decoder as main-thread work", async () => {
    expect((await makePlayer(false)).isMainThreadSoftwareDecoding()).toBe(true);
  }, 20_000);
});
