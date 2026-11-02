import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the real Emscripten FFmpeg build (`dist/wasm/movi.js`) exists.
 *
 * It is a build:wasm artifact (Docker/emsdk, ~15 min) and is gitignored, so the
 * plain unit job has none; only the job that builds the WASM can run the tests
 * that drive real libavformat/libavcodec. Those tests gate on this with
 * `describe.skipIf(!hasWasm)` so the unit job stays green without hiding them
 * from a machine or job that does have the artifact.
 *
 * MOVI_REQUIRE_WASM=1 turns "skipped" into an error. The packaging job sets it
 * right after building the WASM: if the artifact is missing there, silently
 * skipping would let a release ship with its real-WASM coverage never run.
 */
export const hasWasm = existsSync(
  fileURLToPath(new URL("../../dist/wasm/movi.js", import.meta.url)),
);

if (!hasWasm && process.env.MOVI_REQUIRE_WASM === "1") {
  throw new Error(
    "MOVI_REQUIRE_WASM=1 but dist/wasm/movi.js does not exist; the real-WASM tests would be skipped",
  );
}
