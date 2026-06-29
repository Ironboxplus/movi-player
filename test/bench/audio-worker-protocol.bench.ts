import { afterEach, bench, describe, vi } from "vitest";
import { WorkerSoftwareAudioDecoder } from "../../src/decode/WorkerSoftwareAudioDecoder";
import type { PCMFrame } from "../../src/decode/SoftwareAudioDecoder";
import type { AudioTrack } from "../../src/types";

const dtsTrack: AudioTrack = {
  id: 7,
  type: "audio",
  codec: "dts",
  codecId: 86020,
  channels: 6,
  sampleRate: 48_000,
};

class FakeWorker {
  static instances: FakeWorker[] = [];

  messages: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted = 0;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted++;
    if (this.messages.length === 0) {
      this.messages.push(message);
    }
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  terminate(): void {
    // no-op
  }
}

type BenchDecoder = {
  configure(track: AudioTrack): Promise<boolean>;
  decode(data: Uint8Array, timestamp: number, keyframe: boolean): void;
  close(): void;
};

class LegacyWorkerSoftwareAudioDecoder implements BenchDecoder {
  private worker: Worker;
  private configured = false;
  private nextRequestId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: boolean) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private onData: ((frame: PCMFrame) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private _downmix = true;

  constructor() {
    this.worker = new Worker(
      new URL("../../src/decode/SoftwareAudioDecoder.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "Audio worker error");
      this.rejectAll(error);
      this.onError?.(error);
    };
    this.worker.onmessageerror = () => {
      const error = new Error("Audio worker message error");
      this.rejectAll(error);
      this.onError?.(error);
    };
  }

  configure(track: AudioTrack): Promise<boolean> {
    if (!track.codecId) return Promise.resolve(false);

    const id = this.nextRequestId++;
    const extradata = track.extradata ? new Uint8Array(track.extradata) : undefined;
    const transfer = extradata ? [extradata.buffer] : [];

    return new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Audio worker configure timed out"));
      }, 15_000);

      this.pending.set(id, { resolve, reject, timeout });
      this.worker.postMessage(
        {
          type: "configure",
          id,
          track: { ...track, extradata: undefined },
          extradata,
          downmix: this._downmix,
        },
        transfer,
      );
    });
  }

  decode(data: Uint8Array, timestamp: number, keyframe: boolean): void {
    if (!this.configured) return;

    const packet =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data
        : data.slice();
    this.worker.postMessage(
      {
        type: "decode",
        data: packet,
        timestamp,
        keyframe,
      },
      [packet.buffer],
    );
  }

  close(): void {
    this.configured = false;
    this.rejectAll(new Error("Audio worker closed"));
    try {
      this.worker.postMessage({ type: "close" });
    } catch {
      // ignore
    }
    this.worker.terminate();
  }

  private handleMessage(message: {
    type: "configured" | "frame" | "error";
    id?: number;
    success?: boolean;
    frame?: PCMFrame;
    error?: string;
  }): void {
    if (message.type === "frame") {
      if (message.frame) this.onData?.(message.frame);
      return;
    }

    if (message.type === "error") {
      this.onError?.(new Error(message.error ?? "Audio worker error"));
      return;
    }

    const pending = this.pending.get(message.id ?? -1);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.id ?? -1);
    this.configured = message.success === true;
    pending.resolve(this.configured);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function configureDecoder(Decoder: new () => BenchDecoder) {
  vi.stubGlobal("Worker", FakeWorker);
  FakeWorker.instances = [];
  const decoder = new Decoder();
  const configured = decoder.configure(dtsTrack);
  const worker = FakeWorker.instances[0]!;
  const configureMessage = worker.messages[0] as
    | { requestId?: number; id?: number; generation?: number; trackId?: number }
    | undefined;
  worker.emit({
    type: "configured",
    requestId: configureMessage?.requestId ?? 1,
    id: configureMessage?.id ?? 1,
    generation: configureMessage?.generation ?? 1,
    trackId: configureMessage?.trackId ?? dtsTrack.id,
    success: true,
    queueDepth: 0,
    inFlight: 0,
  });
  await configured;
  return decoder;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audio worker protocol overhead", () => {
  bench("legacy enqueue 10000 decode requests", async () => {
    const decoder = await configureDecoder(LegacyWorkerSoftwareAudioDecoder);
    const packet = new Uint8Array([1, 2, 3, 4]);

    for (let i = 0; i < 10_000; i++) {
      decoder.decode(packet, i / 48_000, true);
    }

    decoder.close();
  });

  bench("current enqueue 10000 decode requests", async () => {
    const decoder = await configureDecoder(WorkerSoftwareAudioDecoder);
    const packet = new Uint8Array([1, 2, 3, 4]);

    for (let i = 0; i < 10_000; i++) {
      decoder.decode(packet, i / 48_000, true);
    }

    decoder.close();
  });
});
