import { afterEach, describe, expect, it, vi } from "vitest";
import { hasWasm } from "../helpers/wasm-available";
import type { AudioTrack } from "../../src/types";
import type { WasmBindings } from "../../src/wasm/bindings";

/**
 * Real end-to-end circuit-breaker test for the WORKER audio path (A2 x A5).
 *
 * A2 took upstream's setOnBroken()/isDisabled() breaker; A5 made the worker the
 * primary software-decode path for EVERY codec (AAC included). The breaker only
 * ever existed in the main-thread SoftwareAudioDecoder, so this test exists to
 * prove the worker has one too — and to prove it by RUNNING it, not by handing
 * the main thread a `{type:"broken"}` message someone typed out.
 *
 * What is real here:
 *  - `src/decode/SoftwareAudioDecoder.worker.ts` is imported and executed
 *    unmodified; its own `scope.onmessage` handler processes every message.
 *  - `loadWasmModuleNew()` loads the real Emscripten FFmpeg build
 *    (`dist/wasm/movi.js`) and `_movi_audio_decoder_create` builds a real
 *    libavcodec decoder.
 *  - Every failure is a real `avcodec_send_packet` returning AVERROR_INVALIDDATA
 *    (-1094995529) for real garbage bytes — the exact error seen in the wild.
 *    Nothing forces the return value.
 *  - `WorkerSoftwareAudioDecoder` and `MoviAudioDecoder` are the real classes,
 *    driven only by messages the worker actually posted.
 *
 * The ONLY substitution is the message TRANSPORT: Node has neither
 * `DedicatedWorkerGlobalScope` nor `Worker`, so `self` and `Worker` are bridged
 * to each other in-process. That is the "external dependency that is genuinely
 * unavailable" exception (PLAN_MERGE 5.1); no logic under test is replaced.
 */

// AV_CODEC_ID_AAC. A5 routes AAC through the worker for the first time.
const AAC_CODEC_ID = 86018;
// AVERROR_INVALIDDATA — what libavcodec really returns for the packets below.
const AVERROR_INVALIDDATA = -1094995529;

const aacTrack: AudioTrack = {
  id: 1,
  type: "audio",
  codec: "aac",
  codecId: AAC_CODEC_ID,
  channels: 2,
  sampleRate: 48_000,
};

type PostedMessage = { type: string; [key: string]: unknown };

/**
 * Stands in for `DedicatedWorkerGlobalScope` inside the worker module and for
 * `Worker` on the main thread, wiring the two directly together. Delivery is
 * deferred through a microtask so the worker never runs re-entrantly inside a
 * `postMessage` call, matching a real worker's queue.
 */
class WorkerBridge {
  static current: WorkerBridge | null = null;

  /** Set by the worker module when it assigns `self.onmessage`. */
  workerOnMessage: ((event: MessageEvent) => void) | null = null;
  /** Set by WorkerSoftwareAudioDecoder when it assigns `worker.onmessage`. */
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  /** Everything the worker posted out, in order. */
  posted: PostedMessage[] = [];
  terminated = false;

  private scopeListeners = new Map<string, ((event: unknown) => void)[]>();

  /** The object the worker module sees as `self`. */
  readonly scope = {
    postMessage: (message: PostedMessage) => {
      this.posted.push(message);
      queueMicrotask(() => {
        this.onmessage?.({ data: message } as MessageEvent);
      });
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      const list = this.scopeListeners.get(type) ?? [];
      list.push(fn);
      this.scopeListeners.set(type, list);
    },
    removeEventListener: () => {},
    close: () => {
      this.terminated = true;
    },
    set onmessage(fn: ((event: MessageEvent) => void) | null) {
      WorkerBridge.current!.workerOnMessage = fn;
    },
    get onmessage() {
      return WorkerBridge.current!.workerOnMessage;
    },
  };

  constructor() {
    WorkerBridge.current = this;
  }

  /** Main thread -> worker. */
  postMessage(message: PostedMessage): void {
    queueMicrotask(() => {
      this.workerOnMessage?.({ data: message } as MessageEvent);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  count(type: string): number {
    return this.posted.filter((message) => message.type === type).length;
  }

  errors(): string[] {
    return this.posted
      .filter((message) => message.type === "error")
      .map((message) => String(message.error));
  }
}

/**
 * Let every queued microtask (and any I/O the WASM loader needs) run to
 * completion, so the worker has fully drained its inbox before we assert.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Bytes no AAC decoder can parse — the source of the real INVALIDDATA. */
function garbagePacket(seed: number): Uint8Array {
  const packet = new Uint8Array(96);
  for (let i = 0; i < packet.length; i++) {
    packet[i] = (i * 31 + seed * 17 + 7) & 0xff;
  }
  return packet;
}

/**
 * Boot the real worker module against a fresh bridge. `vi.resetModules()` gives
 * each test its own module instance, so the worker's `consecutiveFailures` /
 * `isBroken` module state never leaks between tests.
 */
async function bootWorker(): Promise<WorkerBridge> {
  vi.resetModules();
  const bridge = new WorkerBridge();
  vi.stubGlobal("self", bridge.scope);
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        return bridge as unknown as Worker;
      }
    },
  );
  await import("../../src/decode/SoftwareAudioDecoder.worker.ts");
  return bridge;
}

function makeBindings(): WasmBindings {
  return {
    enableDecoder: vi.fn(() => 0),
    enableAudioDownmix: vi.fn(),
    flushDecoder: vi.fn(),
    sendPacket: vi.fn(() => 0),
    receiveFrame: vi.fn(() => -1),
  } as unknown as WasmBindings;
}

afterEach(() => {
  vi.unstubAllGlobals();
  WorkerBridge.current = null;
});

