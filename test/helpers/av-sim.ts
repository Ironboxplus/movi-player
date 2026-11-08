import { vi } from "vitest";
import { AudioRenderer } from "../../src/render/AudioRenderer";
import { CanvasRenderer } from "../../src/render/CanvasRenderer";
import { Clock } from "../../src/core/Clock";

/**
 * A simulated playback rig: the real AudioRenderer, Clock and CanvasRenderer
 * presentation loop, driven by a fake `performance.now()`, a fake AudioContext
 * whose hardware clock can run fast or slow, and fake decoders.
 *
 * The point of building it this way is the ORACLE. "How far apart are the
 * picture and the sound" is answered by the fake output device, not by anything
 * the code under test reports: every scheduled source carries its media time in
 * its samples (sample i of a chunk holds `chunkMediaStart + i/sampleRate`), so
 * the device can say which media sample it is playing at any instant by looking
 * at what it was handed and where its own clock is. Whatever the renderers
 * believe about the clock cannot leak into the measurement.
 *
 * Time only moves when the test moves it (`step`, `run`, `blockMainThread`), so
 * a simulated hour costs a few seconds of CPU and is exactly reproducible.
 */

export const SAMPLE_RATE = 48_000;
const CHUNK_FRAMES = 960; // 20ms
const CHUNK_S = CHUNK_FRAMES / SAMPLE_RATE;
export const VSYNC_MS = 1000 / 60;

export class SimBuffer {
  readonly duration: number;
  /** True once someone wrote PCM into it: fillSeam's silence is never touched. */
  touched = false;
  private data: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
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

export class SimSource {
  buffer: SimBuffer | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  startTime = -1;
  stopTime = Infinity;
  // Plain functions, not vi.fn(): vitest keeps every mock it ever made alive
  // until restoreAllMocks, which is a few hundred thousand sources an hour.
  connect(): void {}
  disconnect(): void {}

  start(when = 0): void {
    this.startTime = when;
  }

  stop(when = 0): void {
    this.stopTime = Math.min(this.stopTime, when);
  }
}

class SimGain {
  gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  channelCount = 2;
  connect = vi.fn();
  disconnect = vi.fn();
}

export interface SimRef {
  /** The fake performance.now(), in ms. */
  t: number;
}

/**
 * An AudioContext whose clock is `(1 + ppm/1e6)` times the real one, and which
 * can be frozen without leaving "running" (a stalled device) or suspended.
 */
export class SimContext {
  sampleRate = SAMPLE_RATE;
  state = "running";
  destination = { maxChannelCount: 2, channelCount: 2 };
  sources: SimSource[] = [];
  private base = 0;
  private baseT: number;
  private frozen = false;

  constructor(
    private readonly ref: SimRef,
    readonly outputLatency: number,
    private readonly ppm: number,
  ) {
    this.baseT = ref.t;
  }

  /** The hardware clock, unquantised. */
  raw(): number {
    if (this.frozen) return this.base;
    return this.base + ((this.ref.t - this.baseT) / 1000) * (1 + this.ppm * 1e-6);
  }

  /** currentTime moves in render quanta of 128 frames, like a real context. */
  get currentTime(): number {
    return (Math.floor((this.raw() * SAMPLE_RATE) / 128) * 128) / SAMPLE_RATE;
  }

  /** The position being played out right now: the hardware clock minus latency. */
  getOutputTimestamp(): { contextTime: number; performanceTime: number } {
    return {
      contextTime: Math.max(0, this.raw() - this.outputLatency),
      performanceTime: this.ref.t,
    };
  }

  freezeClock(): void {
    if (this.frozen) return;
    this.base = this.raw();
    this.frozen = true;
  }

  releaseClock(): void {
    if (!this.frozen) return;
    this.baseT = this.ref.t;
    this.frozen = false;
  }

  suspend(): Promise<void> {
    this.freezeClock();
    this.state = "suspended";
    return Promise.resolve();
  }

  resume(): Promise<void> {
    this.releaseClock();
    this.state = "running";
    return Promise.resolve();
  }

  createGain(): SimGain {
    return new SimGain();
  }

  createDynamicsCompressor(): SimGain {
    return new SimGain();
  }

  createBuffer(channels: number, frames: number, sampleRate: number): SimBuffer {
    return new SimBuffer(channels, frames, sampleRate);
  }

