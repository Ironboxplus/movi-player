/// <reference lib="webworker" />

import { loadWasmModuleNew } from "../wasm/FFmpegLoader";
import { packWebCodecsFrame } from "../wasm/videoFrameLayout";
import type { MoviWasmModule } from "../wasm/types";

type ConfigureRequest = {
  type: "configure";
  requestId: number;
  generation: number;
  trackId: number;
  codecId: number;
  codec: string;
  width: number;
  height: number;
  frameRate: number;
  targetFps: number;
  extradata?: Uint8Array;
  controlBuffer?: SharedArrayBuffer;
};

type DecodeRequest = {
  type: "decode";
  requestId: number;
  generation: number;
  trackId: number;
  data: Uint8Array;
  pts: number;
  dts: number;
  keyframe: boolean;
};

type WorkerRequest =
  | ConfigureRequest
  | DecodeRequest
  | { type: "reset"; generation: number; trackId: number }
  | { type: "close"; generation: number; trackId: number };

const scope = self as DedicatedWorkerGlobalScope;

let moduleRef: MoviWasmModule | null = null;
let decoderPtr = 0;
let generation = 1;
let trackId = -1;
let queueDepth = 0;
let inFlight = 0;
let targetFps = 0;
let lastProcessedTimestamp = -1;
let cancelGeneration: Int32Array | null = null;

