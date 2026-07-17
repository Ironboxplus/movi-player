import { afterEach, describe, expect, it, vi } from "vitest";
import { MoviAudioDecoder } from "../../src/decode/AudioDecoder";
import { WorkerSoftwareAudioDecoder } from "../../src/decode/WorkerSoftwareAudioDecoder";
import {
  SoftwareAudioDecoder,
  type PCMFrame,
} from "../../src/decode/SoftwareAudioDecoder";
import type { AudioTrack } from "../../src/types";
import type { WasmBindings } from "../../src/wasm/bindings";

vi.mock("dashjs", () => ({
  MediaPlayer: vi.fn(),
}));

vi.mock("shaka-player/dist/shaka-player.compiled", () => ({
  default: {
    Player: {
      isBrowserSupported: vi.fn(() => false),
    },
    polyfill: {
      installAll: vi.fn(),
    },
    net: {
      NetworkingEngine: {
        RequestType: {
          LICENSE: 1,
        },
      },
    },
  },
}));

const dtsTrack: AudioTrack = {
  id: 7,
  type: "audio",
  codec: "dts",
  codecId: 86020,
  channels: 6,
  sampleRate: 48_000,
};

function makeBindings() {
  const calls = {
    enableDecoder: 0,
    enableAudioDownmix: 0,
    flushDecoder: 0,
  };
  const bindings = {
    enableDecoder: vi.fn(() => {
      calls.enableDecoder++;
      return 0;
    }),
    enableAudioDownmix: vi.fn(() => {
      calls.enableAudioDownmix++;
    }),
    flushDecoder: vi.fn(() => {
      calls.flushDecoder++;
    }),
    sendPacket: vi.fn(() => 0),
    receiveFrame: vi.fn(() => -1),
  } as unknown as WasmBindings;

  return { bindings, calls };
}

function makeFrame(timestamp = 1): PCMFrame {
  return {
    planes: [new Float32Array([0])],
    numberOfFrames: 1,
    numberOfChannels: 1,
    sampleRate: 48_000,
    timestamp,
  };
}

class FakeWorker {
  static instances: FakeWorker[] = [];

