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
    mediaTimeAt: () => -1,
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

describe("Clock: one time source, no deadband", () => {
  it("reads the audio time source from the first reading", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => 10 }));
    clock.start();

    expect(clock.getTime()).toBe(10);
    expect(clock.isSyncedToAudio()).toBe(true);
  });

  it("follows the audio exactly, however small the difference from the wall clock", () => {
    // The old clock ran its own wall time and ignored any disagreement under
    // 100ms ("banked forever"), then corrected half of the rest. There is no
    // wall time to disagree with while the audio answers.
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    let audioTime = 0;
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => audioTime }));
    clock.start();
    clock.getTime();

    now.mockReturnValue(1_000);
    audioTime = 0.95; // 50ms behind the wall clock, under the old 100ms bar
    expect(clock.getTime()).toBeCloseTo(0.95, 9);

    now.mockReturnValue(2_000);
    audioTime = 1.8; // 200ms behind: not "half corrected" either
    expect(clock.getTime()).toBeCloseTo(1.8, 9);
  });

  it("passes the instant it is asked about through to the audio side", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(4_321);
    const asked: number[] = [];
    const clock = new Clock();
    clock.setAudioProvider(
      fakeAudio({
        mediaTimeAt: (t) => {
          asked.push(t);
          return 7;
        },
      }),
    );
    clock.start();
    clock.getTime();
    expect(asked.at(-1)).toBe(4_321);
  });

  it("carries on from the last heard time when the audio goes away, without a jump", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    let audioTime = 10;
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => audioTime }));
    clock.start();
    expect(clock.getTime()).toBe(10);

    now.mockReturnValue(500);
    expect(clock.getTime()).toBe(10); // still the sound
    audioTime = -1; // the sound is gone (track ended, context refused)
    now.mockReturnValue(1_000); // the last read was at 500ms
    expect(clock.getTime()).toBeCloseTo(10.5, 6);
    expect(clock.isSyncedToAudio()).toBe(false);

    now.mockReturnValue(1_700);
    expect(clock.getTime()).toBeCloseTo(11.2, 6);
  });

  it("takes the audio's value when it answers again", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    let audioTime = -1;
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => audioTime }));
    clock.seek(5);
    clock.start();

    now.mockReturnValue(2_000);
    expect(clock.getTime()).toBeCloseTo(7, 6); // wall clock from the seek

    audioTime = 7.05; // what is actually being heard
    expect(clock.getTime()).toBeCloseTo(7.05, 9);
    expect(clock.isSyncedToAudio()).toBe(true);
    now.mockReturnValue(2_500);
    audioTime = 7.55;
    expect(clock.getTime()).toBeCloseTo(7.55, 9);
  });

  it("setAudioProvider(null) continues the wall clock from the last audio time", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => 10 }));
    clock.start();
    clock.getTime();
    expect(clock.isSyncedToAudio()).toBe(true);

    clock.setAudioProvider(null);
    expect(clock.isSyncedToAudio()).toBe(false);

    now.mockReturnValue(400);
    expect(clock.getTime()).toBeCloseTo(10.4, 6);
  });

  it("exposes the same time source the renderer reads", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => 33 }));
    clock.start();
    expect(clock.timeSource.now()).toBe(33);
    expect(clock.getTime()).toBe(33);
  });

  it("holds the audio time through a pause and does not read the audio meanwhile", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const mediaTimeAt = vi.fn(() => 12);
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ mediaTimeAt }));
    clock.start();
    clock.pause();
    expect(clock.getTime()).toBe(12);
    const calls = mediaTimeAt.mock.calls.length;
    now.mockReturnValue(9_000);
    expect(clock.getTime()).toBe(12);
    expect(mediaTimeAt.mock.calls.length).toBe(calls);
  });
});

describe("Clock.getVideoSyncTime — the same reading as getTime", () => {
  it("returns the audio time", () => {
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => 7 }));
    clock.start();
    expect(clock.getVideoSyncTime()).toBe(7);
  });

  it("falls back to the wall clock when audio has no valid reading yet", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => -1 }));
    clock.start();

    now.mockReturnValue(700);
    expect(clock.getVideoSyncTime()).toBeCloseTo(0.7, 6);
  });

  it("returns the paused time while not running, ignoring the audio provider", () => {
    const clock = new Clock();
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => 55 }));
    clock.seek(3);
    expect(clock.getVideoSyncTime()).toBe(3);
  });

  it("clamps the wall-clock fallback to duration", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const clock = new Clock();
    clock.setDuration(2);
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => -1 }));
    clock.start();

    now.mockReturnValue(9_000);
    expect(clock.getVideoSyncTime()).toBe(2);
  });

  it("does not clamp the sound to the duration: it is what is being played", () => {
    const clock = new Clock();
    clock.setDuration(2);
    clock.setAudioProvider(fakeAudio({ mediaTimeAt: () => 2.4 }));
    clock.start();
    expect(clock.getVideoSyncTime()).toBe(2.4);
  });
});
