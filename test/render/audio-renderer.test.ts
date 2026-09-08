import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioRenderer } from "../../src/render/AudioRenderer";
import type { PCMFrame } from "../../src/decode/SoftwareAudioDecoder";

vi.mock("../../dist/wasm/movi.js", () => ({ default: vi.fn(async () => ({})) }));

class FakeAudioBuffer {
  readonly duration: number;
  private data: Float32Array[];
  /**
   * True once the renderer wrote PCM into this buffer. Upstream's fillSeam()
   * also schedules buffers — silent ones, laid across a gap in the schedule —
   * and they are indistinguishable from a decoded buffer by shape alone. Every
   * data path (schedulePCMFrame's copyToChannel, flushPendingPCM's
   * getChannelData().set) touches the channels; a seam filler never does.
   */
  touched = false;

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
    this.data = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
  }

  copyToChannel(source: Float32Array, channel: number, offset = 0): void {
    this.touched = true;
    this.data[channel].set(source, offset);
  }

  getChannelData(channel: number): Float32Array {
    this.touched = true;
    return this.data[channel];
  }
}

/** Scheduled sources carrying decoded audio, excluding fillSeam's silence. */
function dataSources(ctx: FakeAudioContext): FakeSource[] {
  return ctx.sources.filter((source) => source.buffer?.touched);
}

/** Scheduled sources that are fillSeam()'s silence. */
function seamSources(ctx: FakeAudioContext): FakeSource[] {
  return ctx.sources.filter((source) => source.buffer && !source.buffer.touched);
}

class FakeSource {
  buffer: FakeAudioBuffer | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  startTime = -1;
  connect = vi.fn();
  disconnect = vi.fn();
  stop = vi.fn();

  start(when = 0): void {
    this.startTime = when;
  }
}

class FakeGain {
  gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  channelCount = 2;
  channelCountMode = "max";
  channelInterpretation = "speakers";
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  currentTime = 0;
  state = "running";
  destination = {
    maxChannelCount: 2,
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  };
  sources: FakeSource[] = [];

  createGain(): FakeGain {
    return new FakeGain();
  }

  createDynamicsCompressor(): FakeGain {
    return new FakeGain();
  }

  createBuffer(
    channels: number,
    frames: number,
    sampleRate: number,
  ): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, frames, sampleRate);
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.state = "suspended";
    return Promise.resolve();
  }
}

function makeRenderer(ctx: FakeAudioContext): AudioRenderer {
  const renderer = new AudioRenderer();
  Object.assign(renderer as any, {
    audioContext: ctx,
    gainNode: ctx.createGain(),
    isPlaying: true,
  });
  return renderer;
}