  messages: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  emitError(event: Partial<ErrorEvent>): void {
    this.onerror?.(event as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.useRealTimers();
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

describe("MoviAudioDecoder software scheduling", () => {
  it("reports DTS software audio as software path for scheduler decisions", async () => {
    const { bindings } = makeBindings();
    const decoder = new MoviAudioDecoder();
    decoder.setBindings(bindings);

    await expect(decoder.configure(dtsTrack)).resolves.toBe(true);

    expect(decoder.isSoftware).toBe(true);
    expect(decoder.getStats()).toMatchObject({
      decoderType: "Software (FFmpeg)",
      queueSize: 0,
    });
  });

  it("propagates flush and reset into the software audio decoder", async () => {
    const { bindings, calls } = makeBindings();
    const decoder = new MoviAudioDecoder();
    decoder.setBindings(bindings);

    await expect(decoder.configure(dtsTrack)).resolves.toBe(true);
    await decoder.flush();
    decoder.reset();

    expect(calls.flushDecoder).toBe(2);
  });

  it("passes configure extradata into the main-thread software decoder", async () => {
    vi.stubGlobal("Worker", undefined);
    const { bindings } = makeBindings();
    const decoder = new MoviAudioDecoder();
    decoder.setBindings(bindings);
    const extradata = new Uint8Array([9, 8, 7]);

    await expect(decoder.configure(dtsTrack, extradata)).resolves.toBe(true);

    expect(bindings.enableDecoder).toHaveBeenCalledWith(
      dtsTrack.id,
      extradata,
    );
  });
});

describe("SoftwareAudioDecoder PCM timestamps", () => {
  it("advances PCM time when one DTS packet produces multiple decoded frames", async () => {
    const heap = new Uint8Array(512 * Float32Array.BYTES_PER_ELEMENT);
    const bindings = {
      enableDecoder: vi.fn(() => 0),
      enableAudioDownmix: vi.fn(),
      flushDecoder: vi.fn(),
      sendPacket: vi.fn(() => 0),
      receiveFrame: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValue(-1),
      getFrameSamples: vi.fn(() => 512),
      getFrameChannels: vi.fn(() => 1),
      getFrameSampleRate: vi.fn(() => 48_000),
      getFrameDataPointer: vi.fn(() => 0),
      module: { HEAPU8: heap },
    } as unknown as WasmBindings;
    const decoder = new SoftwareAudioDecoder(bindings);
    const frames: PCMFrame[] = [];
    decoder.setOnData((frame) => frames.push(frame));

    await expect(decoder.configure(dtsTrack)).resolves.toBe(true);
    decoder.decode(new Uint8Array([1]), 0, true);

    expect(frames.map((frame) => frame.timestamp)).toEqual([0, 32_000]);
  });
});

describe("MoviPlayer scheduler classification", () => {
  it("treats hardware video plus software audio as a software-heavy path", async () => {
    const { getDecodeMode, isSoftwareDecodePath } = await import(
      "../../src/core/decodeMode"
    );

    expect(
      isSoftwareDecodePath({ isSoftware: false }, { isSoftware: true }),
    ).toBe(true);
    expect(getDecodeMode({ isSoftware: false }, { isSoftware: true })).toEqual({
      videoSoftware: false,
      audioSoftware: true,
      softwareHeavy: true,
    });
  });
});

describe("WorkerSoftwareAudioDecoder protocol", () => {
  it("keeps the worker path during a slow cold start instead of falling back after 15s", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const { bindings } = makeBindings();
    const decoder = new MoviAudioDecoder();
    decoder.setBindings(bindings);

    const configured = decoder.configure(dtsTrack);
    await Promise.resolve();

    expect(decoder.getStats()).toMatchObject({
      decoderType: "Software (FFmpeg Worker)",
      worker: {
        configureState: "configuring",
        configureTimeoutMs: 120_000,
      },
    });

    await vi.advanceTimersByTimeAsync(15_000);

    expect(bindings.enableDecoder).not.toHaveBeenCalled();
    expect(decoder.getStats()).toMatchObject({
      decoderType: "Software (FFmpeg Worker)",
      worker: {
        configureState: "configuring",
      },
    });

    FakeWorker.instances[0]!.emit({
      type: "configured",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
      success: true,
      queueDepth: 0,
      inFlight: 0,
    });

    await expect(configured).resolves.toBe(true);
    expect(decoder.getStats()).toMatchObject({
      decoderType: "Software (FFmpeg Worker)",
      worker: {
        configureState: "configured",
      },
    });
  });

  it("uses a DTS codec-id fallback when demuxed track metadata omits codecId", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { bindings } = makeBindings();
    const decoder = new MoviAudioDecoder();
    decoder.setBindings(bindings);
    const trackWithoutCodecId = { ...dtsTrack, codecId: undefined };

    const configured = decoder.configure(trackWithoutCodecId);
    await Promise.resolve();

    const worker = FakeWorker.instances[0]!;
    const configureMessage = worker.messages.find(
      (message) => (message as { type?: string }).type === "configure",
    );
    expect(configureMessage).toMatchObject({
      type: "configure",
      track: {
        codec: "dts",
        codecId: 86020,
      },
    });

    worker.emit({
      type: "configured",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
      success: true,
      queueDepth: 0,
      inFlight: 0,
    });

    await expect(configured).resolves.toBe(true);
    expect(decoder.getStats().decoderType).toBe("Software (FFmpeg Worker)");
  });

  it.each([
    ["ac3", 86019],
    ["eac3", 86056],
    ["flac", 86028],
    ["truehd", 86060],
    ["mlp", 86045],
    ["opus", 86076],
  ])(
    "uses an FFmpeg codec-id fallback for %s when demuxed metadata omits codecId",
    async (codec, codecId) => {
      vi.stubGlobal("Worker", FakeWorker);
      const { bindings } = makeBindings();
      const decoder = new MoviAudioDecoder();
      decoder.setBindings(bindings);
      const trackWithoutCodecId: AudioTrack = {
        ...dtsTrack,
        codec,
        codecId: undefined,
      };

      const configured = decoder.configure(trackWithoutCodecId);
      await Promise.resolve();

      const worker = FakeWorker.instances[0]!;
      const configureMessage = worker.messages.find(
        (message) => (message as { type?: string }).type === "configure",
      );
      expect(configureMessage).toMatchObject({
        type: "configure",
        track: {
          codec,
          codecId,
        },
      });

      worker.emit({
        type: "configured",
        requestId: 1,
        generation: 1,
        trackId: dtsTrack.id,
        success: true,
        queueDepth: 0,
        inFlight: 0,
      });

      await expect(configured).resolves.toBe(true);
      expect(decoder.getStats().decoderType).toBe("Software (FFmpeg Worker)");
    },
  );

  it("keeps worker startup error details when falling back to the main thread", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { bindings } = makeBindings();
    const decoder = new MoviAudioDecoder();
    decoder.setBindings(bindings);

    const configured = decoder.configure(dtsTrack);
    await Promise.resolve();

    FakeWorker.instances[0]!.emitError({
      message: "Uncaught ReferenceError: exports is not defined",
      filename: "https://example.invalid/assets/SoftwareAudioDecoder.worker.js",
      lineno: 123,
      colno: 45,
      error: new Error("exports is not defined"),
    });

    await expect(configured).resolves.toBe(true);
    expect(decoder.getStats()).toMatchObject({
      decoderType: "Software (FFmpeg)",
      softwareFallbackReason: expect.stringContaining(
        "exports is not defined",
      ),
    });
    expect(decoder.getStats().softwareFallbackReason).toContain(
      "SoftwareAudioDecoder.worker.js",
    );
    expect(decoder.getStats().softwareFallbackReason).toContain("123:45");
  });

  it("posts generation-aware worker messages and exposes backpressure stats", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareAudioDecoder();

    const configured = decoder.configure(dtsTrack);
    const worker = FakeWorker.instances[0]!;

    expect(worker.messages[0]).toMatchObject({
      type: "configure",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
    });

    worker.emit({
      type: "configured",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
      success: true,
      queueDepth: 0,
      inFlight: 0,
    });
    await expect(configured).resolves.toBe(true);

    decoder.decode(new Uint8Array([1, 2, 3]), 12.5, true);

    expect(worker.messages[1]).toMatchObject({
      type: "decode",
      requestId: 2,
      generation: 1,
      trackId: dtsTrack.id,
      pts: 12.5,
      timeBase: 1,
    });
    expect(decoder.queueSize).toBe(1);
    expect(decoder.getStats()).toMatchObject({
      generation: 1,
      trackId: dtsTrack.id,
      queueDepth: 1,
      inFlight: 1,
      reorderBacklog: 0,
      droppedStaleMessages: 0,
    });
  });

