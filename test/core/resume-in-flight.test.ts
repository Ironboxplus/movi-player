import { afterEach, describe, expect, it, vi } from "vitest";
import { makePipelinePlayer, packetRun, videoPacket, audioPacket } from "../helpers/pipeline-player";

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
 * Leaving buffering parks the state on "paused" for the length of the async
 * play() that follows (upstream 8d9e25c). The decoder keeps handing frames
 * over meanwhile, and a frame arriving outside playing/buffering used to be
 * closed, leaving a hole in the renderer queue that froze the picture.
 */
async function resumeInFlight() {
  const f = await makePipelinePlayer({
    state: "buffering",
    rendererQueue: 1,
    audioBuffered: 0.5,
    reads: packetRun((t) => videoPacket(t), 100, 130, 1 / 24),
    queuedVideo: packetRun((t) => videoPacket(t), 10, 11.5, 1 / 24),
    queuedAudio: packetRun((t) => audioPacket(t), 10, 11.5, 0.02),
  });
  // play() never settles: the window under test.
  f.player.play = vi.fn(() => new Promise<void>(() => {}));
  f.player.videoRenderer.queueFrame = vi.fn();
  let onFrame: (frame: any) => void = () => {};
  f.player.wireVideoDecoder({
    setOnFrame: (cb: any) => (onFrame = cb),
    setOnError: vi.fn(),
    setOnRecovering: vi.fn(),
    setBindings: vi.fn(),
    setPlaybackRate: vi.fn(),
  });
  await f.tick();
  return { f, onFrame: (frame: any) => onFrame(frame) };
}

const frame = () => ({ timestamp: 10_500_000, close: vi.fn() });

describe("a resume out of buffering", () => {
  it("keeps the frames that land while play() is still in flight", async () => {
    const { f, onFrame } = await resumeInFlight();
    expect(f.player.stateManager.getState()).toBe("paused");
    const fr = frame();
    onFrame(fr);
    expect(f.player.videoRenderer.queueFrame).toHaveBeenCalledWith(fr);
    expect(fr.close).not.toHaveBeenCalled();
  }, 20_000);

  it("stops keeping them once the viewer pauses on top of it", async () => {
    const { f, onFrame } = await resumeInFlight();
    f.player.stateManager.setState("paused");
    f.player.pause();
    const fr = frame();
    onFrame(fr);
    expect(f.player.videoRenderer.queueFrame).not.toHaveBeenCalled();
    expect(fr.close).toHaveBeenCalled();
  }, 20_000);

  it("does not open the queue for a plain pause", async () => {
    const f = await makePipelinePlayer({ rendererQueue: 1 });
    f.player.videoRenderer.queueFrame = vi.fn();
    let onFrame: (frame: any) => void = () => {};
    f.player.wireVideoDecoder({
      setOnFrame: (cb: any) => (onFrame = cb),
      setOnError: vi.fn(),
      setOnRecovering: vi.fn(),
      setBindings: vi.fn(),
      setPlaybackRate: vi.fn(),
    });
    f.player.stateManager.setState("paused");
    const fr = frame();
    onFrame(fr);
    expect(fr.close).toHaveBeenCalled();
  }, 20_000);
});

describe("the spinner a seek's own buffering must not show", () => {
  it("is un-suppressed only when the resume gate lets go of that buffering", async () => {
    const f = await makePipelinePlayer({
      state: "buffering",
      rendererQueue: 1,
      audioBuffered: 0.5,
      reads: packetRun((t) => videoPacket(t), 100, 130, 1 / 24),
      queuedVideo: packetRun((t) => videoPacket(t), 10, 10.3, 1 / 24),
      queuedAudio: packetRun((t) => audioPacket(t), 10, 13, 0.02),
    });
    f.player.play = vi.fn(() => new Promise<void>(() => {}));
    f.player.suppressSeekSpinner = true;
    await f.tick(); // video holds 0.3s: still short, still buffering
    expect(f.player.stateManager.getState()).toBe("buffering");
    expect(f.player.suppressSeekSpinner).toBe(true);

    for (const p of packetRun((t) => videoPacket(t), 10.3, 11.5, 1 / 24)) f.player.videoQueue.push(p);
    await f.tick();
    expect(f.player.stateManager.getState()).toBe("paused");
    expect(f.player.suppressSeekSpinner).toBe(false);
  }, 20_000);
});
