import type { AudioTrack } from "../types";
import type { PCMFrame } from "./SoftwareAudioDecoder";

/**
 * Fallback AV_CODEC_ID values for tracks that reach us without the demuxer's
 * `codecId` (split-audio entries, adapter-built renditions, the native/MSE
 * fallback's track list). Only codecs the standalone WASM audio decoder can
 * actually open belong here: `resolveCodecId()` returning null is how a codec
 * the worker cannot build (vorbis, alac — no decoder in the build) hands off to
 * the main-thread SoftwareAudioDecoder, which decodes through the demuxer's own
 * stream index instead. Listing one here that `_movi_audio_decoder_create`
 * rejects would turn that clean hand-off into a failed configure.
 *
 * mp2/mp3/aac were added with A5: before it, only the codecs below them went
 * off-thread, so the map never needed them. A5 sends EVERY codec to the worker,
 * and without an entry AAC — the most common track of all — fell back to the
 * main thread whenever `codecId` was absent, which is the one thing A5 exists
 * to stop.
 */
const FFMPEG_AUDIO_CODEC_IDS: Record<string, number> = {
  mp2: 86016,
  mp3: 86017,
  aac: 86018,
  ac3: 86019,
  dts: 86020,
  dca: 86020,
  flac: 86028,
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
      wasmLoadMs?: number;
      workerAgeMs?: number;
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
    }
  | {
      type: "broken";
      generation: number;
      trackId: number;
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
  /** How long the worker spent loading its own WASM instance for the last configure. */
  wasmLoadMs?: number;
  /** Worker age when it first handled the configure: script fetch and start-up. */
  workerAgeMs?: number;
  configureTimeoutMs: number;
  lastError: string;
}

export class WorkerSoftwareAudioDecoder {
  private static readonly CONFIGURE_TIMEOUT_MS = 120_000;
  private worker: Worker;
  private onData: ((frame: PCMFrame) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private onBroken: (() => void) | null = null;
  private brokenFlag = false;
  private configured = false;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private _downmix = true;
  private _failFast = false;
  private generation = 1;
  private trackId = -1;
  private queueDepth = 0;
  private inFlight = 0;
  private nextFrameRequestId = 0;
  private pendingFrames = new Map<number, PCMFrame[]>();
  private completedFrameRequests = new Set<number>();
  private droppedStaleMessages = 0;
  private configureState: AudioWorkerStats["configureState"] = "idle";
  private configureCount = 0;
  private configureStartedAt = 0;
  private configureMs = 0;
  private wasmLoadMs: number | undefined;
  private workerAgeMs: number | undefined;
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

  /** Declare broken on the first failure; mirrors SoftwareAudioDecoder.setFailFast. */
  setFailFast(on: boolean): void {
    this._failFast = on;
    this.worker.postMessage({ type: "setFailFast", failFast: on });
  }

  setOnData(callback: (frame: PCMFrame) => void): void {
    this.onData = callback;
  }

  setOnError(callback: (error: Error) => void): void {
    this.onError = callback;
  }

  /**
   * Fires once when the worker's consecutive-failure circuit-breaker trips
   * (see MAX_CONSECUTIVE_FAILURES in SoftwareAudioDecoder.worker.ts). Same
   * contract as SoftwareAudioDecoder.setOnBroken() — the two decoders are
   * interchangeable behind AudioDecoder.ts's configureSoftwareDecoder(), so
   * they must expose the same recovery hook regardless of which one a given
   * codec/browser ends up using.
   */
  setOnBroken(callback: () => void): void {
    this.onBroken = callback;
  }

  /** Whether the worker's circuit-breaker has tripped (no packets decoding). */
  isDisabled(): boolean {
    return this.brokenFlag;
  }

  /**
   * May be called again on the same instance to move the worker to another
   * track. The worker is the expensive part (a 14MB script that embeds the
   * decoder, seconds to start), so a track switch keeps it and only bumps the
   * generation: output still in flight for the previous track arrives with the
   * old generation and is dropped by handleMessage, and the cancel buffer
   * (shared with the worker) makes it stop decoding that track's packets.
   */
  configure(track: AudioTrack): Promise<boolean> {
    if (this.configureCount++ > 0) {
      this.rejectAll(new Error("Audio worker reconfigured"));
      this.generation++;
      this.publishCancelGeneration(this.generation);
      this.queueDepth = 0;
      this.inFlight = 0;
      this.clearFrameReorder();
    }
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
    // A fresh configure (including handleSoftwareBroken's revert-and-retry)
    // deserves a clean slate rather than staying muted from a prior track.
    this.brokenFlag = false;
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
          failFast: this._failFast,
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
    // Mirrors the worker's own breaker reset on "reset" below: flush is the
    // re-align a "broken" caller was asked to do, so it clears the flag here
    // too rather than waiting for the worker's (generation-gated) response.
    this.brokenFlag = false;
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
    this.brokenFlag = false;
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
      wasmLoadMs: this.wasmLoadMs,
      workerAgeMs: this.workerAgeMs,
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

    if (message.type === "broken") {
      this.brokenFlag = true;
      this.onBroken?.();
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
    this.wasmLoadMs = message.wasmLoadMs;
    this.workerAgeMs = message.workerAgeMs;
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
