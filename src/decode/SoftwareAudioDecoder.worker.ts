import type { AudioTrack } from "../types";
import { loadWasmModuleNew } from "../wasm/FFmpegLoader";
import type { MoviWasmModule } from "../wasm/types";
import { PCMFrameTimestampClock } from "./PCMFrameTimestampClock";
import type { PCMFrame } from "./SoftwareAudioDecoder";

type WorkerRequest =
  | {
      type: "configure";
      requestId: number;
      generation: number;
      trackId: number;
      track: AudioTrack;
      extradata?: Uint8Array;
      downmix: boolean;
      controlBuffer?: SharedArrayBuffer;
    }
  | {
      type: "decode";
      requestId: number;
      generation: number;
      trackId: number;
      data: Uint8Array;
      pts: number;
      timeBase: number;
      keyframe: boolean;
    }
  | {
      type: "setDownmix";
      generation: number;
      trackId: number;
      downmix: boolean;
    }
  | { type: "flush"; generation: number; trackId: number }
  | { type: "reset"; generation: number; trackId: number }
  | { type: "close"; generation: number; trackId: number };

type WorkerResponse =
  | {
      type: "configured";
      requestId: number;
      generation: number;
      trackId: number;
      success: boolean;
      error?: string;
      queueDepth: number;
      inFlight: number;
    }
  | {
      type: "frame";
      requestId: number;
      generation: number;
      trackId: number;
      pts: number;
      timeBase: number;
      frame: PCMFrame;
      queueDepth: number;
      inFlight: number;
    }
  | {
      type: "decoded";
      requestId: number;
      generation: number;
      trackId: number;
      queueDepth: number;
      inFlight: number;
    }
  | {
      type: "error";
      requestId?: number;
      generation: number;
      trackId: number;
      error: string;
      queueDepth: number;
      inFlight: number;
    }
  | {
      // Fired once when the consecutive-failure circuit-breaker trips (see
      // MAX_CONSECUTIVE_FAILURES below). Distinct from "error": a per-packet
      // "error" is expected noise on a misaligned stream, but this tells the
      // main thread the decoder has gone permanently silent and it should
      // re-align the source — mirrors SoftwareAudioDecoder.ts's onBroken.
      type: "broken";
      generation: number;
      trackId: number;
      queueDepth: number;
      inFlight: number;
    };

const scope = self as DedicatedWorkerGlobalScope;

let moduleRef: MoviWasmModule | null = null;
let decoderPtr = 0;
let downmix = true;
let generation = 1;
let trackId = -1;
let queueDepth = 0;
let inFlight = 0;
let cancelGeneration: Int32Array | null = null;
const pcmTimestampClock = new PCMFrameTimestampClock();

// Mirrors SoftwareAudioDecoder.ts's circuit-breaker (same threshold, same
// intent): a file that rejects every packet — codec mismatch, corrupt
// extradata, an FFmpeg allocator that won't recover — must not be retried
// forever. After this many consecutive sendPacket failures the decoder stops
// calling into WASM and tells the main thread it is broken so the player can
// re-align the source. Cleared on configure/flush/reset (a fresh run, or the
// re-align a caller does in response to "broken", deserves a clean slate).
const MAX_CONSECUTIVE_FAILURES = 50;
let consecutiveFailures = 0;
let isBroken = false;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

scope.addEventListener("error", (event: ErrorEvent) => {
  post({
    type: "error",
    generation,
    trackId,
    error: [
      "Worker uncaught error",
      event.message || "",
      event.filename ? `at ${event.filename}` : "",
      event.lineno || event.colno
        ? `line ${event.lineno || 0}:${event.colno || 0}`
        : "",
      event.error ? describeError(event.error) : "",
    ]
      .filter(Boolean)
      .join(" | "),
    queueDepth,
    inFlight,
  });
});

scope.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  post({
    type: "error",
    generation,
    trackId,
    error: `Worker unhandled rejection | ${describeError(event.reason)}`,
    queueDepth,
    inFlight,
  });
});

