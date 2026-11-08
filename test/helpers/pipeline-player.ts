import { vi } from "vitest";
import type { AudioTrack, Packet, VideoTrack } from "../../src/types";
import { stubBrowserGlobals } from "./browser-globals";

/**
 * A MoviPlayer wired with fakes at the decoder/renderer/demuxer boundary, for
 * driving `processLoop` one tick at a time and observing the read/feed
 * decisions it makes: whether it calls `demuxer.readPacket()`, and which
 * queued packets it hands to which decoder.
 *
 * The fakes behave the way the real objects do where it matters to those
 * decisions: `decode()` raises the decoder's queue size, the demuxer returns
 * the scripted packets and then `null` (end of file), and the renderer
 * buffers report whatever the test pins them to. Each test file still owns
 * its `vi.mock(...)` calls for the WASM/ABR modules (vitest scopes those per
 * file), which also cover this helper's dynamic import.
 */
export const videoTrack: VideoTrack = {
  id: 0,
  type: "video",
  codec: "hevc",
  width: 1920,
  height: 1080,
  frameRate: 24,
};

export const flacTrack: AudioTrack = {
  id: 1,
  type: "audio",
  codec: "flac",
  codecId: 86028,
  channels: 2,
  sampleRate: 48000,
};

export function videoPacket(timestamp: number, keyframe = false, size = 1000): Packet {
  return {
    streamIndex: videoTrack.id,
    keyframe,
    timestamp,
    dts: timestamp,
    duration: 1 / 24,
    data: new Uint8Array(size),
    isIdr: keyframe,
    isRasl: false,
    disposable: false,
  };
}

export function audioPacket(timestamp: number, size = 100): Packet {
  return {
    streamIndex: flacTrack.id,
    keyframe: true,
    timestamp,
    dts: timestamp,
    duration: 0.02,
    data: new Uint8Array(size),
    isIdr: false,
    isRasl: false,
    disposable: false,
  };
}

/** Packets spaced `step` apart from `from` up to (excluding) `to`. */
export function packetRun(
  make: (t: number) => Packet,
  from: number,
  to: number,
  step: number,
): Packet[] {
  const out: Packet[] = [];
  for (let t = from; t < to - 1e-9; t += step) out.push(make(t));
  return out;
}

export interface DecoderShape {
  isSoftware: boolean;
  worker: boolean;
  queueSize: number;
}

export interface PipelineOptions {
  state?: "playing" | "buffering";
  tracks?: (VideoTrack | AudioTrack)[];
  video?: DecoderShape;
  audio?: DecoderShape;
  /** Seconds of decoded audio the renderer reports. */
  audioBuffered?: number;
  /** Decoded frames the video renderer holds. */
  rendererQueue?: number;
  /** How long the picture has been without an on-time frame, in ms. */
  videoUnderflowMs?: number;
  waitingForVideoSync?: boolean;
  wasPlayingBeforeRebuffer?: boolean;
  /** What `readPacket()` returns, in order; `null` (EOF) afterwards. */
  reads?: Packet[];
  /** Packets already sitting in the per-stream queues. */
  queuedVideo?: Packet[];
  queuedAudio?: Packet[];
}

export interface PipelineFixture {
  player: any;
  readPacket: ReturnType<typeof vi.fn>;
  videoDecode: ReturnType<typeof vi.fn>;
  audioDecode: ReturnType<typeof vi.fn>;
  videoDecoder: { queueSize: number };
  audioDecoder: { queueSize: number };
  tick: () => Promise<void>;
}

