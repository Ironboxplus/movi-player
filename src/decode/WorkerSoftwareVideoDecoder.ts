import type { VideoTrack } from "../types";

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
      frame: VideoFrame;
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

type PendingConfigure = {
  generation: number;
  trackId: number;
  resolve: (value: boolean) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface VideoWorkerStats {
  generation: number;
  trackId: number;
  queueDepth: number;
  inFlight: number;
  droppedStaleMessages: number;
  configureState: "idle" | "configuring" | "configured" | "failed";
  configureMs: number;
  configureTimeoutMs: number;
  lastError: string;
}

export class WorkerSoftwareVideoDecoder {
  private static readonly CONFIGURE_TIMEOUT_MS = 120_000;

  private readonly worker: Worker;
  private readonly cancelGeneration =
    WorkerSoftwareVideoDecoder.createCancelGeneration();
  private onFrame: ((frame: VideoFrame) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private pending = new Map<number, PendingConfigure>();
  private pendingDecodes = new Set<number>();
  private nextRequestId = 1;
  private generation = 1;
  private trackId = -1;
  private queueDepth = 0;
  private inFlight = 0;
  private isConfigured = false;
  private droppedStaleMessages = 0;
  private configureState: VideoWorkerStats["configureState"] = "idle";
  private configureStartedAt = 0;
  private configureMs = 0;
  private lastError = "";

  static isSupported(): boolean {
    return typeof Worker !== "undefined";
  }

  constructor() {
    this.worker = new Worker(
      new URL("./SoftwareVideoDecoder.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event) => {
      const error = this.formatWorkerError(event);
      this.handleWorkerFailure(error);
    };
    this.worker.onmessageerror = (event) => {
      const error = new Error(
        `Video worker message error: ${event.type || "messageerror"}`,
      );
      this.handleWorkerFailure(error);
    };
  }

  setOnFrame(callback: (frame: VideoFrame) => void): void {
    this.onFrame = callback;
  }

  setOnError(callback: (error: Error) => void): void {
    this.onError = callback;
  }

  configure(track: VideoTrack, targetFps: number = 0): Promise<boolean> {
    if (!track.codecId || track.codecId <= 0) {
      this.configureState = "failed";
      this.lastError = `Missing codecId for ${track.codec}`;
      return Promise.resolve(false);
    }

    if (this.pending.size > 0) {
      this.generation++;
      this.publishCancelGeneration(this.generation);
      this.rejectAll(new Error("Video worker configure superseded"));
    }

    this.trackId = track.id;
    this.isConfigured = false;
    this.configureState = "configuring";
    this.configureStartedAt = this.now();
    this.configureMs = 0;
    this.lastError = "";
    const requestId = this.nextRequestId++;
    const generation = this.generation;
    this.publishCancelGeneration(generation);
    const extradata = track.extradata
      ? new Uint8Array(track.extradata)
      : undefined;
    const transfer = extradata ? [extradata.buffer] : [];

    return new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        this.configureState = "failed";
        this.configureMs = this.elapsedConfigureMs();
        this.lastError = "Video worker configure timed out";
        reject(
          new Error(`${this.lastError} after ${Math.round(this.configureMs)}ms`),
        );
      }, WorkerSoftwareVideoDecoder.CONFIGURE_TIMEOUT_MS);

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
          codecId: track.codecId,
          codec: track.codec,
          width: track.width,
          height: track.height,
          frameRate: track.frameRate,
          targetFps,
          extradata,
          controlBuffer: this.cancelGeneration?.buffer,
        },
        transfer,
      );
    });
  }

  decode(
    data: Uint8Array,
    timestamp: number,
    dts: number,
    keyframe: boolean,
  ): void {
    if (!this.isConfigured) return;

    const packet = data.slice();
    const requestId = this.nextRequestId++;
    this.pendingDecodes.add(requestId);
    this.updateDecodeBacklog();
    try {
      this.worker.postMessage(
        {
          type: "decode",
          requestId,
          generation: this.generation,
          trackId: this.trackId,
          data: packet,
          pts: timestamp,
          dts,
          keyframe,
        },
        [packet.buffer],
      );
    } catch (error) {
      this.pendingDecodes.delete(requestId);
      this.updateDecodeBacklog();
      const workerError =
        error instanceof Error ? error : new Error(String(error));
      this.lastError = workerError.message;
      this.onError?.(workerError);
    }
  }

  async flush(): Promise<void> {
    this.reset();
  }

  reset(): void {
    this.generation++;
    this.publishCancelGeneration(this.generation);
    this.rejectAll(new Error("Video worker configure cancelled by reset"));
    this.pendingDecodes.clear();
    this.updateDecodeBacklog();
    this.worker.postMessage({
      type: "reset",
      generation: this.generation,
      trackId: this.trackId,
    });
  }

  close(): void {
    this.generation++;
    this.publishCancelGeneration(this.generation);
    this.isConfigured = false;
    this.rejectAll(new Error("Video worker closed"));
    this.pendingDecodes.clear();
    this.updateDecodeBacklog();
    try {
      this.worker.postMessage({
        type: "close",
        generation: this.generation,
        trackId: this.trackId,
      });
    } catch {
      // The worker may already be gone.
    }
    this.worker.terminate();
    this.onFrame = null;
    this.onError = null;
  }

  get configured(): boolean {
    return this.isConfigured;
  }

  get queueSize(): number {
    return Math.max(this.queueDepth, this.inFlight);
  }

  getStats(): VideoWorkerStats {
    return {
      generation: this.generation,
      trackId: this.trackId,
      queueDepth: this.queueDepth,
      inFlight: this.inFlight,
      droppedStaleMessages: this.droppedStaleMessages,
      configureState: this.configureState,
      configureMs: Math.round(
        this.configureState === "configuring"
          ? this.elapsedConfigureMs()
          : this.configureMs,
      ),
      configureTimeoutMs: WorkerSoftwareVideoDecoder.CONFIGURE_TIMEOUT_MS,
      lastError: this.lastError,
    };
  }

  private handleMessage(message: WorkerResponse): void {
    if (
      "generation" in message &&
      (message.generation !== this.generation || message.trackId !== this.trackId)
    ) {
      if (message.type === "frame") message.frame.close();
      this.droppedStaleMessages++;
      return;
    }

    if (message.type === "frame") {
      if (this.onFrame) this.onFrame(message.frame);
      else message.frame.close();
      return;
    }

    if (message.type === "decoded") {
      this.pendingDecodes.delete(message.requestId);
      this.updateDecodeBacklog();
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
          return;
        }
      }
      this.onError?.(error);
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    this.isConfigured = message.success;
    this.configureMs = this.elapsedConfigureMs();
    this.configureState = message.success ? "configured" : "failed";
    this.lastError = message.error ?? "";
    pending.resolve(message.success);
  }

  private static createCancelGeneration(): Int32Array | null {
    if (typeof SharedArrayBuffer === "undefined") return null;
    return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  }

  private publishCancelGeneration(generation: number): void {
    if (this.cancelGeneration) Atomics.store(this.cancelGeneration, 0, generation);
  }

  private updateDecodeBacklog(): void {
    const size = this.pendingDecodes.size;
    this.queueDepth = size;
    this.inFlight = size;
  }

  private handleWorkerFailure(error: Error): void {
    this.isConfigured = false;
    this.pendingDecodes.clear();
    this.updateDecodeBacklog();
    this.rejectAll(error);
    this.onError?.(error);
  }

  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  private elapsedConfigureMs(): number {
    return this.configureStartedAt > 0 ? this.now() - this.configureStartedAt : 0;
  }

  private formatWorkerError(event: ErrorEvent): Error {
    const parts = [event.message || "Video worker error"];
    if (event.filename) parts.push(`at ${event.filename}`);
    if (event.lineno || event.colno) {
      parts.push(`line ${event.lineno || 0}:${event.colno || 0}`);
    }
    if (event.error instanceof Error && event.error.stack) {
      parts.push(event.error.stack);
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
