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

// ---------------------------------------------------------------------------
// V1: WHY the CPU is decoding, not just THAT it is.
//
// The fork's element used to raise the blocking "Try Software Decoding" overlay
// whenever isSoftwareDecoding() was true, and carried a hand-rolled branch to
// suppress it again after an automatic fallback had already succeeded (the
// `automatic-software-fallback-source` test guarded that branch). Upstream
// replaces the suppression with a reason: only "hardware-refused" is a trade
// the viewer can weigh, because only there is there a hardware path to go back
// to. "unmapped" (Motion JPEG in an AVI, MPEG-2) has no hardware path at all,
// so prompting dead-ends a file that was already decoding.
//
// The element's gate is therefore only as good as this reason, and nothing
// covered it. Both cases run the real MoviVideoDecoder.configure(); the only
// stand-ins are WebCodecs itself (genuinely unreachable in node — see the
// window stub) and WasmBindings, whose calls are the assertions.
// ---------------------------------------------------------------------------
describe("merge: software fallback reports why the CPU is decoding", () => {
  it('reports "unmapped" when WebCodecs has no codec string for the track', async () => {
    // WebCodecs present and willing — the codec is simply not one it knows.
    vi.stubGlobal("window", { VideoDecoder: class {} });
    const bindings = {
      enableDecoder: vi.fn(() => 0),
      setSkipFrame: vi.fn(),
    } as unknown as WasmBindings;
    const decoder = new MoviVideoDecoder();
    decoder.setBindings(bindings);

    await expect(decoder.configure(mpeg2Track)).resolves.toBe(true);

    expect(decoder.isSoftware).toBe(true);
    // Not "hardware-refused": there is no hardware path for MPEG-2 here, so the
    // element must fall through to normal init rather than offering a trade.
    expect(decoder.softwareReason).toBe("unmapped");
  });

  it('reports "hardware-refused" when WebCodecs rejects a codec it does know', async () => {
    const isConfigSupported = vi.fn(async () => ({ supported: false }));
    class RefusingVideoDecoder {
      static isConfigSupported = isConfigSupported;
      constructor() {}
      configure(): void {}
      close(): void {}
    }
    vi.stubGlobal("window", { VideoDecoder: RefusingVideoDecoder });
    vi.stubGlobal("VideoDecoder", RefusingVideoDecoder);

    const bindings = {
      enableDecoder: vi.fn(() => 0),
      setSkipFrame: vi.fn(),
    } as unknown as WasmBindings;
    const decoder = new MoviVideoDecoder();
    decoder.setBindings(bindings);

    const h264Track: VideoTrack = {
      id: 3,
      type: "video",
      codec: "h264",
      codecId: 27,
      width: 1920,
      height: 1080,
      frameRate: 24,
      bitRate: 0,
      profile: 77,
      level: 40,
      pixelFormat: "yuv420p",
    };

    await expect(decoder.configure(h264Track)).resolves.toBe(true);

    expect(isConfigSupported).toHaveBeenCalled();
    expect(decoder.isSoftware).toBe(true);
    expect(decoder.softwareReason).toBe("hardware-refused");
  });
});

// ---------------------------------------------------------------------------
// Upstream's adaptive load shedding (PLAN.md Batch 5). The renderer calls
// setPerformanceSkip(true) when the device can't sustain the source frame rate;
// both decode paths then drop non-reference frames, which nothing references,
// so the stream stays decodable and the decoder does less work.
//
// This is upstream-only — there is no fork counterpart, so no adjudication row
// covers it — and the whole hardware half of it (_perfSkipNonRef, the
// `disposable` decode parameter, setPerformanceSkip itself) was lost resolving
// VideoDecoder.ts by hand. SoftwareVideoDecoder.setNonRefSkip() survived with
// nothing left calling it, and upstream's MoviPlayer.ts calls
// videoDecoder.setPerformanceSkip(true) directly.
//
// V2 keeps the fork's Worker software decoder as the primary software path, so
// the shed has to reach it too — otherwise load shedding silently does nothing
// for exactly the software playback that needs it most.
// ---------------------------------------------------------------------------
describe("merge: adaptive load shedding reaches both software paths", () => {
  it("sheds non-reference frames on the legacy main-thread software decoder", async () => {
    vi.stubGlobal("window", { VideoDecoder: class {} });
    const bindings = {
      enableDecoder: vi.fn(() => 0),
      setSkipFrame: vi.fn(),
    } as unknown as WasmBindings;
    const decoder = new MoviVideoDecoder();
    decoder.setBindings(bindings);
    await expect(decoder.configure(mpeg2Track)).resolves.toBe(true);

    decoder.setPerformanceSkip(true);
    expect(bindings.setSkipFrame).toHaveBeenCalledWith(mpeg2Track.id, 1);

    decoder.setPerformanceSkip(false);
    expect(bindings.setSkipFrame).toHaveBeenLastCalledWith(mpeg2Track.id, 0);
  });

  it("sheds non-reference frames on the Worker software decoder", async () => {
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
          success: true,
        },
      }),
    );
    await expect(configurePromise).resolves.toBe(true);

    decoder.setPerformanceSkip(true);

    expect(worker.messages).toContainEqual(
      expect.objectContaining({
        type: "setSkipFrame",
        generation: request.generation,
        trackId: request.trackId,
        enabled: true,
      }),
    );
    // The main-thread WASM decoder must stay untouched — it isn't the one
    // decoding, and setSkipFrame(-1) on an unconfigured stream is meaningless.
    expect(bindings.setSkipFrame).not.toHaveBeenCalled();
  });
});