  it("shares a cancel generation with the worker so queued old decodes can skip WASM after flush", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareAudioDecoder();

    const configured = decoder.configure(dtsTrack);
    const worker = FakeWorker.instances[0]!;
    const configureMessage = worker.messages[0] as {
      controlBuffer?: SharedArrayBuffer;
    };

    expect(configureMessage.controlBuffer).toBeInstanceOf(SharedArrayBuffer);
    const control = new Int32Array(configureMessage.controlBuffer!);
    expect(Atomics.load(control, 0)).toBe(1);

    worker.emit({
      type: "configured",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
      success: true,
      queueDepth: 0,
      inFlight: 0,
    });
    await configured;

    decoder.decode(new Uint8Array([1]), 1, true);
    expect(worker.messages[1]).toMatchObject({
      type: "decode",
      requestId: 2,
      generation: 1,
    });

    await decoder.flush();

    expect(Atomics.load(control, 0)).toBe(2);
    expect(worker.messages[2]).toMatchObject({
      type: "reset",
      generation: 2,
    });
  });

  it("does not surface per-packet worker decode errors as fatal player errors", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareAudioDecoder();
    const onError = vi.fn();
    decoder.setOnError(onError);

    const configured = decoder.configure(dtsTrack);
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      type: "configured",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
      success: true,
      queueDepth: 0,
      inFlight: 0,
    });
    await configured;

    decoder.decode(new Uint8Array([1, 2, 3]), 12.5, true);
    worker.emit({
      type: "error",
      requestId: 2,
      generation: 1,
      trackId: dtsTrack.id,
      error: "sendPacket failed: -1094995529",
      queueDepth: 1,
      inFlight: 1,
    });

    expect(onError).not.toHaveBeenCalled();
    expect(decoder.getStats()).toMatchObject({
      lastError: "sendPacket failed: -1094995529",
      queueDepth: 0,
      inFlight: 0,
    });
  });

  it("rejects pending configure immediately on worker-level protocol errors", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareAudioDecoder();
    const onError = vi.fn();
    decoder.setOnError(onError);

    const configured = decoder.configure(dtsTrack);
    await Promise.resolve();

    FakeWorker.instances[0]!.emit({
      type: "error",
      generation: 1,
      trackId: dtsTrack.id,
      error: "Worker unhandled rejection | wasm init failed",
      queueDepth: 0,
      inFlight: 0,
    });

    await expect(configured).rejects.toThrow("wasm init failed");
    expect(onError).toHaveBeenCalledOnce();
    expect(decoder.getStats()).toMatchObject({
      configureState: "failed",
      lastError: "Worker unhandled rejection | wasm init failed",
    });
  });

  it("passes configure extradata into the worker software decoder", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { bindings } = makeBindings();
    const decoder = new MoviAudioDecoder();
    decoder.setBindings(bindings);
    const extradata = new Uint8Array([1, 2, 3, 4]);

    const configured = decoder.configure(dtsTrack, extradata);
    const worker = FakeWorker.instances[0]!;
    await Promise.resolve();
    const configureMessage = worker.messages.find(
      (message) => (message as { type?: string }).type === "configure",
    );
    expect(
      worker.messages.filter(
        (message) => (message as { type?: string }).type === "configure",
      ),
    ).toHaveLength(1);

    expect(configureMessage).toMatchObject({
      type: "configure",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
    });
    expect(Array.from((configureMessage as { extradata: Uint8Array }).extradata))
      .toEqual([1, 2, 3, 4]);

    worker.emit({
      type: "configured",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
      success: true,
      queueDepth: 0,
      inFlight: 0,
    });

    await expect(configured).resolves.toBe(true);
  });

  it("drops stale frames from an older generation after flush", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareAudioDecoder();
    const frames: PCMFrame[] = [];
    decoder.setOnData((frame) => frames.push(frame));

    const configured = decoder.configure(dtsTrack);
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      type: "configured",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
      success: true,
      queueDepth: 0,
      inFlight: 0,
    });
    await configured;

    decoder.decode(new Uint8Array([1]), 1, true);
    await decoder.flush();

    worker.emit({
      type: "frame",
      requestId: 2,
      generation: 1,
      trackId: dtsTrack.id,
      pts: 1,
      timeBase: 1,
      frame: makeFrame(),
      queueDepth: 9,
      inFlight: 9,
    });

    expect(frames).toHaveLength(0);
    expect(decoder.getStats()).toMatchObject({
      queueDepth: 0,
      inFlight: 0,
      droppedStaleMessages: 1,
    });
    expect(worker.messages[2]).toMatchObject({
      type: "reset",
      generation: 2,
      trackId: dtsTrack.id,
    });
  });

  it("emits worker PCM frames in decode request order", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareAudioDecoder();
    const frames: PCMFrame[] = [];
    decoder.setOnData((frame) => frames.push(frame));

    const configured = decoder.configure(dtsTrack);
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      type: "configured",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
      success: true,
      queueDepth: 0,
      inFlight: 0,
    });
    await configured;

    decoder.decode(new Uint8Array([1]), 1, true);
    decoder.decode(new Uint8Array([2]), 2, true);

    worker.emit({
      type: "frame",
      requestId: 3,
      generation: 1,
      trackId: dtsTrack.id,
      pts: 2,
      timeBase: 1,
      frame: makeFrame(2),
      queueDepth: 2,
      inFlight: 2,
    });
    worker.emit({
      type: "decoded",
      requestId: 3,
      generation: 1,
      trackId: dtsTrack.id,
      queueDepth: 1,
      inFlight: 1,
    });

    expect(frames).toHaveLength(0);
    expect(decoder.getStats().reorderBacklog).toBe(1);

    worker.emit({
      type: "frame",
      requestId: 2,
      generation: 1,
      trackId: dtsTrack.id,
      pts: 1,
      timeBase: 1,
      frame: makeFrame(1),
      queueDepth: 1,
      inFlight: 1,
    });
    worker.emit({
      type: "decoded",
      requestId: 2,
      generation: 1,
      trackId: dtsTrack.id,
      queueDepth: 0,
      inFlight: 0,
    });

    expect(frames.map((frame) => frame.timestamp)).toEqual([1, 2]);
    expect(decoder.getStats().reorderBacklog).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Merge reconciliation guards (upstream 0.3.5 ← our DTS-worker fork)
