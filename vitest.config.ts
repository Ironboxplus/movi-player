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
          // Enforce the current real-TCP merge baseline so later batches cannot
          // silently erase exercised behavior. This is a regression floor, not
          // the final 90/80 acceptance target tracked in docs/PLAN.md.
          lines: 67,
          functions: 72,
          statements: 65,
          branches: 55,
        },
      },
    },
  }),
);
