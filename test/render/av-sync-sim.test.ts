import { afterEach, describe, expect, it, vi } from "vitest";
import { AvSim, VSYNC_MS, halfFrame } from "../helpers/av-sim";

vi.mock("../../dist/wasm/movi.js", () => ({ default: vi.fn(async () => ({})) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Picture against sound, measured by the fake output device (see av-sim.ts):
 * the distance between the media time the device is playing and the interval
 * [pts, pts + frame] of the frame on screen. Zero while the frame covers the
 * sound; the bound asked of every sample is half a frame (ITU-R BT.265's
 * +/- half a frame, which Chromium's video_renderer_algorithm.cc adopts as
 * max_acceptable_drift_).
 *
 * Distance to the interval, not to the pts, because a 24fps frame is correct
 * for 42ms: a picture 30ms "behind" the sound by pts is still the right one.
 */
function underflowMs(sim: AvSim): number {
  return (sim.canvas as unknown as { getVideoUnderflowMs?: () => number }).getVideoUnderflowMs?.() ?? 0;
}

describe("A/V sync follows the one time source", () => {
  const HOUR = 3600;

  it.each([100, -100])(
    "stays within half a frame for an hour with the audio clock %i ppm off performance.now()",
    (ppm) => {
      const sim = new AvSim({ ppm, fps: 24 });
      sim.start();
      const w = sim.run(HOUR, 3);
      expect(w.samples).toBeGreaterThan(HOUR * 50);
      expect(w.maxErr).toBeLessThanOrEqual(halfFrame(24));
    },
    120_000,
  );

  it.each([30, 60])(
    "holds half a frame at %ifps over ten minutes with the clock 100ppm fast",
    (fps) => {
      const sim = new AvSim({ ppm: 100, fps });
      sim.start();
      const w = sim.run(600, 3);
      expect(w.maxErr).toBeLessThanOrEqual(halfFrame(fps));
    },
    60_000,
  );

  describe("after a single disturbance, the offset comes back and stays", () => {
    /** Run past the disturbance, give it 10s, then everything after must be in step. */
    function settleThenMeasure(sim: AvSim) {
      sim.run(10);
      return sim.run(40);
    }

    it.each([0.13, 1.3])("audio runs dry for %ss and then resumes", (gap) => {
      const sim = new AvSim({ fps: 24, audioCushion: 0.6 });
      sim.start();
      sim.run(20, 3);

      // The decoder falls behind: nothing more is scheduled, the cushion plays
      // out, and the device is left with silence for `gap` seconds.
      sim.audioFeeding = false;
      sim.run(5);
      expect(sim.audio.getBufferedDuration()).toBeLessThanOrEqual(0);
      sim.run(gap);
      sim.audioFeeding = true;

      const w = settleThenMeasure(sim);
      expect(w.samples).toBeGreaterThan(1000);
      expect(w.maxErr).toBeLessThanOrEqual(halfFrame(24));
    });

    it.each([0.13, 1.3])(
      "the main thread is blocked for %ss and the audio underruns",
      (blocked) => {
        const sim = new AvSim({ fps: 24, audioCushion: 0.5 });
        sim.start();
        sim.run(20, 3);

        // Long enough to empty the cushion, and `blocked` seconds beyond it.
        sim.blockMainThread((0.5 + blocked) * 1000);

        const w = settleThenMeasure(sim);
        expect(w.maxErr).toBeLessThanOrEqual(halfFrame(24));
      },
    );

    it.each([0.4, 2.5])(
      "the audio clock stalls for %ss without the context leaving running",
      (stall) => {
        const sim = new AvSim({ fps: 24 });
        sim.start();
        sim.run(20, 3);

        sim.ctx.freezeClock();
        sim.run(stall);
        sim.ctx.releaseClock();

        const w = settleThenMeasure(sim);
        expect(w.maxErr).toBeLessThanOrEqual(halfFrame(24));
      },
    );
  });

  describe("a decoder that falls behind", () => {
    /** Lateness of a presented frame behind the sound, past the end of its own interval. */
    function worstLateness(sim: AvSim, since: number): number {
      let worst = 0;
      for (const p of sim.presented) {
        if (p.t < since || p.heard === null) continue;
        worst = Math.max(worst, p.heard - (p.pts + sim.interval));
      }
      return worst;
    }

    it("never puts up a frame more than the acceptable drift late, and recovers in step", () => {
      const sim = new AvSim({ fps: 24, decodeSpeed: 4 });
      sim.start();
      sim.run(10, 3);

      const slowFrom = sim.ref.t;
      sim.decodeSpeed = 0.25; // a stretch the decoder manages a quarter of real time
      let longestUnderflowMs = 0;
      for (let i = 0; i < Math.round(8000 / VSYNC_MS); i++) {
        sim.step();
        longestUnderflowMs = Math.max(longestUnderflowMs, underflowMs(sim));
      }
      sim.decodeSpeed = 4;

      // Chromium: max_acceptable_drift_ = clamp(frame/2, 1/60 s, 1/8 s).
      const maxDrift = Math.min(1 / 8, Math.max(1 / 60, 0.5 / 24));
      expect(worstLateness(sim, slowFrom)).toBeLessThanOrEqual(maxDrift + 0.003);

      // The picture was without an on-time frame long enough to be called an
      // underflow, and says so once frames are on time again.
      expect(longestUnderflowMs).toBeGreaterThan(3000);
      sim.run(10);
      expect(underflowMs(sim)).toBe(0);

      const w = sim.run(30);
      expect(w.maxErr).toBeLessThanOrEqual(halfFrame(24));
    });
  });

  describe("operations that restart or reshape the audio timeline", () => {
    it("a seek in the middle of playback", () => {
      const sim = new AvSim({ fps: 24 });
      sim.start();
      sim.run(20, 3);
      sim.seek(1234.5);
      sim.run(3);
      expect(sim.run(30).maxErr).toBeLessThanOrEqual(halfFrame(24));
      // …and a backwards one.
      sim.seek(10);
      sim.run(3);
      expect(sim.run(30).maxErr).toBeLessThanOrEqual(halfFrame(24));
    });

    it("pause and resume, repeatedly", () => {
      const sim = new AvSim({ fps: 24 });
      sim.start();
      sim.run(10, 3);
      for (const pausedFor of [0.3, 5, 40]) {
        sim.pause();
        for (let i = 0; i < Math.round((pausedFor * 1000) / VSYNC_MS); i++) sim.step();
        sim.play();
        sim.run(3);
        expect(sim.run(15).maxErr).toBeLessThanOrEqual(halfFrame(24));
      }
    });

    it("rate changes 1x to 2x to 0.5x and back", () => {
      const sim = new AvSim({ fps: 24 });
      sim.start();
      sim.run(10, 3);
      // A display that refreshes every 16.7ms real time cannot show a 24fps
      // frame closer than one refresh, which is `rate` refreshes of media.
      for (const rate of [2, 0.5, 1]) {
        sim.setRate(rate);
        sim.run(4);
        const bound = halfFrame(24) + Math.max(0, rate - 1) * (VSYNC_MS / 1000);
        expect(sim.run(15).maxErr).toBeLessThanOrEqual(bound);
      }
    });

    it("a gapless loop turns the corner in step", () => {
      const sim = new AvSim({ fps: 24, duration: 30 });
      sim.loop = true;
      sim.start();
      sim.run(29);
      sim.run(3);
      const w = sim.run(40);
      expect(w.samples).toBeGreaterThan(1000);
      expect(w.maxErr).toBeLessThanOrEqual(halfFrame(24));
      // It really did wrap: the last frame is from the second pass.
      expect(sim.canvas.getLastPresentedTime()).toBeLessThan(30);
    });
  });
});
