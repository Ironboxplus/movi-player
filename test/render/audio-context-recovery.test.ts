import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvSim, halfFrame, VSYNC_MS, type SimOptions } from "../helpers/av-sim";

/**
 * AudioContext recovery after the audio device fails.
 *
 * Field report: a Chrome tab 12.6 minutes into 2160p HEVC + E-AC3 logged "The
 * AudioContext encountered an error from the audio device or the WebAudio
 * renderer", the context went to "suspended" and stayed there for 25 minutes.
 * One resume() from devtools brought it straight back. Per W3C Web Audio 2.8
 * the user agent fires `error`, then suspends the context and fires
 * `statechange`; it never resumes it by itself.
 *
 * The recovery that existed was wired only when stable audio was on (off by
 * default) and treated a resolved resume() as success. These drive the real
 * AudioRenderer, Clock and CanvasRenderer on a fake device that fails.
 */

async function fresh(opts: SimOptions = {}): Promise<AvSim> {
  // A module registry of its own: the shared context is a module-level
  // variable, and a test that rebuilds it must not inherit the previous one.
  vi.resetModules();
  const mod = await import("../../src/render/AudioRenderer");
  return new AvSim({ ...opts, rendererClass: mod.AudioRenderer });
}

/** The world moves: display refreshes, decoders, and the timers recovery runs on. */
async function advance(sim: AvSim, seconds: number, measureFrom = 0) {
  const steps = Math.round((seconds * 1000) / VSYNC_MS);
  const skip = Math.round((measureFrom * 1000) / VSYNC_MS);
  let maxErr = 0;
  let samples = 0;
  for (let i = 0; i < steps; i++) {
    sim.step();
    await vi.advanceTimersByTimeAsync(VSYNC_MS);
    if (i % 60 === 0) sim.ctx.prune();
    if (i < skip) continue;
    const heard = sim.ctx.heardMedia();
    const pts = sim.canvas.getLastPresentedTime();
    if (heard === null || pts < 0) continue;
    samples++;
    const err =
      heard < pts ? pts - heard : heard > pts + sim.interval ? heard - pts - sim.interval : 0;
    maxErr = Math.max(maxErr, err);
  }
  return { maxErr, samples };
}

