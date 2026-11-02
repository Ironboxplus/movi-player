import { afterEach, describe, expect, it, vi } from "vitest";
import { hasWasm } from "../helpers/wasm-available";
import { waitForReply } from "../helpers/worker-bridge-wait";
import type { AudioTrack } from "../../src/types";

/**
 * A5/A5b generation gating for `src/decode/SoftwareAudioDecoder.worker.ts`,
 * over the REAL worker module (same self/Worker in-process bridge as
 * audio-worker-circuit-breaker.test.ts — the one documented PLAN_MERGE §5.1
 * transport exception). Team lead flagged this as the suspect for the
 * black-box 6/7-sample clock-runaway symptom: if a track switch or seek's
 * OLD generation's decode output is not dropped, stale PCM lands on the
 * timeline after the new generation has already started, and the audio
 * clock (which is master, per Clock.ts) jumps.
 *
 * Two DIFFERENT gates exist in the real source, and both are exercised for
 * real rather than assumed equivalent:
 *  - `decode` uses `isStale()` — generation must match EXACTLY (a decode
 *    queued under a generation the worker has since moved past OR one that
 *    somehow arrived early is dropped either way).
 *  - `flush`/`reset` use `isOlderGeneration()` — only a STRICTLY OLDER
 *    generation is dropped; the same or a newer generation is allowed
 *    through and advances the worker's own generation counter. This is not
 *    the same predicate as decode's, on purpose: a flush/reset for the
 *    generation the worker is about to configure into (racing ahead of the
 *    "configure" message) must still land, or the re-align it exists to
 *    perform never happens.
 */

const AAC_CODEC_ID = 86018;
const aacTrack: AudioTrack = {
  id: 1,
  type: "audio",
  codec: "aac",
  codecId: AAC_CODEC_ID,
  channels: 2,
  sampleRate: 48_000,
};

type PostedMessage = { type: string; [key: string]: unknown };

class WorkerBridge {
  static current: WorkerBridge | null = null;

