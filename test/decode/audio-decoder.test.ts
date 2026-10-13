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

describe("merge: A5 circuit-breaker must cover the worker path too (A2 x A5)", () => {
  // A2 took upstream's setOnBroken()/isDisabled() circuit-breaker so a
  // decoder that goes permanently silent can be reported and recovered
  // instead of staying muted for the rest of playback. A5 made the worker
  // path (WorkerSoftwareAudioDecoder) primary for every codec. Before this
  // fix, the breaker only existed in the main-thread SoftwareAudioDecoder
  // (SoftwareAudioDecoder.worker.ts had no failure counting at all), so any
  // AAC/DTS/etc. stream that hit 50 consecutive worker decode failures never
  // told the player — audio just went silent forever. These tests exercise
  // the real worker message protocol (FakeWorker simulates only the
  // postMessage transport, matching every other test in this file — the
  // actual decode/circuit-breaker logic under test lives in
  // SoftwareAudioDecoder.worker.ts and runs unmodified) up through
  // WorkerSoftwareAudioDecoder to MoviAudioDecoder's public setOnBroken.

  it("WorkerSoftwareAudioDecoder: trips isDisabled() and fires onBroken when the worker reports 'broken'", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareAudioDecoder();
    const onBroken = vi.fn();
    decoder.setOnBroken(onBroken);

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

    expect(decoder.isDisabled()).toBe(false);

    worker.emit({
      type: "broken",
      generation: 1,
      trackId: dtsTrack.id,
      queueDepth: 0,
      inFlight: 0,
    });

    expect(onBroken).toHaveBeenCalledOnce();
    expect(decoder.isDisabled()).toBe(true);
  });

  it("WorkerSoftwareAudioDecoder: ignores a 'broken' message from a stale generation", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareAudioDecoder();
    const onBroken = vi.fn();
    decoder.setOnBroken(onBroken);

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

    // A "broken" report for an already-superseded generation (e.g. the
    // worker's in-flight decode raced a flush/seek) must be dropped like any
    // other stale message, not mute a decoder that has already moved on.
    worker.emit({
      type: "broken",
      generation: 0,
      trackId: dtsTrack.id,
      queueDepth: 0,
      inFlight: 0,
    });

    expect(onBroken).not.toHaveBeenCalled();
    expect(decoder.isDisabled()).toBe(false);
  });

  it("WorkerSoftwareAudioDecoder: flush() clears isDisabled() so decoding can resume after a re-align", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareAudioDecoder();
    decoder.setOnBroken(() => {});

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

    worker.emit({
      type: "broken",
      generation: 1,
      trackId: dtsTrack.id,
      queueDepth: 0,
      inFlight: 0,
    });
    expect(decoder.isDisabled()).toBe(true);

    await decoder.flush();
    expect(decoder.isDisabled()).toBe(false);
  });

  it("MoviAudioDecoder: propagates a worker circuit-breaker trip to the public setOnBroken hook", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { bindings } = makeBindings();
    const decoder = new MoviAudioDecoder();
    decoder.setBindings(bindings);
    const onBroken = vi.fn();
    decoder.setOnBroken(onBroken);

    const configured = decoder.configure(dtsTrack);
    await Promise.resolve();
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
    await expect(configured).resolves.toBe(true);

    // Real worker protocol: the worker posts "broken" once its own
    // MAX_CONSECUTIVE_FAILURES trips (SoftwareAudioDecoder.worker.ts). This
    // decoder never produced a frame, so handleSoftwareBroken() should also
    // tear it down and build a fresh one (bounded by MAX_SW_REVERTS).
    worker.emit({
      type: "broken",
      generation: 1,
      trackId: dtsTrack.id,
      queueDepth: 0,
      inFlight: 0,
    });

    expect(onBroken).toHaveBeenCalledOnce();
    // handleSoftwareBroken's revert closed the old worker and asked
    // createSoftwareDecoder() for a fresh one — a second FakeWorker instance
    // should have been constructed.
    expect(FakeWorker.instances.length).toBe(2);
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

describe("WorkerSoftwareAudioDecoder spare worker", () => {
  afterEach(() => {
    MoviAudioDecoder.discardWarmWorker();
  });

  it("hands the worker started ahead of need to the next decoder instead of spawning", () => {
    vi.stubGlobal("Worker", FakeWorker);
    MoviAudioDecoder.prewarmWorker();
    MoviAudioDecoder.prewarmWorker();
    expect(FakeWorker.instances).toHaveLength(1);

    const first = new WorkerSoftwareAudioDecoder();
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].onmessage).not.toBeNull();

    // The spare is spent: the next decoder starts its own.
    const second = new WorkerSoftwareAudioDecoder();
    expect(FakeWorker.instances).toHaveLength(2);
    first.close();
    second.close();
  });

  it("spawns on demand when nothing was started ahead", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareAudioDecoder();
    expect(FakeWorker.instances).toHaveLength(1);
    decoder.close();
  });

  it("terminates an unused spare when it is discarded", () => {
    vi.stubGlobal("Worker", FakeWorker);
    MoviAudioDecoder.prewarmWorker();
    MoviAudioDecoder.discardWarmWorker();
    expect(FakeWorker.instances[0].terminated).toBe(true);
    new WorkerSoftwareAudioDecoder().close();
    expect(FakeWorker.instances).toHaveLength(2);
  });
});
