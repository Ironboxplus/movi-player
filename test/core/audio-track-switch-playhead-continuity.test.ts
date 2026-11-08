import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioTrack, VideoTrack } from "../../src/types";
import type { Clock } from "../../src/core/Clock";
import type { AudioRenderer } from "../../src/render/AudioRenderer";
import type { PCMFrame } from "../../src/decode/SoftwareAudioDecoder";
import { stubBrowserGlobals } from "../helpers/browser-globals";

vi.mock("../../dist/wasm/movi.js", () => ({ default: vi.fn(async () => ({})) }));
vi.mock("dashjs", () => ({ MediaPlayer: vi.fn() }));
vi.mock("shaka-player/dist/shaka-player.compiled", () => ({
  default: {
    Player: { isBrowserSupported: vi.fn(() => false) },
    polyfill: { installAll: vi.fn() },
    net: { NetworkingEngine: { RequestType: { LICENSE: 1 } } },
  },
}));

/**
 * The playhead through an audio track switch (docs/PLAN_MOVI_PIPELINE.md P4):
 * continuous, with no step back and no step forward, while the picture goes
 * on playing on the wall clock. Real Clock, real AudioRenderer and the real
 * audioTrackChange handler; the Web Audio context, the demuxer and the new
 * decoder's output are stood in for, exactly as the other track-switch files
 * do. What the refresh seek delivers is what the real one does: audio from
 * before the playhead first, then the frames at it.
 *
 * Black-box readings this guards against (real media, before the refresh
 * seek): 1009.385s -> 1101.730s, 5341.241s -> 5380.545s, 3732.441s ->
 * 3756.080s — always forward, by however far the forward scan had got.
 */
const videoTrack: VideoTrack = {
  id: 1,
  type: "video",
  codec: "h264",
  width: 1920,
  height: 1080,
  frameRate: 24,
};
const flacTrack: AudioTrack = {
  id: 2,
  type: "audio",
  codec: "flac",
  channels: 2,
  sampleRate: 48_000,
};
const aacTrack: AudioTrack = {
  id: 3,
  type: "audio",
  codec: "aac",
  channels: 2,
  sampleRate: 48_000,
};

class FakeAudioBuffer {
  readonly duration: number;
  private data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  copyToChannel(source: Float32Array, channel: number): void {
    this.data[channel].set(source);
  }
  getChannelData(channel: number): Float32Array {
    return this.data[channel];
  }
}
class FakeSource {
  buffer: FakeAudioBuffer | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  stop = vi.fn();
  start(): void {}
}
class FakeGain {
  gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
}
class FakeAudioContext {
  currentTime = 0;
  state = "running";
  destination = { maxChannelCount: 2 };
  createGain(): FakeGain {
    return new FakeGain();
  }
  createDynamicsCompressor(): FakeGain {
    return new FakeGain();
  }
  createBuffer(channels: number, frames: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, frames, sampleRate);
  }
  createBufferSource(): FakeSource {
    return new FakeSource();
  }
}

const FRAME_SAMPLES = 4_800; // 0.1s at 48kHz
const FRAME_DURATION = FRAME_SAMPLES / 48_000;

