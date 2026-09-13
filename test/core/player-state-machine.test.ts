import { describe, expect, it } from "vitest";
import { PlayerStateManager } from "../../src/core/PlayerState";
import type { PlayerState } from "../../src/types";

/**
 * PlayerState.ts had 0% dedicated coverage (only touched incidentally
 * through MoviPlayer-level integration tests, which never drove it through
 * its illegal-transition paths). This is exactly the class of gap the M2
 * defect came from — a state whose unlock condition could never become
 * true — so the goal here is locking the transition *contract*, not lines:
 * every legal edge must go through, every illegal edge must be rejected
 * and must leave the manager in its prior state with no event fired (no
 * half-state).
 *
 * The table below is the intended spec, taken from VALID_TRANSITIONS in
 * src/core/PlayerState.ts. It is deliberately duplicated here (not
 * imported) because the test's job is to hold the real module accountable
 * to this contract, not to restate whatever the module happens to do.
 */
const ALL_STATES: PlayerState[] = [
  "idle",
  "loading",
  "ready",
  "playing",
  "paused",
  "seeking",
  "buffering",
  "ended",
  "error",
];

const LEGAL_TRANSITIONS: Record<PlayerState, PlayerState[]> = {
  idle: ["loading"],
  loading: ["ready", "error"],
  ready: ["playing", "paused", "seeking", "error"],
  playing: ["paused", "seeking", "buffering", "ended", "error"],
  paused: ["playing", "seeking", "error"],
  seeking: ["ready", "playing", "paused", "buffering", "error", "seeking"],
  buffering: ["playing", "paused", "ended", "error", "seeking"],
  ended: ["seeking", "idle"],
  error: ["idle"],
};

// A path of legal setState() calls from the manager's initial "idle" state
// that lands on each state, so every state is reachable via the real API
// rather than by poking a private field.
const PATH_TO: Record<PlayerState, PlayerState[]> = {
  idle: [],
  loading: ["loading"],
  ready: ["loading", "ready"],
  playing: ["loading", "ready", "playing"],
  paused: ["loading", "ready", "playing", "paused"],
  seeking: ["loading", "ready", "seeking"],
  buffering: ["loading", "ready", "playing", "buffering"],
  ended: ["loading", "ready", "playing", "ended"],
  error: ["loading", "error"],
};

function driveTo(manager: PlayerStateManager, state: PlayerState): void {
  for (const step of PATH_TO[state]) {
    const ok = manager.setState(step);
    if (!ok) {
      throw new Error(
        `setup path broken: ${manager.getState()} -> ${step} was rejected`,
      );
    }
  }
  expect(manager.getState()).toBe(state);
}

describe("PlayerStateManager: legal transitions", () => {
  for (const from of ALL_STATES) {
    for (const to of LEGAL_TRANSITIONS[from]) {
      it(`${from} -> ${to} succeeds, updates state, and emits "change"`, () => {
        const manager = new PlayerStateManager();
        driveTo(manager, from);

        const seen: PlayerState[] = [];
        manager.on("change", (s) => seen.push(s));

        const result = manager.setState(to);

        expect(result).toBe(true);
        expect(manager.getState()).toBe(to);
        // A same-state "transition" (e.g. seeking -> seeking) is a real edge
        // in the table but short-circuits before the emit — assert only the
        // cases that actually change state fire the event.
        if (to !== from) {
          expect(seen).toEqual([to]);
        } else {
          expect(seen).toEqual([]);
        }
      });
    }
  }
});

describe("PlayerStateManager: illegal transitions are rejected without half-state", () => {
  for (const from of ALL_STATES) {
    const illegalTargets = ALL_STATES.filter(
      (to) => to !== from && !LEGAL_TRANSITIONS[from].includes(to),
    );
    for (const to of illegalTargets) {
      it(`${from} -> ${to} is rejected, leaves state at "${from}", and emits nothing`, () => {
        const manager = new PlayerStateManager();
        driveTo(manager, from);

        const seen: PlayerState[] = [];
        manager.on("change", (s) => seen.push(s));

        const result = manager.setState(to);

        expect(result).toBe(false);
        // No half-state: still exactly where it started, not stuck in some
        // partially-applied middle state.
        expect(manager.getState()).toBe(from);
        expect(seen).toEqual([]);
      });
    }
  }
});

