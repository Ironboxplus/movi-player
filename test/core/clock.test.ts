import { afterEach, describe, expect, it, vi } from "vitest";
import { Clock, type AudioClockProvider } from "../../src/core/Clock";

/**
 * Clock.ts had 18.07% line / 5% branch coverage — essentially only touched
 * incidentally through MoviPlayer-level tests. It's pure logic (no WASM, no
 * network, no worker) driven entirely by `performance.now()`, so every
 * branch here is directly and deterministically testable by controlling
 * that one input — same `vi.spyOn(performance, "now")` pattern already used
 * by canvas-renderer-clock.test.ts.
 */

function fakeAudio(overrides: Partial<AudioClockProvider> = {}): AudioClockProvider {
  return {
    getAudioClock: () => -1,
    hasHealthyBuffer: () => true,
    isAudioPlaying: () => true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Clock: wall-clock basics", () => {
  it("stays at 0 before start() and reports paused time while not running", () => {
    const clock = new Clock();
    expect(clock.getTime()).toBe(0);
    expect(clock.isPlaying()).toBe(false);
  });

  it("advances in real time once started, at 1x", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1_000);
    const clock = new Clock();
    clock.start();

    now.mockReturnValue(1_500); // +500ms
    expect(clock.getTime()).toBeCloseTo(0.5, 6);
  });

  it("freezes at the paused time on pause() and resumes from there", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.start();

    now.mockReturnValue(2_000); // 2s elapsed
    clock.pause();
    expect(clock.getTime()).toBeCloseTo(2, 6);

    // Time passes while paused — must not leak into the reported time.
    now.mockReturnValue(5_000);
    expect(clock.getTime()).toBeCloseTo(2, 6);

    clock.start();
    now.mockReturnValue(5_300); // +300ms since resume
    expect(clock.getTime()).toBeCloseTo(2.3, 6);
  });

  it("start() while already running is a no-op (does not re-anchor)", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.start();

    now.mockReturnValue(1_000);
    clock.start(); // already running
    now.mockReturnValue(1_000);
    expect(clock.getTime()).toBeCloseTo(1, 6);
  });

  it("pause() while already paused is a no-op", () => {
    const clock = new Clock();
    clock.pause(); // never started
    expect(clock.getTime()).toBe(0);
    expect(clock.isPlaying()).toBe(false);
  });

  it("seek() while running re-anchors the wall clock to the new time", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.start();
    now.mockReturnValue(1_000);

    clock.seek(42);
    expect(clock.getTime()).toBeCloseTo(42, 6);

    now.mockReturnValue(1_500); // +500ms after the seek
    expect(clock.getTime()).toBeCloseTo(42.5, 6);
  });

  it("seek() while paused just sets the paused time directly", () => {
    const clock = new Clock();
    clock.seek(10);
    expect(clock.getTime()).toBe(10);
    expect(clock.isPlaying()).toBe(false);
  });

  it("reset() clears rate, duration, audio-sync latch and both time anchors", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.setDuration(100);
    clock.setPlaybackRate(2);
    clock.start();
    now.mockReturnValue(1_000);

    clock.reset();

    expect(clock.getTime()).toBe(0);
    expect(clock.isPlaying()).toBe(false);
    expect(clock.getPlaybackRate()).toBe(1);
    expect(clock.isSyncedToAudio()).toBe(false);
  });
});

describe("Clock: duration clamping", () => {
  it("clamps getTime() to duration once the wall clock would exceed it", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.setDuration(5);
    clock.start();

    now.mockReturnValue(4_000); // 4s: under duration
    expect(clock.getTime()).toBeCloseTo(4, 6);

    now.mockReturnValue(10_000); // 10s: past duration
    expect(clock.getTime()).toBe(5);
  });

  it("does not clamp when duration is unset (0)", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.start();

    now.mockReturnValue(999_000); // absurdly long, but no duration set
    expect(clock.getTime()).toBeCloseTo(999, 6);
  });
});

describe("Clock: playback rate", () => {
  it("setPlaybackRate() preserves the current time across the rate change", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.start();
    now.mockReturnValue(2_000); // at t=2s, 1x

    clock.setPlaybackRate(2);
    expect(clock.getPlaybackRate()).toBe(2);
    // No wall-clock time has passed at the instant of the rate change.
    expect(clock.getTime()).toBeCloseTo(2, 6);

    now.mockReturnValue(3_000); // +1000ms real time, at 2x => +2s media time
    expect(clock.getTime()).toBeCloseTo(4, 6);
  });
});