//
// These lock the two hand-resolved conflict points where a merge mistake would
// be silent: (1) SoftwareAudioDecoder.flush()/reset() is the UNION of our
// WASM-flush-in-reset and upstream's queue+circuit-breaker clear; (2) keeping
// our off-thread worker must not disable upstream's cold-prime, which gates on
// usesSoftware === true.
// ---------------------------------------------------------------------------

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as unknown as ReturnType<typeof vi.fn>;
}

describe("merge: SoftwareAudioDecoder flush/reset reconciliation", () => {
  it("reset() flushes the WASM decoder once configured (our flush-in-reset survives)", async () => {
    const { bindings, calls } = makeBindings();
    const dec = new SoftwareAudioDecoder(bindings);

    await dec.configure(dtsTrack);
    dec.reset();

    // Upstream's reset() only cleared the JS-side queue; ours must also emit
    // avcodec_flush_buffers so a post-seek run doesn't reject every packet
    // against stale TrueHD/DTS codec state.
    expect(calls.flushDecoder).toBe(1);
    expect(bindings.flushDecoder).toHaveBeenLastCalledWith(dtsTrack.id);
  });

  it("flush() flushes the WASM decoder once configured", async () => {
    const { bindings, calls } = makeBindings();
    const dec = new SoftwareAudioDecoder(bindings);

    await dec.configure(dtsTrack);
    await dec.flush();

    expect(calls.flushDecoder).toBe(1);
    expect(bindings.flushDecoder).toHaveBeenLastCalledWith(dtsTrack.id);
  });

  it("never flushes the WASM decoder before configuration (no flushDecoder(-1))", async () => {
    const { bindings, calls } = makeBindings();
    const dec = new SoftwareAudioDecoder(bindings);

    // trackIndex is still -1 here — the guard must suppress the flush so we
    // never hand FFmpeg a bogus stream index.
    await dec.flush();
    dec.reset();

    expect(calls.flushDecoder).toBe(0);
    expect(bindings.flushDecoder).not.toHaveBeenCalled();
  });

  it("flush() clears the failure circuit-breaker so decoding resumes after a seek", async () => {
    const { bindings } = makeBindings();
    const dec = new SoftwareAudioDecoder(bindings);
    await dec.configure(dtsTrack);

    // Trip the breaker: 50 consecutive sendPacket failures mute the decoder.
    mockFn(bindings.sendPacket).mockReturnValue(-1);
    const pkt = new Uint8Array([1]);
    for (let i = 0; i < 50; i++) dec.decode(pkt, i, true);

    // Broken → decode() short-circuits before ever touching sendPacket.
    mockFn(bindings.sendPacket).mockClear();
    dec.decode(pkt, 50, true);
    expect(bindings.sendPacket).not.toHaveBeenCalled();

    // Our flush() clears isBroken (and flushes WASM) so the next run decodes
    // again — upstream relied on this recovery for post-seek replay.
    mockFn(bindings.sendPacket).mockReturnValue(0);
    await dec.flush();
    dec.decode(pkt, 51, true);
    expect(bindings.sendPacket).toHaveBeenCalledTimes(1);
  });
});

describe("merge: worker-decoded DTS still engages cold-prime", () => {
  it("reports usesSoftware === true and the worker decoderType so prime engages", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const { bindings } = makeBindings();
    const decoder = new MoviAudioDecoder();
    decoder.setBindings(bindings);

    const configured = decoder.configure(dtsTrack);
    await Promise.resolve();

    FakeWorker.instances[0]!.emit({
      type: "configured",
      requestId: 1,
      generation: 1,
      trackId: dtsTrack.id,
      success: true,
      queueDepth: 0,
      inFlight: 0,
    });
    await expect(configured).resolves.toBe(true);

    // MoviPlayer.activeAudioNeedsColdPrime() gates on usesSoftware — the
    // off-thread worker MUST report software so keeping it doesn't silently
    // disable upstream's DTS/TrueHD cold-prime mitigation.
    expect(decoder.usesSoftware).toBe(true);
    expect(decoder.isSoftware).toBe(true);
    expect(decoder.getStats()).toMatchObject({
      decoderType: "Software (FFmpeg Worker)",
      isSoftware: true,
    });
    // ...yet decode ran in the worker: the main-thread WASM decoder is untouched.
    expect(bindings.enableDecoder).not.toHaveBeenCalled();
  });
});
