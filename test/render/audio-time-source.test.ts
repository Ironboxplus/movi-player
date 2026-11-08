import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioRenderer } from "../../src/render/AudioRenderer";
import { SAMPLE_RATE, SimBuffer, SimContext, type SimRef } from "../helpers/av-sim";

vi.mock("../../dist/wasm/movi.js", () => ({ default: vi.fn(async () => ({})) }));

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * AudioRenderer as the time source: the list of what was scheduled, and the
 * playhead looked up in it (Chromium's AudioClock and TimeSource,
 * media/audio/audio_clock.cc, media/base/time_source.h).
 */

const LATENCY = 0.05;

function rig(opts: { ppm?: number; outputTimestamp?: boolean } = {}) {
  const ref: SimRef = { t: 500_000 };
  vi.spyOn(performance, "now").mockImplementation(() => ref.t);
  const ctx = new SimContext(ref, LATENCY, opts.ppm ?? 0);
  if (opts.outputTimestamp === false) {
    // A browser without getOutputTimestamp(): the fallback is currentTime
    // minus the reported outputLatency.
    (ctx as unknown as Record<string, unknown>).getOutputTimestamp = undefined;
    (ctx as unknown as Record<string, unknown>).outputLatency = LATENCY;
  }
  const audio = new AudioRenderer();
  Object.assign(audio as unknown as object, {
    audioContext: ctx,
    gainNode: ctx.createGain(),
    isPlaying: true,
  });
  audio.setPreservePitch(false);

  const schedule = (mediaStart: number, seconds = 0.02) => {
    const frames = Math.round(seconds * SAMPLE_RATE);
    const buf = new SimBuffer(2, frames, SAMPLE_RATE);
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = mediaStart + i / SAMPLE_RATE;
    buf.copyToChannel(ch, 0);
    buf.copyToChannel(ch, 1);
    (audio as unknown as { scheduleAudioBuffer(b: SimBuffer, t: number): void }).scheduleAudioBuffer(
      buf,
      mediaStart,
    );
  };
  /** Feed contiguous media up to `to`, 20ms at a time, from where `from` starts. */
  const feed = (from: number, to: number) => {
    for (let t = from; t < to - 1e-9; t += 0.02) schedule(t);
  };
  const advance = (ms: number) => {
    ref.t += ms;
  };
  /** The decoder keeping half a second ahead of the device while `ms` pass. */
  const media = { next: 0 };
  const playFor = (ms: number, from?: number) => {
    if (from !== undefined) media.next = from;
    for (let left = ms; left > 0; left -= 20) {
      ref.t += Math.min(20, left);
      while (
        (audio as unknown as { scheduledTime: number }).scheduledTime - ctx.currentTime <
        0.5
      ) {
        schedule(media.next);
        media.next += 0.02;
      }
      if (Math.round(ref.t / 20) % 500 === 0) ctx.prune();
    }
  };
  const segments = () =>
    (audio as unknown as { _segments: { ctxStart: number; ctxEnd: number; mediaStart: number; rate: number }[] })
      ._segments;
  return { ref, ctx, audio, schedule, feed, advance, playFor, segments };
}