describe.skipIf(!hasWasm)("SoftwareAudioDecoder.worker: real circuit-breaker over real FFmpeg", () => {
  it("really trips after 50 consecutive libavcodec failures and stops calling WASM", async () => {
    const bridge = await bootWorker();
    const { WorkerSoftwareAudioDecoder } = await import(
      "../../src/decode/WorkerSoftwareAudioDecoder"
    );

    const decoder = new WorkerSoftwareAudioDecoder();
    const onBroken = vi.fn();
    decoder.setOnBroken(onBroken);

    await expect(decoder.configure(aacTrack)).resolves.toBe(true);
    expect(decoder.isDisabled()).toBe(false);

    // 49 real decodes: real avcodec_send_packet, real AVERROR_INVALIDDATA.
    for (let i = 0; i < 49; i++) {
      decoder.decode(garbagePacket(i), i * 0.021, true);
    }
    await settle();

    expect(bridge.errors()).toHaveLength(49);
    expect(bridge.errors()[0]).toBe(
      `sendPacket failed: ${AVERROR_INVALIDDATA}`,
    );
    // One short of the threshold — still trying, still not broken.
    expect(bridge.count("broken")).toBe(0);
    expect(onBroken).not.toHaveBeenCalled();
    expect(decoder.isDisabled()).toBe(false);

    // The 50th consecutive real failure is the one that trips it.
    decoder.decode(garbagePacket(49), 49 * 0.021, true);
    await settle();

    expect(bridge.errors()).toHaveLength(50);
    expect(bridge.count("broken")).toBe(1);
    expect(onBroken).toHaveBeenCalledOnce();
    expect(decoder.isDisabled()).toBe(true);

    // Broken means broken: further packets must not reach libavcodec at all,
    // so no new "error" is produced — but the request is still accounted for
    // ("decoded") or queueDepth would climb forever.
    const decodedBefore = bridge.count("decoded");
    for (let i = 50; i < 60; i++) {
      decoder.decode(garbagePacket(i), i * 0.021, true);
    }
    await settle();

    expect(bridge.errors()).toHaveLength(50);
    expect(bridge.count("broken")).toBe(1);
    expect(bridge.count("decoded")).toBe(decodedBefore + 10);
    expect(decoder.getStats().queueDepth).toBe(0);
    expect(decoder.getStats().inFlight).toBe(0);

    decoder.close();
  }, 60_000);

  it("resets the real breaker on flush so a re-aligned stream decodes again", async () => {
    const bridge = await bootWorker();
    const { WorkerSoftwareAudioDecoder } = await import(
      "../../src/decode/WorkerSoftwareAudioDecoder"
    );

    const decoder = new WorkerSoftwareAudioDecoder();
    decoder.setOnBroken(() => {});
    await expect(decoder.configure(aacTrack)).resolves.toBe(true);

    for (let i = 0; i < 50; i++) {
      decoder.decode(garbagePacket(i), i * 0.021, true);
    }
    await settle();
    expect(decoder.isDisabled()).toBe(true);
    expect(bridge.errors()).toHaveLength(50);

    // flush() is the re-align a "broken" report asks the owner to perform.
    await decoder.flush();
    await settle();
    expect(decoder.isDisabled()).toBe(false);

    // Packets reach libavcodec again — proven by real new failures appearing.
    for (let i = 0; i < 3; i++) {
      decoder.decode(garbagePacket(200 + i), 10 + i * 0.021, true);
    }
    await settle();

    expect(bridge.errors()).toHaveLength(53);
    expect(bridge.count("broken")).toBe(1);

    decoder.close();
  }, 60_000);

  it("builds a real AAC decoder in the worker when demuxed metadata omits codecId", async () => {
    // A5 routes AAC through the worker for the first time. The codec-id
    // fallback map predates A5 and only listed the codecs the fork used to
    // send off-thread (ac3/dts/flac/truehd/mlp/opus), so a track that reaches
    // the decoder without `codecId` — anything not built straight off the
    // demuxer's stream info — silently fell back to the main thread for
    // exactly the codec A5 exists to move. The assertions below are real:
    // configure() only resolves true once `_movi_audio_decoder_create`
    // actually returned a decoder for AV_CODEC_ID_AAC, and the errors are
    // real libavcodec rejections from that decoder.
    const bridge = await bootWorker();
    const { WorkerSoftwareAudioDecoder } = await import(
      "../../src/decode/WorkerSoftwareAudioDecoder"
    );

    const decoder = new WorkerSoftwareAudioDecoder();
    await expect(
      decoder.configure({ ...aacTrack, codecId: undefined }),
    ).resolves.toBe(true);

    const configure = bridge.posted.find(
      (message) => message.type === "configured",
    );
    expect(configure).toMatchObject({ success: true });

    decoder.decode(garbagePacket(1), 0.02, true);
    await settle();
    expect(bridge.errors()).toEqual([
      `sendPacket failed: ${AVERROR_INVALIDDATA}`,
    ]);

    decoder.close();
  }, 60_000);

  it("carries a real worker trip up to MoviAudioDecoder's onBroken and rebuilds the decoder", async () => {
    const bridge = await bootWorker();
    const { MoviAudioDecoder } = await import("../../src/decode/AudioDecoder");

    const player = new MoviAudioDecoder();
    player.setBindings(makeBindings());
    const onBroken = vi.fn();
    player.setOnBroken(onBroken);

    await expect(player.configure(aacTrack)).resolves.toBe(true);
    expect(player.getStats().decoderType).toBe("Software (FFmpeg Worker)");

    for (let i = 0; i < 50; i++) {
      player.decode(garbagePacket(i), i * 0.021, true);
    }
    await settle();

    expect(bridge.count("broken")).toBe(1);
    expect(onBroken).toHaveBeenCalledOnce();

    player.close();
  }, 60_000);
});