function makeFrame(timestampSeconds: number): PCMFrame {
  return {
    planes: [new Float32Array(FRAME_SAMPLES), new Float32Array(FRAME_SAMPLES)],
    numberOfFrames: FRAME_SAMPLES,
    numberOfChannels: 2,
    sampleRate: 48_000,
    timestamp: Math.round(timestampSeconds * 1_000_000),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("audio track switch: the playhead is continuous", () => {
  for (const startMediaTime of [1009.385, 3732.441]) {
    it(`never steps back or forward, from ${startMediaTime}s`, async () => {
      stubBrowserGlobals();
      const nowSpy = vi.spyOn(performance, "now");
      let wallNow = 0;
      nowSpy.mockReturnValue(0);

      const { MoviPlayer } = await import("../../src/core/MoviPlayer");
      const { MoviAudioDecoder } = await import("../../src/decode/AudioDecoder");
      vi.spyOn(MoviAudioDecoder.prototype, "configure").mockResolvedValue(true);
      const player = new MoviPlayer({});
      const internals = player as unknown as {
        clock: Clock;
        audioRenderer: AudioRenderer;
        demuxer: unknown;
        renderDecodedPCM: (f: PCMFrame) => void;
      };
      const { clock, audioRenderer } = internals;

      const ctx = new FakeAudioContext();
      Object.assign(audioRenderer as unknown as Record<string, unknown>, {
        audioContext: ctx,
        gainNode: ctx.createGain(),
        isPlaying: true,
      });
      const demuxerSeek = vi.fn(async () => {});
      internals.demuxer = {
        seek: demuxerSeek,
        getBindings: () => undefined,
        getExtradata: () => undefined,
      };

      player.trackManager.setTracks([videoTrack, flacTrack, aacTrack]);
      player.trackManager.selectAudioTrack(flacTrack.id);
      clock.start();
      const advance = (seconds: number) => {
        wallNow += seconds;
        ctx.currentTime += seconds;
        nowSpy.mockReturnValue(wallNow * 1000);
      };

      // Steady playback on the first track.
      for (let i = 0; i < 5; i++) {
        internals.renderDecodedPCM(makeFrame(startMediaTime + i * FRAME_DURATION));
      }
      expect(player.getCurrentTime()).toBeCloseTo(startMediaTime, 3);
      advance(0.3);

      // Every reading from here on is checked against the one before: wall
      // time passes at 1x, so a continuous playhead moves by exactly what the
      // wall did, give or take the half-frame the audio anchor may add.
      let last = player.getCurrentTime();
      const step = (wallDelta: number, what: string) => {
        advance(wallDelta);
        const now = player.getCurrentTime();
        expect(now, what).toBeGreaterThanOrEqual(last - 1e-6);
        expect(now - last, what).toBeLessThan(wallDelta + 0.12);
        last = now;
      };

      player.trackManager.selectAudioTrack(aacTrack.id);
      // The refresh seek went to a second before the playhead.
      expect(demuxerSeek).toHaveBeenCalledTimes(1);
      expect(demuxerSeek.mock.calls[0][0]).toBeCloseTo(last - 1, 1);
      step(0, "right after the switch");

      // The new decoder starting up: no sound, the picture on the wall clock.
      step(0.2, "while the new decoder starts");
      await new Promise((resolve) => setTimeout(resolve, 0));

      // What the re-read delivers first: audio from before the playhead, a
      // second's worth, decoded at once. None of it may move the playhead.
      const playheadAtArrival = player.getCurrentTime();
      for (let t = playheadAtArrival - 1; t < playheadAtArrival - 1e-6; t += FRAME_DURATION) {
        internals.renderDecodedPCM(makeFrame(t));
        step(0, `old audio at ${t.toFixed(2)}s`);
      }

      // …and then the first frames at it. The sound joins; the playhead goes
      // on from where it was.
      let t = Math.ceil(playheadAtArrival / FRAME_DURATION) * FRAME_DURATION;
      for (let i = 0; i < 6; i++, t += FRAME_DURATION) {
        internals.renderDecodedPCM(makeFrame(t));
        step(0.05, `joined audio at ${t.toFixed(2)}s`);
      }
      // The decoder keeps delivering, as a real one does: a clock that is the
      // sound holds where the sound stops, so a test that stopped feeding it
      // after 0.6s would be asserting that silence moves the playhead.
      for (let i = 0; i < 20; i++) {
        // One 0.1s frame per two 0.05s steps keeps the sound just ahead.
        if (i % 2 === 0) {
          internals.renderDecodedPCM(makeFrame(t));
          t += FRAME_DURATION;
        }
        step(0.05, "steady after the switch");
      }

      // A playhead that never fell back or ran ahead also ends where the wall
      // clock says it should: 0.3 + 0.2 + 0.3 + 1.0s after the first reading.
      expect(last).toBeCloseTo(startMediaTime + 0.3 + 0.2 + 0.3 + 1.0, 0);
    }, 20_000);
  }
});