function closeDecoder(): void {
  if (moduleRef && decoderPtr) {
    moduleRef._movi_audio_decoder_destroy(decoderPtr);
  }
  decoderPtr = 0;
}

function isStale(message: { generation: number; trackId: number }): boolean {
  return (
    message.generation !== currentGeneration() || message.trackId !== trackId
  );
}

function isOlderGeneration(message: { generation: number }): boolean {
  return message.generation < currentGeneration();
}

function currentGeneration(): number {
  return cancelGeneration ? Atomics.load(cancelGeneration, 0) : generation;
}

function withPacketBuffer<T>(data: Uint8Array, fn: (ptr: number) => T): T {
  if (!moduleRef) throw new Error("WASM module not loaded");
  const ptr = moduleRef._malloc(data.byteLength);
  if (!ptr) throw new Error("Failed to allocate packet buffer");
  try {
    moduleRef.HEAPU8.set(data, ptr);
    return fn(ptr);
  } finally {
    moduleRef._free(ptr);
  }
}

async function configure(
  requestId: number,
  nextGeneration: number,
  nextTrackId: number,
  track: AudioTrack,
  extradata: Uint8Array | undefined,
  controlBuffer: SharedArrayBuffer | undefined,
): Promise<void> {
  cancelGeneration = controlBuffer ? new Int32Array(controlBuffer) : null;
  generation = nextGeneration;
  trackId = nextTrackId;
  queueDepth = 0;
  inFlight = 0;
  pcmTimestampClock.reset();
  consecutiveFailures = 0;
  isBroken = false;
  closeDecoder();

  if (!track.codecId) {
    post({
      type: "configured",
      requestId,
      generation,
      trackId,
      success: false,
      error: `Missing codecId for ${track.codec}`,
      queueDepth,
      inFlight,
    });
    return;
  }

  moduleRef = await loadWasmModuleNew();

  let extradataPtr = 0;
  try {
    if (extradata && extradata.byteLength > 0) {
      extradataPtr = moduleRef._malloc(extradata.byteLength);
      if (!extradataPtr) throw new Error("Failed to allocate extradata");
      moduleRef.HEAPU8.set(extradata, extradataPtr);
    }

    decoderPtr = moduleRef._movi_audio_decoder_create(
      track.codecId,
      track.sampleRate,
      track.channels,
      extradataPtr,
      extradata?.byteLength ?? 0,
    );

    if (!decoderPtr) {
      post({
        type: "configured",
        requestId,
        generation,
        trackId,
        success: false,
        error: `Failed to create decoder for ${track.codec}`,
        queueDepth,
        inFlight,
      });
      return;
    }

    moduleRef._movi_audio_decoder_enable_downmix(decoderPtr, downmix ? 1 : 0);
    post({
      type: "configured",
      requestId,
      generation,
      trackId,
      success: true,
      queueDepth,
      inFlight,
    });
  } finally {
    if (extradataPtr) moduleRef._free(extradataPtr);
  }
}

function emitFrames(message: Extract<WorkerRequest, { type: "decode" }>): void {
  if (!moduleRef || !decoderPtr) return;

  while (moduleRef._movi_audio_decoder_receive_frame(decoderPtr) === 0) {
    const numberOfFrames =
      moduleRef._movi_audio_decoder_get_frame_samples(decoderPtr);
    const numberOfChannels =
      moduleRef._movi_audio_decoder_get_frame_channels(decoderPtr);
    const sampleRate =
      moduleRef._movi_audio_decoder_get_frame_sample_rate(decoderPtr);

    const planes: Float32Array[] = [];
    const transfer: Transferable[] = [];
    for (let i = 0; i < numberOfChannels; i++) {
      const ptr = moduleRef._movi_audio_decoder_get_frame_data(decoderPtr, i);
      const view = new Float32Array(
        moduleRef.HEAPU8.buffer,
        ptr,
        numberOfFrames,
      );
      const copy = new Float32Array(view);
      planes.push(copy);
      transfer.push(copy.buffer);
    }

    post(
      {
        type: "frame",
        requestId: message.requestId,
        generation: message.generation,
        trackId: message.trackId,
        pts: message.pts,
        timeBase: message.timeBase,
        frame: {
          planes,
          numberOfFrames,
          numberOfChannels,
          sampleRate,
          timestamp: pcmTimestampClock.next(
            message.pts,
            numberOfFrames,
            sampleRate,
          ),
        },
        queueDepth,
        inFlight,
      },
      transfer,
    );
  }
}