export async function makePipelinePlayer(
  opts: PipelineOptions = {},
): Promise<PipelineFixture> {
  stubBrowserGlobals();
  const { MoviPlayer } = await import("../../src/core/MoviPlayer");
  const player: any = new MoviPlayer({});
  player.trackManager.setTracks(opts.tracks ?? [videoTrack, flacTrack]);
  const sm = player.stateManager;
  sm.setState("loading");
  sm.setState("ready");
  sm.setState("playing");
  if (opts.state === "buffering") sm.setState("buffering");

  const reads = [...(opts.reads ?? [])];
  const readPacket = vi.fn(async () => reads.shift() ?? null);

  const video = opts.video ?? { isSoftware: false, worker: false, queueSize: 0 };
  const audio = opts.audio ?? { isSoftware: true, worker: true, queueSize: 0 };

  const videoDecoder = {
    isSoftware: video.isSoftware,
    queueSize: video.queueSize,
    isWaitingForKeyframe: false,
    isRecentlyRecovering: () => false,
    keyframeWaitMs: () => 0,
    flush: vi.fn(async () => {}),
    getStats: () => (video.worker ? { worker: { queueDepth: 0 } } : {}),
    decode: vi.fn(() => {
      videoDecoder.queueSize++;
    }),
  };
  const audioDecoder = {
    isSoftware: audio.isSoftware,
    usesSoftware: audio.isSoftware,
    queueSize: audio.queueSize,
    getStats: () => (audio.worker ? { worker: { queueDepth: 0 } } : {}),
    canBatch: () => false,
    close: vi.fn(),
    // An audio track switch keeps the decoder object and reconfigures it.
    reset: vi.fn(),
    setDownmix: vi.fn(),
    configure: vi.fn(async () => true),
    flush: vi.fn(async () => {}),
    decode: vi.fn(() => {
      audioDecoder.queueSize++;
    }),
  };

  Object.assign(player, {
    demuxer: {
      readPacket,
      seek: vi.fn(async () => {}),
      // What an audio track switch asks of the demuxer besides the seek.
      getBindings: () => undefined,
      getExtradata: () => undefined,
    },
    mediaInfo: { duration: 1422, videoFrameRate: 24 },
    wasPlayingBeforeRebuffer: opts.wasPlayingBeforeRebuffer ?? opts.state === "buffering",
    _playStartTime: performance.now() - 20_000,
    waitingForVideoSync: opts.waitingForVideoSync ?? false,
    seekTargetTime: -1,
    seekDemuxAheadTime: -1,
    seekSyncArmedAt: opts.waitingForVideoSync ? performance.now() : 0,
    disableAudio: false,
    muted: false,
    eofReached: false,
    demuxInFlight: false,
    isBackgrounded: false,
    isPiPActive: false,
    _primingAudio: false,
    _videoResumeTarget: -1,
    videoDecoder,
    audioDecoder,
    videoRenderer: {
      getQueueSize: () => opts.rendererQueue ?? 5,
      stopPresentationLoop: vi.fn(),
      startPresentationLoop: vi.fn(),
      clearQueue: vi.fn(),
      getVideoUnderflowMs: () => opts.videoUnderflowMs ?? 0,
      discardLateFrames: vi.fn(() => 0),
      getHeadFrameTime: () => 12,
      getStats: () => ({ framesPresented: 0 }),
    },
    audioRenderer: {
      getBufferedDuration: () => opts.audioBuffered ?? 0.5,
      isRebuffering: () => false,
      isDroppingAudio: () => false,
      isUnderrunning: () => false,
      getAudioClock: () => -1,
      getMaxScheduledMediaTime: () => 0,
      resumeFromBuffering: vi.fn(),
      suspendForBuffering: vi.fn(),
      primeForBuffering: vi.fn(),
      reset: vi.fn(),
      play: vi.fn(async () => {}),
      pause: vi.fn(),
      isAudioPlaying: () => true,
      getMaxChannelCount: () => 2,
      setOutputChannelCount: vi.fn(),
      render: vi.fn(),
      renderPCM: vi.fn(),
      // The tail detection ends the sound's clock once its last sample played.
      isStreamEnded: () => false,
      endOfStream: vi.fn(),
    },
  });
  for (const p of opts.queuedVideo ?? []) player.videoQueue.push(p);
  for (const p of opts.queuedAudio ?? []) player.audioQueue.push(p);

  return {
    player,
    readPacket,
    videoDecode: videoDecoder.decode,
    audioDecode: audioDecoder.decode,
    videoDecoder,
    audioDecoder,
    tick: () => player.processLoop(),
  };
}