function post(message: unknown, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function currentGeneration(): number {
  return cancelGeneration ? Atomics.load(cancelGeneration, 0) : generation;
}

function isStale(message: { generation: number; trackId: number }): boolean {
  return message.generation !== currentGeneration() || message.trackId !== trackId;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function closeDecoder(): void {
  if (moduleRef && decoderPtr) {
    moduleRef._movi_video_decoder_destroy(decoderPtr);
  }
  decoderPtr = 0;
}

function withHeapBuffer<T>(data: Uint8Array, callback: (ptr: number) => T): T {
  if (!moduleRef) throw new Error("WASM module not loaded");
  if (data.byteLength === 0) return callback(0);
  const ptr = moduleRef._malloc(data.byteLength);
  if (!ptr) throw new Error("Failed to allocate WASM input buffer");
  try {
    moduleRef.HEAPU8.set(data, ptr);
    return callback(ptr);
  } finally {
    moduleRef._free(ptr);
  }
}

async function configure(message: ConfigureRequest): Promise<void> {
  cancelGeneration = message.controlBuffer
    ? new Int32Array(message.controlBuffer)
    : null;
  generation = message.generation;
  trackId = message.trackId;
  queueDepth = 0;
  inFlight = 0;
  targetFps = message.targetFps;
  lastProcessedTimestamp = -1;
  closeDecoder();

  try {
    if (typeof VideoFrame === "undefined") {
      throw new Error("VideoFrame is unavailable in the decoder Worker");
    }
    moduleRef = moduleRef ?? (await loadWasmModuleNew());
    if (isStale(message)) return;

    decoderPtr = withHeapBuffer(message.extradata ?? new Uint8Array(), (ptr) =>
      moduleRef!._movi_video_decoder_create(
        message.codecId,
        message.width,
        message.height,
        ptr,
        message.extradata?.byteLength ?? 0,
      ),
    );
    if (!decoderPtr) {
      post({
        type: "configured",
        requestId: message.requestId,
        generation,
        trackId,
        success: false,
        error: `Failed to create decoder for ${message.codec}`,
        queueDepth,
        inFlight,
      });
      return;
    }

    moduleRef._movi_video_decoder_set_skip_frame(
      decoderPtr,
      targetFps > 0 && targetFps < 10 ? 1 : 0,
    );
    post({
      type: "configured",
      requestId: message.requestId,
      generation,
      trackId,
      success: true,
      queueDepth,
      inFlight,
    });
  } catch (error) {
    post({
      type: "configured",
      requestId: message.requestId,
      generation,
      trackId,
      success: false,
      error: describeError(error),
      queueDepth,
      inFlight,
    });
  }
}

function shouldCreateFrame(timestamp: number): boolean {
  if (targetFps <= 0 || lastProcessedTimestamp < 0) return true;
  const interval = 1_000_000 / targetFps;
  return timestamp >= lastProcessedTimestamp + interval * 0.9;
}

function createFrame(timestamp: number): VideoFrame | null {
  if (!moduleRef || !decoderPtr) return null;
  const sourceWidth = moduleRef._movi_video_decoder_get_frame_width(decoderPtr);
  const sourceHeight = moduleRef._movi_video_decoder_get_frame_height(decoderPtr);
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  let width = sourceWidth;
  let height = sourceHeight;
  if (width > 1920) {
    const scale = 1920 / width;
    width = 1920;
    height = Math.floor(height * scale);
  }

  if (width === sourceWidth && height === sourceHeight) {
    const formatId =
      moduleRef._movi_video_decoder_get_frame_webcodecs_format(decoderPtr);
    const nativeFrame = packWebCodecsFrame(
      moduleRef.HEAPU8,
      formatId,
      width,
      height,
      (plane) =>
        moduleRef!._movi_video_decoder_get_frame_data(decoderPtr, plane),
      (plane) =>
        moduleRef!._movi_video_decoder_get_frame_linesize(decoderPtr, plane),
    );
    if (nativeFrame) {
      try {
        return new VideoFrame(nativeFrame.data, {
          format: nativeFrame.format,
          codedWidth: width,
          codedHeight: height,
          timestamp,
          layout: nativeFrame.layout,
        });
      } catch {
        // Browser/worker rejected this otherwise representable pixel format.
      }
    }
  }

  const rgbaPtr = moduleRef._movi_video_decoder_get_frame_rgba(
    decoderPtr,
    width,
    height,
  );
  const rgbaSize = moduleRef._movi_video_decoder_get_frame_rgba_size(decoderPtr);
  if (!rgbaPtr || rgbaSize <= 0) return null;
  const rgba = moduleRef.HEAPU8.slice(rgbaPtr, rgbaPtr + rgbaSize);
  return new VideoFrame(rgba, {
    format: "RGBA",
    codedWidth: width,
    codedHeight: height,
    timestamp,
  });
}

function emitFrames(message: DecodeRequest): void {
  if (!moduleRef || !decoderPtr) return;
  while (
    !isStale(message) &&
    moduleRef._movi_video_decoder_receive_frame(decoderPtr) === 0
  ) {
    const framePts = moduleRef._movi_video_decoder_get_frame_pts(decoderPtr);
    const timestamp =
      (Number.isFinite(framePts) ? framePts : message.pts) * 1_000_000;
    if (!shouldCreateFrame(timestamp)) continue;

    const frame = createFrame(timestamp);
    if (!frame || isStale(message)) {
      frame?.close();
      continue;
    }
    lastProcessedTimestamp = timestamp;
    try {
      post(
        {
          type: "frame",
          requestId: message.requestId,
          generation: message.generation,
          trackId: message.trackId,
          frame,
          queueDepth,
          inFlight,
        },
        [frame],
      );
    } catch (error) {
      frame.close();
      throw error;
    }
  }
}

function decode(message: DecodeRequest): void {
  if (!moduleRef || !decoderPtr || isStale(message)) return;
  queueDepth++;
  inFlight++;
  try {
    const ret = withHeapBuffer(message.data, (ptr) =>
      moduleRef!._movi_video_decoder_send_packet(
        decoderPtr,
        ptr,
        message.data.byteLength,
        message.pts,
        message.dts,
        message.keyframe ? 1 : 0,
      ),
    );
    if (ret < 0) {
      throw new Error(`movi_video_decoder_send_packet failed: ${ret}`);
    }
    emitFrames(message);
  } catch (error) {
    post({
      type: "error",
      requestId: message.requestId,
      generation: message.generation,
      trackId: message.trackId,
      error: describeError(error),
      queueDepth,
      inFlight,
    });
  } finally {
    queueDepth = Math.max(0, queueDepth - 1);
    inFlight = Math.max(0, inFlight - 1);
    post({
      type: "decoded",
      requestId: message.requestId,
      generation: message.generation,
      trackId: message.trackId,
      queueDepth,
      inFlight,
    });
  }
}

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "configure") {
    void configure(message);
    return;
  }
  if (message.type === "decode") {
    decode(message);
    return;
  }
  if (message.type === "reset") {
    generation = message.generation;
    trackId = message.trackId;
    queueDepth = 0;
    inFlight = 0;
    lastProcessedTimestamp = -1;
    if (moduleRef && decoderPtr) {
      moduleRef._movi_video_decoder_flush(decoderPtr);
    }
    return;
  }
  closeDecoder();
  scope.close();
});

scope.addEventListener("error", (event: ErrorEvent) => {
  post({
    type: "error",
    generation,
    trackId,
    error: describeError(event.error ?? event.message),
    queueDepth,
    inFlight,
  });
});

scope.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  post({
    type: "error",
    generation,
    trackId,
    error: describeError(event.reason),
    queueDepth,
    inFlight,
  });
});