  createBufferSource(): SimSource {
    const source = new SimSource();
    this.sources.push(source);
    return source;
  }

  /**
   * The media time the output device is playing right now, read from the
   * samples it was handed; null while it is playing silence (a gap, a filler,
   * nothing scheduled).
   */
  heardMedia(): number | null {
    const c = this.raw() - this.outputLatency;
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const s = this.sources[i];
      const b = s.buffer;
      if (!b || !b.touched || s.startTime < 0) continue;
      const rate = s.playbackRate.value;
      const end = Math.min(s.stopTime, s.startTime + b.duration / rate);
      if (c >= s.startTime && c < end) {
        const idx = Math.min(b.length - 1, Math.floor((c - s.startTime) * rate * SAMPLE_RATE));
        return b.getChannelData(0)[idx];
      }
    }
    return null;
  }

  /**
   * Retire sources that finished playing: fire their `ended` event, which is
   * what lets the renderer let go of them, and forget them. Without it a
   * simulated hour keeps every buffer of it alive.
   */
  prune(): void {
    const c = this.raw() - this.outputLatency - 0.25;
    const keep: SimSource[] = [];
    for (const s of this.sources) {
      const b = s.buffer;
      const end = b ? Math.min(s.stopTime, s.startTime + b.duration / s.playbackRate.value) : 0;
      if (s.startTime >= 0 && end <= c) s.onended?.();
      else keep.push(s);
    }
    this.sources = keep;
  }
}

export interface FakeFrame {
  timestamp: number;
  close: () => void;
  clone: () => FakeFrame;
}

function fakeFrame(ptsSeconds: number): FakeFrame {
  const timestamp = Math.round(ptsSeconds * 1e6);
  return { timestamp, close: () => {}, clone: () => fakeFrame(ptsSeconds) };
}

export interface SimOptions {
  /** Audio hardware clock error against performance.now(). */
  ppm?: number;
  fps?: number;
  outputLatency?: number;
  /** Seconds of decoded audio kept ahead of the device. */
  audioCushion?: number;
  /** Length of the media in seconds; the picture and sound stop there unless looping. */
  duration?: number;
  /** Frames the video decoder produces per second of real time, as a multiple of fps. */
  decodeSpeed?: number;
  /** No audio track: the clock has no audio side and nothing is fed to it. */
  noAudio?: boolean;
}

export interface Window {
  /** Largest distance between the heard time and the displayed frame's interval. */
  maxErr: number;
  /** When (seconds into the window) the worst sample was taken. */
  worstAt: number;
  /** Samples where the device was playing something. */
  samples: number;
}

/** How far outside [pts, pts+interval] the heard time lies; 0 inside it. */
export function intervalDistance(heard: number, pts: number, interval: number): number {
  if (heard < pts) return pts - heard;
  if (heard > pts + interval) return heard - (pts + interval);
  return 0;
}

export class AvSim {
  readonly ref: SimRef = { t: 1_000_000 };
  readonly ctx: SimContext;
  readonly audio: AudioRenderer;
  readonly clock: Clock;
  readonly canvas: CanvasRenderer;
  readonly fps: number;
  readonly interval: number;

  /** Every frame the presentation loop put on screen. */
  presented: { t: number; pts: number; heard: number | null }[] = [];

  audioNext = 0;
  private videoNext = 0;
  private videoBudget = 0;
  audioFeeding = true;
  videoFeeding = true;
  duration: number;
  loop = false;
  decodeSpeed: number;
  audioCushion: number;
  private loopFlipPending = false;
  private playing = false;
  /** Held for buffering: the decoders run, the clock, sound and picture do not. */
  private holding = false;
  private readonly noAudio: boolean;

