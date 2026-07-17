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

describe("software video Worker scheduling policy", () => {
  it("does not classify Worker video decode as main-thread software work", async () => {
    expect((await makePlayer(true)).isMainThreadSoftwareDecoding()).toBe(false);
  });

  it("still classifies the legacy software video decoder as main-thread work", async () => {
    expect((await makePlayer(false)).isMainThreadSoftwareDecoding()).toBe(true);
  });
});