describe("AudioContext recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function playing(opts: SimOptions = {}) {
    const sim = await fresh({ fps: 24, ...opts });
    sim.start(0);
    await advance(sim, 5);
    return sim;
  }

  it("a device error suspends the context: it is resumed and the sound is back in step", async () => {
    const sim = await playing();
    const first = sim.ctx;
    first.resumePlan = ["stay", "stay"]; // resolves, still suspended
    first.failDevice();
    expect(first.state).toBe("suspended");

    await advance(sim, 6);
    expect(first.state).toBe("running");
    expect(first.resumeCalls).toBeGreaterThanOrEqual(3);
    expect(sim.minted.length).toBe(0);
    expect(sim.recoveries).toBe(1);
    // The picture never stopped on the wall clock while the sound was gone.
    expect(sim.canvas.getLastPresentedTime()).toBeGreaterThan(9);

    const after = await advance(sim, 10, 2);
    expect(after.samples).toBeGreaterThan(100);
    expect(after.maxErr).toBeLessThanOrEqual(halfFrame(24));
  });

  it("a resume() that rejects is retried until it takes", async () => {
    const sim = await playing();
    const ctx = sim.ctx;
    ctx.resumePlan = ["reject", "reject", "reject"];
    ctx.failDevice();

    await advance(sim, 8);
    expect(ctx.state).toBe("running");
    expect(ctx.resumeCalls).toBe(4);
    expect(sim.minted.length).toBe(0);

    const after = await advance(sim, 8, 2);
    expect(after.maxErr).toBeLessThanOrEqual(halfFrame(24));
  });

  it("keeps trying while the user is still playing, not just a few times", async () => {
    const sim = await playing();
    const ctx = sim.ctx;
    ctx.resumePlan = Array(1000).fill("stay");
    ctx.failDevice();
    // A rebuilt context that is no better: the backoff must stay bounded.
    const rebuilt = () => {
      for (const c of sim.minted) if (c.resumePlan.length === 0) c.resumePlan = Array(1000).fill("stay");
    };
    for (let i = 0; i < 120; i++) {
      await advance(sim, 1);
      rebuilt();
    }
    expect(sim.minted.length).toBeGreaterThanOrEqual(1);
    const total = ctx.resumeCalls + sim.minted.reduce((n, c) => n + c.resumeCalls, 0);
    expect(total).toBeGreaterThan(10);
    expect(total).toBeLessThan(80);
  });

  it("a context that never resumes is replaced, and the sound comes back on the new one", async () => {
    const sim = await playing();
    const old = sim.ctx;
    old.resumePlan = Array(1000).fill("stay");
    old.failDevice();

    await advance(sim, 20);
    expect(sim.minted.length).toBe(1);
    expect(old.closeCalls).toBe(1);
    expect(old.listenerCount("statechange")).toBe(0);
    expect(old.listenerCount("error")).toBe(0);
    expect(sim.ctx).toBe(sim.minted[0]);
    expect(sim.ctx.state).toBe("running");
    expect(sim.recoveries).toBe(1);
    expect(sim.ctx.listenerCount("error")).toBe(1);

    const after = await advance(sim, 10, 2);
    expect(after.samples).toBeGreaterThan(100);
    expect(after.maxErr).toBeLessThanOrEqual(halfFrame(24));
  });

  it("an error event alone, with the context still running, changes nothing", async () => {
    const sim = await playing();
    const ctx = sim.ctx;
    (ctx as unknown as { emit(t: string): void }).emit("error");
    await advance(sim, 5);
    expect(ctx.resumeCalls).toBe(0);
    expect(sim.minted.length).toBe(0);
    expect(sim.recoveries).toBe(0);
  });

  it("an interruption (another app has the device) is waited out, then the sound is re-synced", async () => {
    const sim = await playing();
    const ctx = sim.ctx;
    ctx.interrupt();
    await advance(sim, 4);
    expect(ctx.state).toBe("interrupted");
    ctx.endInterruption();
    await advance(sim, 1);
    expect(sim.recoveries).toBe(1);
    const after = await advance(sim, 10, 2);
    expect(after.maxErr).toBeLessThanOrEqual(halfFrame(24));
  });

  describe("a suspend the player asked for is left alone", () => {
    it("pause", async () => {
      const sim = await playing();
      const ctx = sim.ctx;
      sim.pause();
      await advance(sim, 0.5);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ctx.state).toBe("suspended");
      expect(ctx.resumeCalls).toBe(0);
      expect(sim.recoveries).toBe(0);
    });

    it("a buffering hold, until the player resumes it itself", async () => {
      const sim = await playing();
      const ctx = sim.ctx;
      sim.holdForBuffering();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ctx.state).toBe("suspended");
      expect(ctx.resumeCalls).toBe(0);
      sim.resumeFromBuffering();
      expect(ctx.resumeCalls).toBe(1);
      expect(ctx.state).toBe("running");
      expect(sim.recoveries).toBe(0);
    });

    it("a pause in the middle of a recovery ends it", async () => {
      const sim = await playing();
      const ctx = sim.ctx;
      ctx.resumePlan = Array(1000).fill("stay");
      ctx.failDevice();
      await advance(sim, 1);
      sim.pause();
      const calls = ctx.resumeCalls;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ctx.resumeCalls).toBeLessThanOrEqual(calls + 1);
      expect(sim.minted.length).toBe(0);
    });
  });

  it("destroying the renderer takes its listeners and its retry timer with it", async () => {
    const sim = await playing();
    const ctx = sim.ctx;
    ctx.resumePlan = Array(1000).fill("stay");
    ctx.failDevice();
    await advance(sim, 1);
    await sim.audio.destroy();
    const calls = ctx.resumeCalls;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ctx.resumeCalls).toBe(calls);
    expect(ctx.listenerCount("error")).toBe(0);
    expect(ctx.listenerCount("statechange")).toBe(0);
  });
});