describe("Clock: audio-sync drift correction", () => {
  it("hard-syncs to the audio clock on the first healthy reading", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const audio = fakeAudio({ getAudioClock: () => 10, hasHealthyBuffer: () => true });
    const clock = new Clock();
    clock.setAudioProvider(audio);
    clock.start();

    expect(clock.getTime()).toBe(10);
    expect(clock.isSyncedToAudio()).toBe(true);
  });

  it("ignores audio while its buffer is unhealthy and uses the wall clock instead", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const audio = fakeAudio({ getAudioClock: () => 99, hasHealthyBuffer: () => false });
    const clock = new Clock();
    clock.setAudioProvider(audio);
    clock.start();

    now.mockReturnValue(500); // +0.5s wall clock
    expect(clock.getTime()).toBeCloseTo(0.5, 6);
    expect(clock.isSyncedToAudio()).toBe(false);
  });

  it("ignores a negative audio clock reading (not yet available)", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const audio = fakeAudio({ getAudioClock: () => -1 });
    const clock = new Clock();
    clock.setAudioProvider(audio);
    clock.start();

    now.mockReturnValue(300);
    expect(clock.getTime()).toBeCloseTo(0.3, 6);
  });

  it("applies only 50% gradual correction for drift within small-but-over-threshold range", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    let audioTime = 0;
    const audio = fakeAudio({ getAudioClock: () => audioTime, hasHealthyBuffer: () => true });
    const clock = new Clock();
    clock.setAudioProvider(audio);
    clock.start();
    clock.getTime(); // consumes the first-call hard sync (to audioTime=0)

    // Wall clock advances 1.0s (playbackRate=1) while audio only advanced to
    // 0.8s — 200ms of drift, over the 100ms correction threshold.
    now.mockReturnValue(1_000);
    audioTime = 0.8;
    const corrected = clock.getTime();
    // Wall clock alone would read 1.0s; 50% correction toward the 0.2s drift
    // pulls it to 0.9s, not all the way to 0.8s.
    expect(corrected).toBeCloseTo(0.9, 2);
  });

  it("does not correct drift within the 100ms threshold", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    let audioTime = 0;
    const audio = fakeAudio({ getAudioClock: () => audioTime, hasHealthyBuffer: () => true });
    const clock = new Clock();
    clock.setAudioProvider(audio);
    clock.start();
    clock.getTime(); // consumes the first-call hard sync (to audioTime=0)

    now.mockReturnValue(1_000);
    audioTime = 0.95; // 50ms drift — under the 100ms threshold
    expect(clock.getTime()).toBeCloseTo(1.0, 6);
  });

  it("setAudioProvider(null) drops the sync latch and falls back to wall clock only", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const audio = fakeAudio({ getAudioClock: () => 10, hasHealthyBuffer: () => true });
    const clock = new Clock();
    clock.setAudioProvider(audio);
    clock.start();
    clock.getTime(); // triggers the hard sync — sync only happens inside getTime()
    expect(clock.isSyncedToAudio()).toBe(true);

    clock.setAudioProvider(null);
    expect(clock.isSyncedToAudio()).toBe(false);

    // setAudioProvider(null) only clears the latch — it does not re-anchor
    // baseTime, so the wall clock keeps counting up from where the hard
    // sync left it (audio 10s at wall-clock 0), not from 0.
    now.mockReturnValue(400);
    expect(clock.getTime()).toBeCloseTo(10.4, 6);
  });
});

describe("Clock.getVideoSyncTime — always prefers audio when a valid reading exists", () => {
  it("returns the audio clock when healthy", () => {
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ getAudioClock: () => 7, hasHealthyBuffer: () => true }));
    clock.start();
    expect(clock.getVideoSyncTime()).toBe(7);
  });

  it("still returns the (clamped) audio clock even when the buffer is unhealthy, as long as it's non-negative", () => {
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ getAudioClock: () => 3, hasHealthyBuffer: () => false }));
    clock.start();
    expect(clock.getVideoSyncTime()).toBe(3);
  });

  it("falls back to the wall clock when audio has no valid reading yet", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ getAudioClock: () => -1 }));
    clock.start();

    now.mockReturnValue(700);
    expect(clock.getVideoSyncTime()).toBeCloseTo(0.7, 6);
  });

  it("returns the paused time while not running, ignoring the audio provider", () => {
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ getAudioClock: () => 55 }));
    clock.seek(3);
    expect(clock.getVideoSyncTime()).toBe(3);
  });

  it("clamps the wall-clock fallback to duration", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.setDuration(2);
    clock.setAudioProvider(fakeAudio({ getAudioClock: () => -1 }));
    clock.start();

    now.mockReturnValue(9_000);
    expect(clock.getVideoSyncTime()).toBe(2);
  });
});