function decode(message: Extract<WorkerRequest, { type: "decode" }>): void {
  if (isStale(message) || !moduleRef || !decoderPtr) return;

  // Breaker already tripped for this track/generation: don't keep hammering
  // WASM with packets that are certain to fail. Still resolve the request
  // (as "decoded", not "error" — this isn't a new failure) so the main
  // thread's queueDepth/inFlight bookkeeping, incremented optimistically in
  // WorkerSoftwareAudioDecoder.decode(), doesn't drift upward forever.
  if (isBroken) {
    post({
      type: "decoded",
      requestId: message.requestId,
      generation: message.generation,
      trackId: message.trackId,
      queueDepth,
      inFlight,
    });
    return;
  }

  queueDepth++;
  inFlight++;
  try {
    const ret = withPacketBuffer(message.data, (ptr) =>
      moduleRef!._movi_audio_decoder_send_packet(
        decoderPtr,
        ptr,
        message.data.byteLength,
        message.pts,
        message.pts,
        message.keyframe ? 1 : 0,
      ),
    );

    if (ret < 0) {
      consecutiveFailures++;
      post({
        type: "error",
        requestId: message.requestId,
        generation: message.generation,
        trackId: message.trackId,
        error: `sendPacket failed: ${ret}`,
        queueDepth,
        inFlight,
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        isBroken = true;
        post({
          type: "broken",
          generation: message.generation,
          trackId: message.trackId,
          queueDepth,
          inFlight,
        });
      }
      return;
    }

    consecutiveFailures = 0;
    emitFrames(message);
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

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case "configure":
        downmix = message.downmix;
        void configure(
          message.requestId,
          message.generation,
          message.trackId,
          message.track,
          message.extradata,
          message.controlBuffer,
        ).catch((error) => {
          post({
            type: "configured",
            requestId: message.requestId,
            generation: message.generation,
            trackId: message.trackId,
            success: false,
            error: describeError(error),
            queueDepth,
            inFlight,
          });
        });
        break;
      case "decode":
        decode(message);
        break;
      case "setDownmix":
        if (isStale(message)) return;
        downmix = message.downmix;
        if (moduleRef && decoderPtr) {
          moduleRef._movi_audio_decoder_enable_downmix(
            decoderPtr,
            downmix ? 1 : 0,
          );
        }
        break;
      case "flush":
        if (isOlderGeneration(message)) return;
        generation = message.generation;
        trackId = message.trackId;
        queueDepth = 0;
        inFlight = 0;
        pcmTimestampClock.reset();
        // Clear the breaker: a flush is the re-align a "broken" caller was
        // asked to do, and it deserves a clean slate rather than staying
        // muted forever after the first trip.
        consecutiveFailures = 0;
        isBroken = false;
        if (moduleRef && decoderPtr) {
          moduleRef._movi_audio_decoder_flush(decoderPtr);
        }
        break;
      case "reset":
        if (isOlderGeneration(message)) return;
        generation = message.generation;
        trackId = message.trackId;
        queueDepth = 0;
        inFlight = 0;
        pcmTimestampClock.reset();
        consecutiveFailures = 0;
        isBroken = false;
        if (moduleRef && decoderPtr) {
          moduleRef._movi_audio_decoder_flush(decoderPtr);
        }
        break;
      case "close":
        pcmTimestampClock.reset();
        closeDecoder();
        scope.close();
        break;
    }
  } catch (error) {
    post({
      type: "error",
      generation,
      trackId,
      error: describeError(error),
      queueDepth,
      inFlight,
    });
  }
};
