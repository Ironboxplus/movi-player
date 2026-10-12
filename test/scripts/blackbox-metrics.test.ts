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
  generationAllowance,
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

const MIB = 1024 * 1024;
const NO_ONE_OFF = { fetches: 0, requestedBytes: 0, bytes: 0 };

describe("generationAllowance", () => {
  it("is the consumed span plus one window plus the two chunks", () => {
    expect(
      generationAllowance({
        startOffset: 1000 * MIB,
        consumedEnd: 1300 * MIB,
        windowBytes: 250 * MIB,
      }),
    ).toBe(300 * MIB + 250 * MIB + 12 * MIB);
  });

  it("never goes below the fixed part for a generation that consumed nothing", () => {
    expect(
      generationAllowance({ startOffset: 500, consumedEnd: 500, windowBytes: 0 }),
    ).toBe(12 * MIB);
    expect(
      generationAllowance({ startOffset: 500, consumedEnd: 100, windowBytes: 0 }),
    ).toBe(12 * MIB);
  });
});

describe("byteBudget", () => {
  const window = 250 * MIB;
  const gen = (
    over: Partial<{
      generation: number;
      startOffset: number;
      consumedEnd: number;
      bytes: number;
      ms: number;
    }> = {},
  ) => ({
    generation: 1,
    startOffset: 0,
    consumedEnd: 0,
    bytes: 0,
    ms: 10_000,
    ...over,
  });

  it("sums per-generation allowances into the budget", () => {
    const generationBytes = [
      gen({ generation: 1, consumedEnd: 80 * MIB, bytes: 100 * MIB }),
      gen({
        generation: 2,
        startOffset: 9000 * MIB,
        consumedEnd: 9100 * MIB,
        bytes: 200 * MIB,
      }),
    ];
    const budget = byteBudget({
      totalBytes: 300 * MIB,
      generationBytes,
      oneOff: NO_ONE_OFF,
      windowBytes: window,
    });
    expect(budget.perGeneration.map((g) => g.allowance)).toEqual([
      80 * MIB + window + 12 * MIB,
      100 * MIB + window + 12 * MIB,
    ]);
    expect(budget.budgetBytes).toBe(180 * MIB + 2 * (window + 12 * MIB));
    expect(budget.violations).toEqual([]);
    expect(budget.worstGeneration?.generation).toBe(2);
  });

  it("accepts the refill after a forward jump inside the window", () => {
    // The Good Will Hunting shape: the head seek jumped about 300MB forward
    // inside the window, the window slid over it and refilled. Bytes are the
    // jump plus a window, which is the allowance minus the two chunks.
    const budget = byteBudget({
      totalBytes: 300 * MIB + window,
      generationBytes: [
        gen({ consumedEnd: 300 * MIB, bytes: 300 * MIB + window, ms: 36_000 }),
      ],
      oneOff: NO_ONE_OFF,
      windowBytes: window,
    });
    expect(budget.violations).toEqual([]);
    expect(budget.worstGeneration?.ratio).toBeLessThan(1);
  });

  it("names the generation that downloaded past its span and window", () => {
    const budget = byteBudget({
      totalBytes: 700 * MIB,
      generationBytes: [
        gen({ generation: 4, consumedEnd: 50 * MIB, bytes: 100 * MIB }),
        gen({
          generation: 5,
          startOffset: 7000 * MIB,
          consumedEnd: 7010 * MIB,
          bytes: 600 * MIB,
          ms: 1_000,
        }),
      ],
      oneOff: NO_ONE_OFF,
      windowBytes: window,
    });
    expect(budget.violations).toHaveLength(1);
    expect(budget.violations[0]).toMatchObject({
      kind: "generation-over-allowance",
      generation: 5,
      startOffset: 7000 * MIB,
      consumedEnd: 7010 * MIB,
      bytes: 600 * MIB,
      ms: 1_000,
    });
    expect(budget.worstGeneration?.generation).toBe(5);
    expect(budget.worstGeneration?.ratio).toBeGreaterThan(1);
  });

  it("fails when one-off reads returned more than they asked for", () => {
    const budget = byteBudget({
      totalBytes: 10 * MIB,
      generationBytes: [],
      oneOff: { fetches: 2, requestedBytes: 4 * MIB, bytes: 10 * MIB },
      windowBytes: window,
    });
    expect(budget.violations).toEqual([
      { kind: "one-off-over-request", requestedBytes: 4 * MIB, bytes: 10 * MIB },
    ]);
  });

  it("counts one-off bytes toward the total", () => {
    const generationBytes = [gen({ consumedEnd: 100 * MIB, bytes: 100 * MIB })];
    const oneOff = { fetches: 3, requestedBytes: 30 * MIB, bytes: 20 * MIB };
    expect(
      byteBudget({ totalBytes: 120 * MIB, generationBytes, oneOff, windowBytes: window })
        .violations,
    ).toEqual([]);
    // Without crediting the one-off bytes the same totals do not add up.
    expect(
      byteBudget({
        totalBytes: 120 * MIB,
        generationBytes,
        oneOff: NO_ONE_OFF,
        windowBytes: window,
      }).violations.map((v) => v.kind),
    ).toEqual(["counter-mismatch"]);
  });

  it("fails when the counters do not add up to the total", () => {
    const budget = byteBudget({
      totalBytes: 300 * MIB,
      generationBytes: [gen({ consumedEnd: 100 * MIB, bytes: 100 * MIB })],
      oneOff: NO_ONE_OFF,
      windowBytes: window,
    });
    expect(budget.violations).toEqual([
      {
        kind: "counter-mismatch",
        totalBytes: 300 * MIB,
        generationSum: 100 * MIB,
        oneOffBytes: 0,
      },
    ]);
  });

  it("tolerates a sub-MiB difference between the counters", () => {
    const budget = byteBudget({
      totalBytes: 100 * MIB + 1000,
      generationBytes: [gen({ consumedEnd: 100 * MIB, bytes: 100 * MIB })],
      oneOff: NO_ONE_OFF,
      windowBytes: window,
    });
    expect(budget.violations).toEqual([]);
  });

  it("does not demand a sum once the source has dropped old generations", () => {
    const generationBytes = Array.from({ length: 64 }, (_, i) =>
      gen({ generation: i + 10, startOffset: i, consumedEnd: i + MIB, bytes: MIB }),
    );
    const budget = byteBudget({
      totalBytes: 100 * MIB,
      generationBytes,
      oneOff: NO_ONE_OFF,
      windowBytes: window,
    });
    expect(budget.violations).toEqual([]);
  });

  it("has no worst generation when none was recorded", () => {
    const budget = byteBudget({
      totalBytes: 0,
      generationBytes: [],
      oneOff: NO_ONE_OFF,
      windowBytes: window,
    });
    expect(budget.worstGeneration).toBeNull();
    expect(budget.budgetBytes).toBe(0);
  });
});
