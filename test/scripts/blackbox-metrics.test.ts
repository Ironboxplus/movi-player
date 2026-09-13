/**
 * The arithmetic the black-box harness uses to turn two observations into a
 * verdict, tested against windows RECORDED FROM REAL RUNS.
 *
 * `test/scripts/fixtures/blackbox-recorded-windows.json` is not synthetic: each
 * entry is the `before` / `after` pair the harness itself printed when the
 * sample failed, lifted verbatim out of `.blackbox-results/batch-j-full.json`
 * (run of 2026-09-13T04:08Z). The only field added is `wallMs`, taken from the
 * `network.elapsed` the HttpSource measured at those same two instants, because
 * `compactSnapshot` does not carry `wallMs` into the error text.
 *
 * Nothing here drives the player. These functions are pure reductions over
 * snapshots, which is exactly what §5.3 calls white-box: no executor is being
 * stood in for, because there is no executor on this path.
 */
import { describe, expect, it } from "vitest";
import recorded from "./fixtures/blackbox-recorded-windows.json";
import {
  byteBudget,
  classifyWindow,
  isSteady,
  progression,
  summarizeDisturbances,
} from "../../scripts/blackbox-metrics.mjs";

describe("progression across a renderer reset", () => {
  it("refuses to report a negative frame count", () => {
    // Grave of the Fireflies, steady-playback window: framesPresented 11 -> 1.
    // The old arithmetic subtracted these and reported "presented only -10
    // frames", which is a statement about the harness, not the player.
    const { before, after } = recorded.fireflies;
    expect(after.framesPresented).toBeLessThan(before.framesPresented);

    const progress = progression(before, after);
    expect(progress.framesReset).toBe(true);
    expect(progress.frames).toBeNull();
    expect(progress.presentedFps).toBeNull();
  });

  it("still measures picture progress through the reset, via the presented PTS", () => {
    // rendererCurrentTime is the last presented PTS. It is monotone inside a
    // window that contains no seek, so it survives the counter restarting and
    // is the honest fallback signal: 0.417s -> 10.427s of picture over ~10s.
    const { before, after } = recorded.fireflies;
    const progress = progression(before, after);
    expect(progress.rendererSeconds).toBeCloseTo(10.01, 2);
    expect(progress.wallSeconds).toBeCloseTo(10.035, 2);
  });

  it("keeps the frame delta when the counter did not reset", () => {
    // Star Trek: 18 -> 67. Nothing reset here, so the count is real and must
    // not be discarded by the reset handling.
    const { before, after } = recorded.starTrek;
    const progress = progression(before, after);
    expect(progress.framesReset).toBe(false);
    expect(progress.frames).toBe(49);
  });
});

describe("steady-state gating", () => {
  it("rejects a sample taken while the player is seeking", () => {
    // The Fireflies `after` was taken at state=seeking with the master clock
    // stopped — the player's own desync resync had just fired. A steady-state
    // assertion sampled here is measuring a transition.
    expect(recorded.fireflies.after.state).toBe("seeking");
    expect(isSteady(recorded.fireflies.after)).toBe(false);
  });

  it("rejects a sample taken while the player is buffering", () => {
    expect(recorded.virginPunk.after.state).toBe("buffering");
    expect(isSteady(recorded.virginPunk.after)).toBe(false);
  });

  it("accepts a sample taken during running playback", () => {
    expect(isSteady(recorded.starTrek.after)).toBe(true);
    expect(isSteady(recorded.starTrek.before)).toBe(true);
  });
});

describe("classifyWindow", () => {
  it("names the state the window left steady for", () => {
    const { before, after } = recorded.fireflies;
    const disturbances = classifyWindow([before, after]);
    expect(disturbances).toHaveLength(1);
    expect(disturbances[0].kind).toBe("state:seeking");
    expect(summarizeDisturbances(disturbances)).toContain("state:seeking");
  });

  it("reports a presentation re-base even when the clock never stopped", () => {
    // Star Trek held state=playing across the whole window, so no state gate
    // would catch it — but presentationStartPts moved 0 -> 7.466, which is the
    // renderer being re-based underneath a "healthy" window.
    const { before, after } = recorded.starTrek;
    const disturbances = classifyWindow([before, after]);
    expect(disturbances.map((d) => d.kind)).toEqual(["presentation-rebase"]);
  });

  it("reports a clean window as undisturbed", () => {
    const { before } = recorded.starTrek;
    const clean = { ...before, wallMs: before.wallMs + 1000 };
    expect(classifyWindow([before, clean])).toEqual([]);
  });
});

describe("byteBudget", () => {
  it("derives a ceiling from bitrate, generations and the read-ahead window", () => {
    // The 19.6GB MPEG-2 remux: 5432s, so ~3.6MB/s average.
    const budget = byteBudget({
      sizeBytes: 19_600_000_000,
      durationSeconds: 5432,
      wallSeconds: 120,
      generations: 3,
      windowBytes: 250 * 1024 * 1024,
    });
    expect(budget.bitrateBytesPerSecond).toBe(3_608_247);
    // 120s x 3.6MB/s x 2.5 VBR slack
    expect(budget.streamedTerm).toBe(1_082_474_100);
    // 3 generations x (4MiB first chunk + 8MiB in-flight fill)
    expect(budget.generationTerm).toBe(3 * 12 * 1024 * 1024);
    expect(budget.windowTerm).toBe(250 * 1024 * 1024);
    expect(budget.budgetBytes).toBe(
      budget.streamedTerm + budget.generationTerm + budget.windowTerm,
    );
  });

  it("stays finite for a zero-duration file rather than dividing by it", () => {
    const budget = byteBudget({
      sizeBytes: 1_000,
      durationSeconds: 0,
      wallSeconds: 10,
      generations: 1,
      windowBytes: 0,
    });
    expect(budget.bitrateBytesPerSecond).toBe(0);
    expect(Number.isFinite(budget.budgetBytes)).toBe(true);
  });
});