describe("mediaTimeAt: the playhead looked up in what was scheduled", () => {
  it("is -1 until something is scheduled", () => {
    const { audio, ref } = rig();
    expect(audio.mediaTimeAt(ref.t)).toBe(-1);
  });

  it("holds at the start of the first segment until the sound is audible", () => {
    const { audio, ref, feed, advance } = rig();
    feed(100, 100.5);
    // Scheduled a little ahead of now; the playhead is still short of it, and
    // short of it by the output latency on top.
    expect(audio.mediaTimeAt(ref.t)).toBe(100);
    advance(30);
    expect(audio.mediaTimeAt(ref.t)).toBe(100);
  });

  it("then counts media at the playback rate, with the output latency inside the playhead", () => {
    const { audio, ref, ctx, feed, advance } = rig();
    feed(100, 100.5);
    const start = (audio as unknown as { _segments: { ctxStart: number }[] })._segments[0].ctxStart;
    // Play until the device reaches the segment start plus a known distance.
    while (ctx.raw() - LATENCY < start + 0.2) advance(1);
    const expected = 100 + (ctx.raw() - LATENCY - start);
    expect(audio.mediaTimeAt(ref.t)).toBeCloseTo(expected, 5);
    expect(audio.mediaTimeAt(ref.t)).toBeGreaterThan(100.19);
  });

  it("answers for the instant it is given, not for the instant it is called", () => {
    const { audio, ref, feed, advance } = rig();
    feed(100, 101);
    advance(300);
    const now = audio.mediaTimeAt(ref.t);
    expect(audio.mediaTimeAt(ref.t + 100) - now).toBeCloseTo(0.1, 5);
    expect(now - audio.mediaTimeAt(ref.t - 100)).toBeCloseTo(0.1, 5);
  });

  it.each([100, -100])(
    "agrees with the device's own clock at %ippm off performance.now(), for twenty minutes",
    (ppm) => {
      // The pair {contextTime, performanceTime} is re-read on every call, so a
      // hardware clock running fast or slow is simply a different pair: after
      // twenty minutes nothing has accumulated (the hour is the simulation's).
      const { audio, ref, ctx, playFor } = rig({ ppm });
      playFor(1000, 0);
      let worst = 0;
      for (let s = 0; s < 1200; s++) {
        playFor(1000);
        const heard = ctx.heardMedia();
        if (heard === null) continue;
        worst = Math.max(worst, Math.abs(audio.mediaTimeAt(ref.t) - heard));
      }
      expect(worst).toBeLessThan(0.001);
    },
    60_000,
  );

  it("keeps the list short over an hour of continuous playback", () => {
    const { playFor, segments } = rig();
    playFor(3600 * 1000, 0);
    expect(segments().length).toBeLessThan(10);
  }, 60_000);

  describe("holes", () => {
    it("holds at the end of the last segment across an underrun, and picks up at the next", () => {
      const { audio, ref, ctx, feed, schedule, advance, segments } = rig();
      feed(100, 100.2);
      // Play it all out, and 300ms of silence beyond.
      const end = segments()[0].ctxEnd;
      while (ctx.raw() - LATENCY < end + 0.3) advance(1);
      expect(audio.mediaTimeAt(ref.t)).toBeCloseTo(100.2, 3);

      // The decoder delivers again: contiguous media, placed after the hole.
      schedule(100.2);
      expect(audio.mediaTimeAt(ref.t)).toBeCloseTo(100.2, 3); // still holding
      const next = segments().at(-1)!;
      while (ctx.raw() - LATENCY < next.ctxStart + 0.01) advance(1);
      expect(audio.mediaTimeAt(ref.t)).toBeGreaterThan(100.2);
      // No media was consumed by the hole: nothing skipped, nothing counted twice.
      expect(audio.mediaTimeAt(ref.t)).toBeLessThan(100.2 + 0.03);
    });

    it("lets the media run through a gap in the PTS: silence that stands for media", () => {
      const { audio, ref, ctx, schedule, advance, segments } = rig();
      schedule(10); // 10.00 - 10.02
      schedule(10.52); // the file's sound has a half second hole here
      // The silence stands for the media between them, so it advances at the
      // playback rate — which makes it one straight line with what is either
      // side of it, and one segment.
      expect(segments().length).toBe(1);
      const first = segments()[0];
      while (ctx.raw() - LATENCY < first.ctxStart + 0.27) advance(1);
      // Half way through the hole the picture is half way through it too.
      expect(audio.mediaTimeAt(ref.t)).toBeCloseTo(10.27, 2);
    });
  });

  describe("the end of the sound", () => {
    it("holds at the last sample while more may come", () => {
      const { audio, ref, ctx, feed, advance, segments } = rig();
      feed(100, 100.2);
      while (ctx.raw() - LATENCY < segments()[0].ctxEnd + 1) advance(10);
      expect(audio.mediaTimeAt(ref.t)).toBeCloseTo(100.2, 3);
    });

    it("reports no clock once the player says it is over and the playhead has reached it", () => {
      const { audio, ref, ctx, feed, advance, segments } = rig();
      feed(100, 100.2);
      audio.endOfStream();
      expect(audio.mediaTimeAt(ref.t)).toBeGreaterThanOrEqual(100); // still playing it out
      while (ctx.raw() - LATENCY < segments()[0].ctxEnd + 0.05) advance(5);
      // …after which the time source carries on without it.
      expect(audio.mediaTimeAt(ref.t)).toBe(-1);
    });
  });

  describe("suspending", () => {
    it("holds the playhead for a suspend we asked for", async () => {
      const { audio, ref, ctx, feed, advance } = rig();
      feed(100, 101);
      advance(300);
      audio.pause(); // suspends the context on purpose
      await Promise.resolve();
      expect(ctx.state).toBe("suspended");
      const held = audio.mediaTimeAt(ref.t);
      expect(held).toBeGreaterThan(100);
      advance(5000);
      expect(audio.mediaTimeAt(ref.t)).toBe(held);

      await audio.play();
      expect(ctx.state).toBe("running");
      advance(100);
      // A suspended context reports currentTime (a render quantum, 2.7ms, at its
      // coarsest); a running one reports the exact output position.
      expect(audio.mediaTimeAt(ref.t)).toBeCloseTo(held + 0.1, 2);
    });

    it("is not a clock at all when the browser is keeping the context suspended", async () => {
      const { audio, ref, ctx, feed } = rig();
      feed(100, 101);
      await audio.play(); // clears any suspend intent a previous test left
      ctx.state = "suspended"; // autoplay refused: nobody asked for this
      expect(audio.mediaTimeAt(ref.t)).toBe(-1);
    });
  });

  describe("a browser without getOutputTimestamp()", () => {
    it("uses currentTime minus the output latency", () => {
      const { audio, ref, ctx, feed, advance, segments } = rig({ outputTimestamp: false });
      feed(100, 100.5);
      while (ctx.currentTime - LATENCY < segments()[0].ctxStart + 0.2) advance(1);
      const expected = 100 + (ctx.currentTime - LATENCY - segments()[0].ctxStart);
      expect(audio.mediaTimeAt(ref.t)).toBeCloseTo(expected, 3);
    });
  });

  describe("rate changes", () => {
    it("write the new rate into new segments and keep the old rate for what already played", () => {
      const { audio, ref, ctx, feed, advance, segments } = rig();
      feed(100, 101); // 1s of media at 1x
      advance(500);
      const before = audio.mediaTimeAt(ref.t);

      audio.setPlaybackRate(2);
      // Nothing about the heard past changed.
      expect(audio.mediaTimeAt(ref.t)).toBeCloseTo(before, 6);

      // Reclaimed buffers are rescheduled behind the one playing, at 2x: the
      // media they cover takes half the context time.
      (audio as unknown as { pumpSchedule(): void }).pumpSchedule();
      const rates = segments().map((s) => s.rate);
      expect(rates[0]).toBeCloseTo(1, 6);
      expect(rates.at(-1)).toBeCloseTo(2, 6);

      // And the clock runs at 2x from there on, continuously.
      const seam = segments().find((s) => Math.abs(s.rate - 2) < 1e-6)!;
      while (ctx.raw() - LATENCY < seam.ctxStart) advance(1);
      const atSeam = audio.mediaTimeAt(ref.t);
      advance(100);
      expect(audio.mediaTimeAt(ref.t) - atSeam).toBeCloseTo(0.2, 3);
    });

    it("can be made while paused without re-scaling the history", async () => {
      // The old anchor arithmetic read the whole span since the anchor at the
      // CURRENT rate: pause after 6.8s at 1x, change to 0.25x, and the clock
      // jumped back to anchor + 6.8 * 0.25.
      const { audio, ref, playFor } = rig();
      playFor(6900, 100);
      audio.pause();
      await Promise.resolve();
      const paused = audio.mediaTimeAt(ref.t);
      expect(paused).toBeGreaterThan(106);

      audio.setPlaybackRate(0.25);
      expect(audio.mediaTimeAt(ref.t)).toBeCloseTo(paused, 6);
    });
  });

  describe("wallClockTimeFor: when is this media time heard", () => {
    it("inverts mediaTimeAt inside the scheduled range", () => {
      const { audio, ref, feed, advance } = rig();
      feed(100, 102);
      advance(300);
      const heardNow = audio.mediaTimeAt(ref.t);
      expect(audio.wallClockTimeFor(heardNow)!).toBeCloseTo(ref.t, 3);
      // 0.5s of media from now is 500ms of wall time from now, at 1x.
      expect(audio.wallClockTimeFor(heardNow + 0.5)! - ref.t).toBeCloseTo(500, 2);
      // …and a media time already heard is in the past.
      expect(audio.wallClockTimeFor(heardNow - 0.1)! - ref.t).toBeCloseTo(-100, 2);
    });

    it("extrapolates beyond the buffered audio at the playback rate", () => {
      const { audio, ref, ctx, feed, advance, segments } = rig();
      feed(100, 100.5);
      advance(100);
      void ctx;
      const endCtx = segments().at(-1)!.ctxEnd;
      const atEnd = audio.wallClockTimeFor(100.5)!;
      // Two seconds past the end of what is buffered.
      expect(audio.wallClockTimeFor(102.5)! - atEnd).toBeCloseTo(2000, 2);
      expect(endCtx).toBeGreaterThan(0);
    });

    it("is null with nothing scheduled", () => {
      const { audio } = rig();
      expect(audio.wallClockTimeFor(5)).toBeNull();
    });

    it("says whether time is moving", async () => {
      const { audio, feed } = rig();
      expect(audio.isTimeMoving()).toBe(false);
      feed(100, 100.5);
      expect(audio.isTimeMoving()).toBe(true);
      audio.pause();
      expect(audio.isTimeMoving()).toBe(false);
    });
  });

  describe("a gapless loop", () => {
    it("is pending until the output reaches the new pass, whose media time starts over", () => {
      const { audio, ref, ctx, schedule, advance, segments } = rig();
      // One pass of 0.4s of media: 20..20.4.
      for (let t = 20; t < 20.4 - 1e-9; t += 0.02) schedule(t);
      audio.beginLoopPass();
      expect(audio.isLoopSeamPending()).toBe(true);
      for (let t = 0; t < 0.4 - 1e-9; t += 0.02) schedule(t); // the next pass
      expect(audio.isLoopSeamPending()).toBe(true);

      const seam = segments().find((s) => s.mediaStart === 0)!;
      while (ctx.raw() - LATENCY < seam.ctxStart - 0.01) advance(1);
      expect(audio.isLoopSeamPending()).toBe(true);
      expect(audio.mediaTimeAt(ref.t)).toBeGreaterThan(20.3);

      advance(30);
      expect(audio.isLoopSeamPending()).toBe(false);
      expect(audio.mediaTimeAt(ref.t)).toBeLessThan(0.1);
    });
  });
});
