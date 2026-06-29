import type { AudioTrack } from "../types";
import type { PCMFrame } from "./SoftwareAudioDecoder";

const FFMPEG_AUDIO_CODEC_IDS: Record<string, number> = {
  ac3: 86019,
  dts: 86020,
  dca: 86020,
  mlp: 86045,
  eac3: 86056,
  ec3: 86056,
  truehd: 86060,
  opus: 86076,
};

type WorkerResponse =
  | {
      type: "configured";
      requestId: number;
      generation: number;
      trackId: number;
      success: boolean;
      error?: string;
      queueDepth?: number;
      inFlight?: number;
    }
  | {
      type: "frame";
      requestId: number;
      generation: number;
      trackId: number;
      pts: number;
      timeBase: number;
      frame: PCMFrame;
      queueDepth?: number;
      inFlight?: number;
    }
  | {
      type: "decoded";
      requestId: number;
      generation: number;
      trackId: number;
      queueDepth?: number;
      inFlight?: number;
    }
  | {
      type: "error";
      requestId?: number;
      generation?: number;
      trackId?: number;
      error: string;
      queueDepth?: number;
      inFlight?: number;
    };

type PendingRequest = {
  generation: number;
  trackId: number;
  resolve: (value: boolean) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface AudioWorkerStats {
  generation: number;
  trackId: number;
  queueDepth: number;
  inFlight: number;
  reorderBacklog: number;
  droppedStaleMessages: number;
  configureState: "idle" | "configuring" | "configured" | "failed";
  configureMs: number;
  configureTimeoutMs: number;
  lastError: string;
}

export class WorkerSoftwareAudioDecoder {
  private static readonly CONFIGURE_TIMEOUT_MS = 120_000;
  private worker: Worker;
  private onData: ((frame: PCMFrame) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private configured = false;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private _downmix = true;
  private generation = 1;
  private trackId = -1;
  private queueDepth = 0;
  private inFlight = 0;
  private nextFrameRequestId = 0;
  private pendingFrames = new Map<number, PCMFrame[]>();
  private completedFrameRequests = new Set<number>();
  private droppedStaleMessages = 0;
  private configureState: AudioWorkerStats["configureState"] = "idle";
  private configureStartedAt = 0;
  private configureMs = 0;
  private lastError = "";
  private readonly timeBase = 1;
  private readonly cancelGeneration = WorkerSoftwareAudioDecoder.createCancelGeneration();

  static isSupported(): boolean {
    return typeof Worker !== "undefined";
  }

  constructor() {
    this.worker = new Worker(
      new URL("./SoftwareAudioDecoder.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event) => {
      const error = this.formatWorkerError(event);
      this.rejectAll(error);
      if (this.onError) this.onError(error);
    };
    this.worker.onmessageerror = (event) => {
      const error = new Error(
        `Audio worker message error: ${event.type || "messageerror"}`,
      );
      this.rejectAll(error);
      if (this.onError) this.onError(error);
    };
  }

  setDownmix(downmix: boolean): void {
    this._downmix = downmix;
    this.worker.postMessage({
      type: "setDownmix",
      generation: this.generation,
      trackId: this.trackId,
      downmix,
    });
  }

  setOnData(callback: (frame: PCMFrame) => void): void {
    this.onData = callback;
  }

  setOnError(callback: (error: Error) => void): void {
    this.onError = callback;
  }

  configure(track: AudioTrack): Promise<boolean> {
    this.trackId = track.id;
    const codecId = this.resolveCodecId(track);
    if (!codecId) {
      this.configured = false;
      this.configureState = "failed";
      this.configureMs = 0;
      this.lastError = `Missing codecId for ${track.codec}`;
      return Promise.resolve(false);
    }

    const requestId = this.nextRequestId++;
    const generation = this.generation;
    this.publishCancelGeneration(generation);
    this.configured = false;
    this.configureState = "configuring";
    this.configureStartedAt = this.now();
    this.configureMs = 0;
    this.lastError = "";
    const extradata = track.extradata
      ? new Uint8Array(track.extradata)
      : undefined;
    const transfer = extradata ? [extradata.buffer] : [];

    return new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        this.configureState = "failed";
        this.configureMs = this.elapsedConfigureMs();
        this.lastError = "Audio worker configure timed out";
        reject(
          new Error(
            `${this.lastError} after ${Math.round(this.configureMs)}ms`,
          ),
        );
      }, WorkerSoftwareAudioDecoder.CONFIGURE_TIMEOUT_MS);

      this.pending.set(requestId, {
        generation,
        trackId: track.id,
        resolve,
        reject,
        timeout,
      });
      this.worker.postMessage(
        {
          type: "configure",
          requestId,
          generation,
          trackId: track.id,
          track: { ...track, codecId, extradata: undefined },
          extradata,
          downmix: this._downmix,
          controlBuffer: this.cancelGeneration?.buffer,
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
    const requestId = this.nextRequestId++;
    if (this.nextFrameRequestId === 0) {
      this.nextFrameRequestId = requestId;
    }
    this.queueDepth++;
    this.inFlight++;
    this.worker.postMessage(
      {
        type: "decode",
        requestId,
        generation: this.generation,
        trackId: this.trackId,
        data: packet,
        pts: timestamp,
        timeBase: this.timeBase,
        keyframe,
      },
      [packet.buffer],
    );
  }

  async flush(): Promise<void> {
    this.generation++;
    this.publishCancelGeneration(this.generation);
    this.queueDepth = 0;
    this.inFlight = 0;
    this.clearFrameReorder();
    this.worker.postMessage({
      type: "reset",
      generation: this.generation,
      trackId: this.trackId,
    });
  }

  reset(): void {
    this.generation++;
    this.publishCancelGeneration(this.generation);
    this.queueDepth = 0;
    this.inFlight = 0;
    this.clearFrameReorder();
    this.worker.postMessage({
      type: "reset",
      generation: this.generation,
      trackId: this.trackId,
    });
  }

  close(): void {
    this.configured = false;
    this.rejectAll(new Error("Audio worker closed"));
    try {
      this.worker.postMessage({
        type: "close",
        generation: this.generation,
        trackId: this.trackId,
      });
    } catch {
      // ignore
    }
    this.worker.terminate();
  }

  get queueSize(): number {
    return Math.max(this.queueDepth, this.inFlight);
  }

  getStats(): AudioWorkerStats {
    return {
      generation: this.generation,
      trackId: this.trackId,
      queueDepth: this.queueDepth,
      inFlight: this.inFlight,
      reorderBacklog: this.getReorderBacklog(),
      droppedStaleMessages: this.droppedStaleMessages,
      configureState: this.configureState,
      configureMs: Math.round(
        this.configureState === "configuring"
          ? this.elapsedConfigureMs()
          : this.configureMs,
      ),
      configureTimeoutMs: WorkerSoftwareAudioDecoder.CONFIGURE_TIMEOUT_MS,
      lastError: this.lastError,
    };
  }

  private handleMessage(message: WorkerResponse): void {
    if (
      "generation" in message &&
      (message.generation !== this.generation || message.trackId !== this.trackId)
    ) {
      this.droppedStaleMessages++;
      return;
    }

    this.updateQueueStats(message.queueDepth, message.inFlight);

    if (message.type === "frame") {
      this.storeFrame(message.requestId, message.frame);
      this.drainCompletedFrames();
      return;
    }

    if (message.type === "decoded") {
      this.markRequestComplete(message.requestId);
      this.markFrameRequestComplete(message.requestId);
      return;
    }

    if (message.type === "error") {
      this.lastError = message.error;
      const error = new Error(message.error);
      if (message.requestId !== undefined) {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.reject(error);
          this.pending.delete(message.requestId);
          this.configureState = "failed";
          this.configureMs = this.elapsedConfigureMs();
        }
        this.markRequestComplete(message.requestId);
        this.markFrameRequestComplete(message.requestId);
        return;
      }
      if (this.configureState === "configuring") {
        this.rejectAll(error);
      }
      if (this.onError) this.onError(error);
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    this.configured = message.success;
    this.configureMs = this.elapsedConfigureMs();
    this.configureState = message.success ? "configured" : "failed";
    this.lastError = message.error ?? "";
    if (message.success) {
      this.clearFrameReorder();
    }
    pending.resolve(message.success);
  }

  private updateQueueStats(queueDepth?: number, inFlight?: number): void {
    if (queueDepth !== undefined) this.queueDepth = queueDepth;
    if (inFlight !== undefined) this.inFlight = inFlight;
  }

  private markRequestComplete(_requestId: number): void {
    this.queueDepth = Math.max(0, this.queueDepth - 1);
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private storeFrame(requestId: number, frame: PCMFrame): void {
    const frames = this.pendingFrames.get(requestId);
    if (frames) {
      frames.push(frame);
    } else {
      this.pendingFrames.set(requestId, [frame]);
    }
  }

  private markFrameRequestComplete(requestId: number): void {
    this.completedFrameRequests.add(requestId);
    if (this.nextFrameRequestId === 0) {
      this.nextFrameRequestId = requestId;
    }
    this.drainCompletedFrames();
  }

  private drainCompletedFrames(): void {
    while (
      this.nextFrameRequestId !== 0 &&
      this.completedFrameRequests.has(this.nextFrameRequestId)
    ) {
      const frames = this.pendingFrames.get(this.nextFrameRequestId) ?? [];
      for (const frame of frames) {
        if (this.onData) this.onData(frame);
      }
      this.pendingFrames.delete(this.nextFrameRequestId);
      this.completedFrameRequests.delete(this.nextFrameRequestId);
      this.nextFrameRequestId++;
    }
  }

  private clearFrameReorder(): void {
    this.nextFrameRequestId = 0;
    this.pendingFrames.clear();
    this.completedFrameRequests.clear();
  }

  private getReorderBacklog(): number {
    let backlog = 0;
    for (const frames of this.pendingFrames.values()) {
      backlog += frames.length;
    }
    return backlog;
  }

  private resolveCodecId(track: AudioTrack): number | null {
    if (typeof track.codecId === "number" && track.codecId > 0) {
      return track.codecId;
    }

    return FFMPEG_AUDIO_CODEC_IDS[(track.codec || "").toLowerCase()] ?? null;
  }

  private static createCancelGeneration(): Int32Array | null {
    if (typeof SharedArrayBuffer === "undefined") return null;
    return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  }

  private publishCancelGeneration(generation: number): void {
    if (!this.cancelGeneration) return;
    Atomics.store(this.cancelGeneration, 0, generation);
  }

  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  private elapsedConfigureMs(): number {
    return this.configureStartedAt > 0 ? this.now() - this.configureStartedAt : 0;
  }

  private formatWorkerError(event: ErrorEvent): Error {
    const parts = [event.message || "Audio worker error"];
    if (event.filename) parts.push(`at ${event.filename}`);
    if (event.lineno || event.colno) {
      parts.push(`line ${event.lineno || 0}:${event.colno || 0}`);
    }
    if (event.error instanceof Error) {
      if (event.error.message && event.error.message !== event.message) {
        parts.push(event.error.message);
      }
      if (event.error.stack) parts.push(event.error.stack);
    }
    return new Error(parts.filter(Boolean).join(" | "));
  }

  private rejectAll(error: Error): void {
    this.lastError = error.message;
    if (this.configureState === "configuring") {
      this.configureState = "failed";
      this.configureMs = this.elapsedConfigureMs();
    }
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}
