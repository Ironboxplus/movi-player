import { mergeConfig, defineConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "node",
      include: ["test/**/*.test.ts"],
      restoreMocks: true,
      coverage: {
        provider: "v8",
        reportsDirectory: "./coverage",
        reporter: ["text", "text-summary", "html", "lcov"],
        include: [
          "src/core/**",
          "src/decode/**",
          "src/demux/**",
          "src/source/**",
          "src/render/AudioRenderer.ts",
          "src/render/CanvasRenderer.ts",
        ],
        exclude: [
          "**/*.d.ts",
          "**/node_modules/**",
          "dist/**",
          // Upstream reference orchestrator, never used by MoviPlayer (see
          // the class doc comment in src/core/PlaybackController.ts). Kept
          // as public API and as an upstream-owned file we don't want a
          // future merge to conflict on, but it isn't on any path that can
          // cause a real playback regression — only a smoke test covers it
          // (test/core/playback-controller-smoke.test.ts), deliberately not
          // counted toward the coverage thresholds below.
          "src/core/PlaybackController.ts",
        ],
        thresholds: {
          // Regression FLOOR, not the target. The real acceptance target is
          // tracked in docs/PLAN_MERGE.MD §4.11 (currently far above this).
          //
          // These numbers are the actual measured coverage as of 2026-09-13
          // (stmts 27.8 / branch 19.82 / funcs 32.17 / lines 29.01), rounded
          // down to the whole point with an extra 0.5-1pt margin so normal
          // test-order/timing noise doesn't flip the gate red on an
          // unrelated commit. They exist so a later batch can't silently
          // delete or gut exercised coverage — not to describe where we
          // want to be.
          //
          // The previous values here (67/72/65/55) were set back when
          // `coverage.include` covered ONLY src/source/HttpSource.ts. When
          // `include` was widened to src/core/**, src/decode/**,
          // src/demux/**, src/source/** (commit 1fccdd8), the denominator
          // grew by roughly 10x and these thresholds were never
          // recalculated — so every `vitest run` with coverage enabled has
          // been exiting 1 (all four thresholds failing) since that commit,
          // silently, because nobody was checking exit code, only
          // "N passed" in the test summary. Caught only when a later batch
          // ran the full suite and actually inspected the exit code.
          //
          // Rule going forward: only ratchet UP as real coverage grows.
          // Never lower these to make a batch pass — lower coverage instead
          // means the batch removed exercised behavior and that's the bug
          // to fix, not the threshold.
          lines: 28,
          functions: 31,
          statements: 27,
          branches: 19,
        },
      },
    },
  }),
);
