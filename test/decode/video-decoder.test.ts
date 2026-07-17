import { afterEach, describe, expect, it, vi } from "vitest";
import { MoviVideoDecoder } from "../../src/decode/VideoDecoder";
import type { VideoTrack } from "../../src/types";
import type { WasmBindings } from "../../src/wasm/bindings";

const mpeg2Track: VideoTrack = {
  id: 0,
  type: "video",
  codec: "mpeg2video",
  codecId: 2,
  width: 1920,
  height: 1080,
  frameRate: 23.976,
  bitRate: 0,
  profile: 4,
  level: 4,
  pixelFormat: "yuv420p",
};

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: unknown[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {}
}

afterEach(() => {
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

describe("MoviVideoDecoder software fallback", () => {
  it("uses FFmpeg WASM when a codec has no WebCodecs mapping", async () => {
    vi.stubGlobal("window", { VideoDecoder: class {} });

    const bindings = {
      enableDecoder: vi.fn(() => 0),
      setSkipFrame: vi.fn(),
    } as unknown as WasmBindings;
    const decoder = new MoviVideoDecoder();
    decoder.setBindings(bindings);

    await expect(decoder.configure(mpeg2Track)).resolves.toBe(true);

    expect(bindings.enableDecoder).toHaveBeenCalledWith(mpeg2Track.id);
    expect(bindings.setSkipFrame).toHaveBeenCalledWith(mpeg2Track.id, 0);
    expect(decoder.isSoftware).toBe(true);
    expect(decoder.getStats().decoderType).toBe("Software (FFmpeg)");
  });

  it("prefers an isolated Worker for FFmpeg software video decoding", async () => {
    vi.stubGlobal("window", { VideoDecoder: class {} });
    vi.stubGlobal("Worker", FakeWorker);

    const bindings = {
      enableDecoder: vi.fn(() => 0),
      setSkipFrame: vi.fn(),
    } as unknown as WasmBindings;
    const decoder = new MoviVideoDecoder();
    decoder.setBindings(bindings);

    const configurePromise = decoder.configure(mpeg2Track);

    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0];
    const configureMessage = worker.messages[0] as {
      requestId: number;
      generation: number;
      trackId: number;
    };
    expect(configureMessage).toMatchObject({
      type: "configure",
      codecId: mpeg2Track.codecId,
      width: mpeg2Track.width,
      height: mpeg2Track.height,
    });

    worker.onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "configured",
          requestId: configureMessage.requestId,
          generation: configureMessage.generation,
          trackId: configureMessage.trackId,
          success: true,
        },
      }),
    );

    await expect(configurePromise).resolves.toBe(true);
    expect(bindings.enableDecoder).not.toHaveBeenCalled();
    expect(decoder.getStats().decoderType).toBe("Software (FFmpeg Worker)");
  });

  it("falls back to the legacy main-thread decoder if Worker configure fails", async () => {
    vi.stubGlobal("window", { VideoDecoder: class {} });
    vi.stubGlobal("Worker", FakeWorker);
    const bindings = {
      enableDecoder: vi.fn(() => 0),
      setSkipFrame: vi.fn(),
    } as unknown as WasmBindings;
    const decoder = new MoviVideoDecoder();
    decoder.setBindings(bindings);

    const configurePromise = decoder.configure(mpeg2Track);
    const worker = FakeWorker.instances[0];
    const request = worker.messages[0] as any;
    worker.onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "configured",
          requestId: request.requestId,
          generation: request.generation,
          trackId: request.trackId,
          success: false,
          error: "worker unavailable",
        },
      }),
    );

    await expect(configurePromise).resolves.toBe(true);
    expect(bindings.enableDecoder).toHaveBeenCalledWith(mpeg2Track.id);
    expect(decoder.getStats().decoderType).toBe("Software (FFmpeg)");
  });
});
