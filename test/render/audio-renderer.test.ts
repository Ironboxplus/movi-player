import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioRenderer } from "../../src/render/AudioRenderer";
import type { PCMFrame } from "../../src/decode/SoftwareAudioDecoder";

vi.mock("../../dist/wasm/movi.js", () => ({ default: vi.fn(async () => ({})) }));

class FakeAudioBuffer {
  readonly duration: number;
  private data: Float32Array[];

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
    this.data[channel].set(source, offset);
  }

  getChannelData(channel: number): Float32Array {
    return this.data[channel];
  }
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

    const scheduled = ctx.sources.filter((source) => source.buffer);
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

    const scheduled = ctx.sources.filter((source) => source.buffer);
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

    const scheduled = ctx.sources.filter((source) => source.buffer);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0].buffer?.length).toBe(40);
    expect(scheduled[1].buffer?.length).toBe(2048);
  });

  it("timer-flushes a short trailing PCM batch", () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    renderer.renderPCM(makePCMFrame(0));
    expect(ctx.sources.filter((source) => source.buffer)).toHaveLength(0);

    vi.advanceTimersByTime(25);

    const scheduled = ctx.sources.filter((source) => source.buffer);
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

    expect(ctx.sources.filter((source) => source.buffer)).toHaveLength(0);
    expect((renderer as any).pendingPCM).toBeNull();
  });

  it("discards pending PCM when playback rate changes", () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    renderer.renderPCM(makePCMFrame(0));
    renderer.setPlaybackRate(1.25);
    vi.advanceTimersByTime(25);

    expect(ctx.sources.filter((source) => source.buffer)).toHaveLength(0);
    expect((renderer as any).pendingPCM).toBeNull();
  });

  it("clears pending PCM and its timer on reset", () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const renderer = makeRenderer(ctx);

    renderer.renderPCM(makePCMFrame(0));
    renderer.reset();
    vi.advanceTimersByTime(25);

    expect(ctx.sources.filter((source) => source.buffer)).toHaveLength(0);
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