  constructor(opts: SimOptions = {}) {
    this.noAudio = opts.noAudio ?? false;
    this.fps = opts.fps ?? 24;
    this.interval = 1 / this.fps;
    this.duration = opts.duration ?? Infinity;
    this.decodeSpeed = opts.decodeSpeed ?? 4;
    this.audioCushion = opts.audioCushion ?? 0.8;

    vi.spyOn(performance, "now").mockImplementation(() => this.ref.t);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("document", {
      hidden: false,
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    this.ctx = new SimContext(this.ref, opts.outputLatency ?? 0.04, opts.ppm ?? 0);

    this.audio = new AudioRenderer();
    Object.assign(this.audio as unknown as object, {
      audioContext: this.ctx,
      gainNode: this.ctx.createGain(),
      isPlaying: true,
    });
    this.audio.setPreservePitch(false);

    this.clock = new Clock();
    this.canvas = new CanvasRenderer({} as HTMLCanvasElement);
    Object.assign(this.canvas as unknown as object, {
      isVideoConfigured: true,
      videoFrameRate: this.fps,
      samplePerformance: () => {},
      updateActiveSubtitle: () => {},
      renderSubtitles: () => {},
      drawFrame: (frame: FakeFrame) => {
        const heard = this.ctx.heardMedia();
        this.presented.push({ t: this.ref.t, pts: frame.timestamp / 1e6, heard });
        (this.canvas as unknown as { currentTime: number }).currentTime = frame.timestamp / 1e6;
      },
    });

    this.wire();
  }

  /**
   * How MoviPlayer connects the three. The only line of this rig that depends on
   * how the time source is plumbed.
   */
  private wire(): void {
    if (this.noAudio) {
      this.clock.setAudioProvider(null);
      this.canvas.setTimeSource(this.clock.timeSource, null);
      return;
    }
    this.clock.setAudioProvider(this.audio);
    this.canvas.setTimeSource(this.clock.timeSource, () => this.audio.hasHealthyBuffer());
  }

  /**
   * The sound ends for good while the picture goes on (a track shorter than the
   * file): the player says so, and stops feeding it.
   */
  endAudio(): void {
    this.audio.endOfStream();
    this.audioFeeding = false;
  }

  /**
   * Sound starts again at the clock's position: what the player does when it
   * rebuilds the audio at the playhead (a track switch, a re-read). The video
   * decoder is not touched.
   */
  restartAudioAtClock(): void {
    this.audio.reset();
    this.audio.clearEndOfStream();
    this.audioNext = Math.ceil(this.clock.getTime() / CHUNK_S) * CHUNK_S;
    this.audioFeeding = true;
  }

  /** What the picture is being held to right now. */
  clockTime(): number {
    return this.clock.getTime();
  }

  private get c(): Record<string, any> {
    return this.canvas as unknown as Record<string, any>;
  }

  get queueSize(): number {
    return this.canvas.getQueueSize();
  }

  /** Begin (or resume) playback the way MoviPlayer.play() does. */
  play(): void {
    if (!this.noAudio) void this.audio.play();
    this.clock.start();
    this.canvas.startPresentationLoop();
    this.playing = true;
  }

  /**
   * Stall the way MoviPlayer.enterStallBuffering() does: the clock, the sound
   * and the presentation loop stop together, and the decoders carry on.
   */
  holdForBuffering(): void {
    this.clock.pause();
    this.audio.suspendForBuffering();
    this.canvas.stopPresentationLoop();
    this.playing = false;
    this.holding = true;
  }

  /** The resume gate's side: pictures the clock has passed are dropped as they arrive. */
  get isHolding(): boolean {
    return this.holding;
  }

  /** Come out of a stall: sound, clock and picture start together. */
  resumeFromBuffering(): void {
    this.holding = false;
    this.audio.resumeFromBuffering();
    this.clock.start();
    this.canvas.startPresentationLoop();
    this.playing = true;
  }

  pause(): void {
    this.clock.pause();
    this.audio.pause();
    this.canvas.stopPresentationLoop();
    this.playing = false;
  }

  /**
   * A seek, as MoviPlayer does it: the audio and picture pipelines are flushed,
   * the clock is put at the target, and both decoders restart there (the picture
   * from the keyframe before it, with the frames ahead of the target dropped
   * before they reach the renderer).
   */
  seek(target: number): void {
    this.audio.reset();
    this.canvas.clearQueue();
    this.clock.seek(target);
    this.audioNext = target;
    this.videoNext = Math.floor(target * this.fps);
    this.videoBudget = 0;
    this.loopFlipPending = false;
  }

  /** Start playing from `target` with the decoders primed, as after a first play(). */
  start(target = 0): void {
    this.audioNext = target;
    this.videoNext = Math.floor(target * this.fps);
    this.clock.seek(target);
    this.service(0);
    this.play();
  }

  setRate(rate: number): void {
    this.clock.setPlaybackRate(rate);
    this.audio.setPlaybackRate(rate);
    this.canvas.setPlaybackRate(rate);
  }

  /** The main thread is busy: nothing runs, but the world carries on. */
  blockMainThread(ms: number): void {
    this.ref.t += ms;
  }

  /** The decoder side of one step: keep audio and picture topped up. */
  private service(dtMs: number): void {
    const audio = this.audio as unknown as { scheduleAudioBuffer(b: SimBuffer, t: number): void };
    let guard = 0;
    while (
      this.audioFeeding &&
      !this.noAudio &&
      this.audio.getBufferedDuration() < this.audioCushion &&
      guard++ < 400
    ) {
      if (this.audioNext >= this.duration) {
        if (!this.loop) break;
        this.audio.beginLoopPass();
        this.audioNext = 0;
        this.loopFlipPending = true;
      }
      const buf = new SimBuffer(2, CHUNK_FRAMES, SAMPLE_RATE);
      const left = new Float32Array(CHUNK_FRAMES);
      for (let i = 0; i < CHUNK_FRAMES; i++) left[i] = this.audioNext + i / SAMPLE_RATE;
      buf.copyToChannel(left, 0);
      buf.copyToChannel(left, 1);
      audio.scheduleAudioBuffer(buf, this.audioNext);
      this.audioNext += CHUNK_S;
    }

    if (this.loopFlipPending && !this.audio.isLoopSeamPending()) {
      // The picture turns over when the sound does, as the player does it.
      this.loopFlipPending = false;
      this.canvas.clearQueue();
      this.videoNext = 0;
      this.videoBudget = 0;
    }

    if (this.videoFeeding) {
      this.videoBudget += (this.decodeSpeed * this.fps * dtMs) / 1000;
      const queue = (this.c.frameQueue as FakeFrame[]);
      while (
        this.videoBudget >= 1 &&
        queue.length < 24 &&
        (this.loopFlipPending ? false : this.videoNext / this.fps < this.duration)
      ) {
        this.canvas.queueFrame(fakeFrame(this.videoNext / this.fps) as unknown as VideoFrame);
        this.videoNext++;
        this.videoBudget -= 1;
      }
      if (queue.length >= 24) this.videoBudget = Math.min(this.videoBudget, 1);
    }
    (this.audio as unknown as { pumpSchedule(): void }).pumpSchedule();
  }

  /** One display refresh: decoders run, then the presentation loop. */
  step(dtMs = VSYNC_MS): void {
    this.ref.t += dtMs;
    if (this.holding) {
      this.service(dtMs);
      this.canvas.discardLateFrames(this.clock.getTime());
      return;
    }
    if (!this.playing) return;
    this.service(dtMs);
    (this.canvas as unknown as { presentationTick(): void }).presentationTick();
  }

  /**
   * Advance `seconds`, measuring the picture against the sound at every refresh
   * from `measureFrom` seconds in. Samples taken while the device plays silence
   * are skipped: there is nothing to be out of step with.
   */
  run(seconds: number, measureFrom = 0): Window {
    const steps = Math.round((seconds * 1000) / VSYNC_MS);
    const skip = Math.round((measureFrom * 1000) / VSYNC_MS);
    let maxErr = 0;
    let worstAt = 0;
    let samples = 0;
    for (let i = 0; i < steps; i++) {
      this.step();
      if (i % 60 === 0) this.ctx.prune();
      if (i < skip) continue;
      const heard = this.ctx.heardMedia();
      const pts = this.canvas.getLastPresentedTime();
      if (heard === null || pts < 0) continue;
      samples++;
      const err = intervalDistance(heard, pts, this.interval);
      if (err > maxErr) {
        maxErr = err;
        worstAt = (i * VSYNC_MS) / 1000;
      }
    }
    return { maxErr, worstAt, samples };
  }
}

/**
 * Half a frame: the ITU-R BT.265 bound the time-source work is held to, plus
 * half a millisecond for the oracle itself (the media time is read back out of
 * float32 samples, and a 60fps frame on a 60Hz display sits exactly on the
 * bound by construction).
 */
export function halfFrame(fps: number): number {
  return 0.5 / fps + 0.0005;
}