  workerOnMessage: ((event: MessageEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  posted: PostedMessage[] = [];

  readonly scope = {
    postMessage: (message: PostedMessage) => {
      this.posted.push(message);
      queueMicrotask(() => {
        this.onmessage?.({ data: message } as MessageEvent);
      });
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
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

  postMessage(message: PostedMessage): void {
    queueMicrotask(() => {
      this.workerOnMessage?.({ data: message } as MessageEvent);
    });
  }

  terminate(): void {}

  count(type: string): number {
    return this.posted.filter((message) => message.type === type).length;
  }
}

function garbagePacket(seed: number): Uint8Array {
  const packet = new Uint8Array(96);
  for (let i = 0; i < packet.length; i++) {
    packet[i] = (i * 31 + seed * 17 + 7) & 0xff;
  }
  return packet;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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

let requestId = 0;
function configureMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "configure" as const,
    requestId: requestId++,
    generation: 1,
    trackId: 5,
    track: aacTrack,
    downmix: true,
    ...overrides,
  };
}

/** Send a configure and wait for ITS reply (see waitForReply for why not settle()). */
async function configureAndWait(
  bridge: WorkerBridge,
  message: ReturnType<typeof configureMessage>,
) {
  bridge.postMessage(message);
  await waitForReply(bridge, "configured", message.requestId);
}

function decodeMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "decode" as const,
    requestId: requestId++,
    generation: 1,
    trackId: 5,
    data: garbagePacket(requestId),
    pts: 0,
    timeBase: 1_000_000,
    keyframe: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  WorkerBridge.current = null;
});

describe.skipIf(!hasWasm)("SoftwareAudioDecoder.worker: decode generation gating (isStale — exact match)", () => {
  it("drops a decode carrying a generation the worker has already moved past", async () => {
    const bridge = await bootWorker();
    await configureAndWait(bridge, configureMessage({ generation: 1 }));

    // Track switch / seek: worker moves on to generation 2.
    await configureAndWait(bridge, configureMessage({ generation: 2, requestId: 999 }));

    const postedBefore = bridge.posted.length;
    // A decode still labeled generation 1 — e.g. one queued on the main
    // thread before the switch was known — must produce nothing at all:
    // not an "error", not a "decoded" ack, no PCM reaching the clock.
    bridge.postMessage(decodeMessage({ generation: 1 }));
    await settle();

    expect(bridge.posted.length).toBe(postedBefore);
  }, 30_000);

  it("still processes a decode for the CURRENT generation after the same switch", async () => {
    const bridge = await bootWorker();
    await configureAndWait(bridge, configureMessage({ generation: 1 }));
    await configureAndWait(bridge, configureMessage({ generation: 2, requestId: 999 }));

    bridge.postMessage(decodeMessage({ generation: 2 }));
    await settle();

    // Real AAC decoder genuinely rejects this garbage packet.
    expect(bridge.count("error")).toBe(1);
    expect(bridge.count("decoded")).toBe(1);
  }, 30_000);

  it("also drops a decode carrying a generation NEWER than the worker's current one (not just older)", async () => {
    // isStale() is an exact-match check, not "generation < current" — a
    // decode that somehow arrived tagged for a generation the worker hasn't
    // configured into yet is just as wrong to process as a stale one.
    const bridge = await bootWorker();
    await configureAndWait(bridge, configureMessage({ generation: 1 }));

    const postedBefore = bridge.posted.length;
    bridge.postMessage(decodeMessage({ generation: 5 }));
    await settle();

    expect(bridge.posted.length).toBe(postedBefore);
  }, 30_000);
});

describe.skipIf(!hasWasm)("SoftwareAudioDecoder.worker: flush/reset generation gating (isOlderGeneration — strictly-less-than)", () => {
  it("drops a flush for a strictly older generation, without regressing the worker's own generation", async () => {
    const bridge = await bootWorker();
    await configureAndWait(bridge, configureMessage({ generation: 3 }));

    // A dropped flush posts nothing on its own — that alone isn't enough to
    // prove it was REJECTED rather than applied (a successful flush doesn't
    // post anything either). The real, observable side effect is whether it
    // overwrote the worker's `generation` variable: if this older flush were
    // wrongly applied, generation would regress to 2, and a decode honestly
    // labeled generation 3 (the worker's real current state) would then look
    // like it came from the FUTURE and get dropped as stale too.
    bridge.postMessage({ type: "flush", generation: 2, trackId: 5 });
    await settle();

    bridge.postMessage(decodeMessage({ generation: 3 }));
    await settle();

    expect(bridge.count("error")).toBe(1); // real AAC decoder rejects garbage
    expect(bridge.count("decoded")).toBe(1);
  }, 30_000);

  it("applies a flush for the SAME generation, unlike decode's exact-match gate", async () => {
    const bridge = await bootWorker();
    await configureAndWait(bridge, configureMessage({ generation: 3 }));

    // Prove it actually ran (not just "didn't crash"): trip the circuit
    // breaker with real failures, then confirm the same-generation flush
    // clears it — flush's own documented job.
    for (let i = 0; i < 50; i++) {
      bridge.postMessage(decodeMessage({ generation: 3, requestId: 1000 + i }));
    }
    await settle();
    expect(bridge.count("broken")).toBe(1);

    bridge.postMessage({ type: "flush", generation: 3, trackId: 5 });
    await settle();

    // Breaker cleared: a fresh decode at the same generation produces a new
    // real failure again instead of being silently swallowed as "broken".
    const errorsBefore = bridge.count("error");
    bridge.postMessage(decodeMessage({ generation: 3, requestId: 2000 }));
    await settle();
    expect(bridge.count("error")).toBe(errorsBefore + 1);
  }, 30_000);

  it("applies a flush for a NEWER generation, advancing the worker's own counter", async () => {
    // This is the asymmetry with decode's gate: a flush/reset racing AHEAD
    // of its matching "configure" (e.g. arrives first on the message queue)
    // must still land, or the re-align it performs never happens.
    const bridge = await bootWorker();
    await configureAndWait(bridge, configureMessage({ generation: 1 }));

    bridge.postMessage({ type: "reset", generation: 4, trackId: 5 });
    await settle();

    // The worker's generation is now 4 — proven by a decode at generation 4
    // no longer being treated as stale.
    const postedBefore = bridge.posted.length;
    bridge.postMessage(decodeMessage({ generation: 4 }));
    await settle();
    expect(bridge.posted.length).toBeGreaterThan(postedBefore);
  }, 30_000);
});