describe("PlayerStateManager: same-state calls are a no-op success", () => {
  for (const state of ALL_STATES) {
    it(`setState("${state}") while already "${state}" returns true and fires no event`, () => {
      const manager = new PlayerStateManager();
      driveTo(manager, state);

      const seen: PlayerState[] = [];
      manager.on("change", (s) => seen.push(s));

      expect(manager.setState(state)).toBe(true);
      expect(manager.getState()).toBe(state);
      expect(seen).toEqual([]);
    });
  }
});

describe("PlayerStateManager: is()", () => {
  it("reflects the current state and only the current state", () => {
    const manager = new PlayerStateManager();
    driveTo(manager, "playing");

    for (const state of ALL_STATES) {
      expect(manager.is(state)).toBe(state === "playing");
    }
  });
});

describe("PlayerStateManager: canPlay/canPause/canSeek matrices", () => {
  const canPlayIn: PlayerState[] = ["ready", "paused", "ended", "buffering", "seeking"];
  const canPauseIn: PlayerState[] = ["playing", "buffering", "seeking"];
  const canSeekIn: PlayerState[] = [
    "ready",
    "playing",
    "paused",
    "ended",
    "buffering",
    "seeking",
  ];

  for (const state of ALL_STATES) {
    it(`in "${state}": canPlay=${canPlayIn.includes(state)}, canPause=${canPauseIn.includes(state)}, canSeek=${canSeekIn.includes(state)}`, () => {
      const manager = new PlayerStateManager();
      driveTo(manager, state);

      expect(manager.canPlay()).toBe(canPlayIn.includes(state));
      expect(manager.canPause()).toBe(canPauseIn.includes(state));
      expect(manager.canSeek()).toBe(canSeekIn.includes(state));
    });
  }

  // The gate documented at PlayerState.ts's canPause() comment: a seek in
  // flight must still be pausable, or a tap during a slow keyframe hunt
  // does nothing and playback silently auto-resumes when the seek lands.
  it("canPause() is true while seeking (regression: a pause tap during a seek must not be swallowed)", () => {
    const manager = new PlayerStateManager();
    driveTo(manager, "seeking");
    expect(manager.canPause()).toBe(true);
  });

  // "idle", "loading", and "error" can do none of the three — there is no
  // decoded/decodable media to act on yet (or anymore).
  for (const state of ["idle", "loading", "error"] as PlayerState[]) {
    it(`"${state}" permits none of play/pause/seek`, () => {
      const manager = new PlayerStateManager();
      driveTo(manager, state);
      expect(manager.canPlay()).toBe(false);
      expect(manager.canPause()).toBe(false);
      expect(manager.canSeek()).toBe(false);
    });
  }
});

describe("PlayerStateManager: reset()", () => {
  it("forces state back to idle from any state, bypassing the transition table", () => {
    const manager = new PlayerStateManager();
    // "playing" -> "idle" is not a legal table edge, so reset() must not be
    // implemented as setState("idle") or this would silently no-op.
    driveTo(manager, "playing");

    manager.reset();

    expect(manager.getState()).toBe("idle");
    expect(manager.is("idle")).toBe(true);
  });

  it("does NOT emit a 'change' event (documented real behavior, not a table transition)", () => {
    // Contract note for callers: anything driven off the 'change' event
    // (UI state, telemetry) will NOT observe a reset() back to idle. If a
    // future change makes reset() emit, that's a behavior change this test
    // will catch either way.
    const manager = new PlayerStateManager();
    driveTo(manager, "playing");

    const seen: PlayerState[] = [];
    manager.on("change", (s) => seen.push(s));
    manager.reset();

    expect(seen).toEqual([]);
  });
});
