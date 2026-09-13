import { vi } from "vitest";

/**
 * `MoviPlayer`'s constructor and module graph touch `document`/`window`/
 * `requestAnimationFrame`/`cancelAnimationFrame` even in tests that never
 * render anything (background/visibility listeners, rAF-driven loops). Node
 * has none of these, so every MoviPlayer-importing test file needs the same
 * minimal stub set before `new MoviPlayer(...)` — this used to be copied
 * verbatim into five files (audio-buffer-backpressure, decode-mode-queue-
 * caps, native-audio-removed, rebuffer-unlock, seek-sync); one copy here so
 * it can't drift.
 *
 * Only the browser globals are shared. Module-level `vi.mock(...)` calls
 * (dist/wasm/movi.js, dashjs, shaka-player) stay in each test file — vitest
 * hoists and scopes those per file, so a shared runtime helper can't
 * centralize them.
 */
export function stubBrowserGlobals(): void {
  vi.stubGlobal("document", {
    hidden: false,
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setInterval,
    clearInterval,
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
}