function makePCMFrame(index: number, frames = 40, timestamp?: number): PCMFrame {
  const sampleRate = 48_000;
  const left = new Float32Array(frames).fill(index);
  const right = new Float32Array(frames).fill(1000 + index);
  return {
    planes: [left, right],
    numberOfFrames: frames,
    numberOfChannels: 2,
    sampleRate,
    timestamp:
      timestamp ?? Math.round((index * frames * 1_000_000) / sampleRate),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AudioRenderer PCM scheduling", () => {
  it("coalesces TrueHD-sized software PCM frames before scheduling WebAudio sources", () => {
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    for (let i = 0; i < 24; i++) {
      renderer.renderPCM(makePCMFrame(i));
    }

    const scheduled = dataSources(ctx);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].buffer?.length).toBe(960);
    expect(scheduled[0].buffer?.duration).toBeCloseTo(0.02, 5);
    expect(scheduled[0].buffer?.getChannelData(0)[0]).toBe(0);
    expect(scheduled[0].buffer?.getChannelData(0)[959]).toBe(23);
    expect((renderer as any).activeSources).toHaveLength(1);
  });

  it("coalesces tiny PCM frames that share a packet timestamp", () => {
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    for (let i = 0; i < 48; i++) {
      renderer.renderPCM(makePCMFrame(i, 40, 5_000_000));
    }

    const scheduled = dataSources(ctx);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0].buffer?.length).toBe(960);
    expect(scheduled[1].buffer?.length).toBe(960);
    expect(scheduled[1].startTime - scheduled[0].startTime).toBeCloseTo(0.02, 5);
  });

  it("flushes a pending PCM batch before scheduling a normal-sized frame", () => {
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    renderer.renderPCM(makePCMFrame(0));
    renderer.renderPCM(makePCMFrame(1, 2048));

    const scheduled = dataSources(ctx);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0].buffer?.length).toBe(40);
    expect(scheduled[1].buffer?.length).toBe(2048);
  });

  it("timer-flushes a short trailing PCM batch", () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    renderer.renderPCM(makePCMFrame(0));
    expect(dataSources(ctx)).toHaveLength(0);

    vi.advanceTimersByTime(25);

    const scheduled = dataSources(ctx);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].buffer?.length).toBe(40);
  });

  it("drops pending PCM while muted and suspended", () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    renderer.renderPCM(makePCMFrame(0));
    Object.assign(renderer as any, { _muted: true });
    ctx.state = "suspended";
    renderer.renderPCM(makePCMFrame(1));
    vi.advanceTimersByTime(25);

    expect(dataSources(ctx)).toHaveLength(0);
    expect((renderer as any).pendingPCM).toBeNull();
  });

  it("discards pending PCM when playback rate changes", () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    renderer.renderPCM(makePCMFrame(0));
    renderer.setPlaybackRate(1.25);
    vi.advanceTimersByTime(25);

    expect(dataSources(ctx)).toHaveLength(0);
    expect((renderer as any).pendingPCM).toBeNull();
  });

  it("clears pending PCM and its timer on reset", () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    renderer.renderPCM(makePCMFrame(0));
    renderer.reset();
    vi.advanceTimersByTime(25);

    expect(dataSources(ctx)).toHaveLength(0);
    expect((renderer as any).pendingPCM).toBeNull();
  });

  it("does not let pending PCM flush errors prevent pause", () => {
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    renderer.renderPCM(makePCMFrame(0));
    ctx.createBuffer = vi.fn(() => {
      throw new Error("createBuffer failed");
    });

    expect(() => renderer.pause()).not.toThrow();
    expect((renderer as any).isPlaying).toBe(false);
    expect((renderer as any).pendingPCM).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A8: keep the renderer-side pendingPCM coalescing, or drop it and rely on the
// decoder emitting large frames (upstream's arrangement)?
//
// The numbers below are MEASURED, not assumed. Five seconds of 48kHz audio was
// encoded per codec with ffmpeg, the packets were sliced out of the elementary
// stream at ffprobe's byte offsets, and each packet was pushed through the real
// WASM build (dist/wasm/movi.js) using the same _movi_audio_decoder_* sequence
// SoftwareAudioDecoder.worker.ts uses. `frameSamples` is what
// _movi_audio_decoder_get_frame_samples actually returned, with zero
// send_packet failures and decoded duration matching the 5.00s source:
//
//   aac     236 pkts -> 236 frames  1024 samples  46.9 frames/s
//   mp3     210 pkts -> 210 frames  1152 samples  41.7 frames/s
//   ac3     157 pkts -> 157 frames  1536 samples  31.3 frames/s
//   eac3    157 pkts -> 157 frames  1536 samples  31.3 frames/s
//   dts     469 pkts -> 469 frames   512 samples  93.8 frames/s
//   truehd 6000 pkts -> 6000 frames   40 samples 1200.0 frames/s
//   flac     53 pkts ->  53 frames  4608 samples  10.6 frames/s
//
// The decisive fact: SoftwareAudioDecoder.worker.ts's emitFrames() posts every
// libavcodec frame RAW. The ~30ms coalescing in SoftwareAudioDecoder.ts
// (enqueueFrame/coalesceTarget) lives only on the main thread, and A5 made the
// worker the primary path for every codec — so after A5 nothing upstream of the
// renderer merges frames at all. This test runs both arrangements through the
// real AudioRenderer and counts the AudioBufferSourceNodes each produces for one
// second of media.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Upstream capabilities that must survive the merge. Both are upstream-only
// (no fork counterpart, so no adjudication row covers them) and both were lost
// when AudioRenderer's conflicts were resolved by hand; PLAN_MERGE §2.1 says
// the default is the union, so they come back.
// ---------------------------------------------------------------------------
describe("merge: upstream AudioRenderer capabilities survive", () => {
  it("exposes wasEverActivated() so the player can wait out a resume instead of muting", async () => {
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    // MoviPlayer's maybeFallbackToMutedAutoplay() asks this before deciding a
    // suspended context means autoplay was refused. Without it, an
    // auto-advanced track flashes "tap to unmute" every time.
    expect(typeof (renderer as any).wasEverActivated).toBe("function");
    expect(renderer.wasEverActivated()).toBe(false);

    // The latch is set by the resume that play() performs on a suspended
    // shared context — the moment audio is actually unlocked.
    ctx.state = "suspended";
    await renderer.play();

    expect(ctx.state).toBe("running");
    expect(renderer.wasEverActivated()).toBe(true);
  });

  it("pre-warms the stretcher at the DECODED media rate, not the context rate", () => {
    // A 48kHz source in a 44.1kHz context: building the stretcher at 44100
    // makes processStretch destroy and lazily rebuild it at 48000 on the first
    // chunk, which is the ~1-2s opening silence the pre-warm exists to remove.
    const ctx = new FakeAudioContext();
    (ctx as unknown as { sampleRate: number }).sampleRate = 44_100;
    const renderer = makeRenderer(ctx);
    const built: number[] = [];
    (renderer as any).maybeInitSignalsmith = (rate: number) => built.push(rate);
    Object.assign(renderer as any, { preservePitch: true });

    renderer.renderPCM(makePCMFrame(0, 2048));
    renderer.setPlaybackRate(1.5);

    expect(built).toEqual([48_000]);
  });
});

const MEASURED_WORKER_FRAME_SIZES = [
  { codec: "aac", frameSamples: 1024 },
  { codec: "mp3", frameSamples: 1152 },
  { codec: "ac3", frameSamples: 1536 },
  { codec: "dts", frameSamples: 512 },
  { codec: "truehd", frameSamples: 40 },
  { codec: "flac", frameSamples: 4608 },
] as const;

const SAMPLE_RATE = 48_000;

/** One second of media at `frameSamples` per frame, timestamps contiguous. */
function oneSecondOfFrames(frameSamples: number): PCMFrame[] {
  const count = Math.ceil(SAMPLE_RATE / frameSamples);
  const frames: PCMFrame[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(makePCMFrame(i, frameSamples));
  }
  return frames;
}

const AudioRendererInternals = AudioRenderer as unknown as {
  PCM_COALESCE_MIN_DURATION: number;
  PCM_COALESCE_MAX_DELAY_MS: number;
  PUMP_INTERVAL_MS: number;
};

/**
 * Feed one second of media and return how many AudioBufferSourceNodes the
 * renderer created for it.
 *
 * The clock is advanced past the whole second afterwards and the pump timer let
 * run, because upstream's SCHEDULE_LOOKAHEAD holds buffers as plain data until
 * their turn comes within 1s of `currentTime`. Without that the count would
 * measure the lookahead window rather than the second of audio.
 */
function nodesForOneSecond(frameSamples: number): {
  data: number;
  seams: number;
} {
  vi.useFakeTimers();
  try {
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);
    for (const frame of oneSecondOfFrames(frameSamples)) {
      renderer.renderPCM(frame);
    }
    // Let the trailing partial batch out through its flush timer.
    vi.advanceTimersByTime(AudioRendererInternals.PCM_COALESCE_MAX_DELAY_MS + 5);
    // Then drain everything the lookahead is still holding back.
    ctx.currentTime = 10;
    vi.advanceTimersByTime(AudioRendererInternals.PUMP_INTERVAL_MS * 20);
    return { data: dataSources(ctx).length, seams: seamSources(ctx).length };
  } finally {
    vi.useRealTimers();
  }
}

describe("A8: WebAudio node budget per second of media (measured)", () => {
  const originalMinDuration = AudioRendererInternals.PCM_COALESCE_MIN_DURATION;

  afterEach(() => {
    AudioRendererInternals.PCM_COALESCE_MIN_DURATION = originalMinDuration;
  });

  it("keeps every codec inside a ~50 node/s budget with coalescing (fork, A8 default)", () => {
    const counted = Object.fromEntries(
      MEASURED_WORKER_FRAME_SIZES.map(({ codec, frameSamples }) => [
        codec,
        nodesForOneSecond(frameSamples).data,
      ]),
    );

    expect(counted).toEqual({
      aac: 47,
      mp3: 42,
      ac3: 32,
      dts: 47,
      truehd: 50,
      flac: 11,
    });
  });

  it("without coalescing TrueHD costs 1200 nodes/s — the reason A8 stays with the fork", () => {
    // Upstream's renderPCM has no pendingPCM stage: every decoded frame becomes
    // its own AudioBufferSourceNode. Setting the coalesce threshold to 0 makes
    // the merged renderer take exactly that path for every frame, which is what
    // "take upstream for A8" would mean in the post-A5 worker architecture —
    // where nothing between libavcodec and the renderer merges frames.
    AudioRendererInternals.PCM_COALESCE_MIN_DURATION = 0;

    const counted = Object.fromEntries(
      MEASURED_WORKER_FRAME_SIZES.map(({ codec, frameSamples }) => [
        codec,
        nodesForOneSecond(frameSamples).data,
      ]),
    );

    expect(counted).toEqual({
      aac: 47,
      mp3: 42,
      ac3: 32,
      dts: 94,
      truehd: 1200,
      flac: 11,
    });
  });
});
