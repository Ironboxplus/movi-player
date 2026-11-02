/**
 * Demuxer against the REAL WASM build, over a REAL TCP source.
 *
 * The companion file `demuxer-serialization.test.ts` proves the concurrency
 * invariant with a bindings double, because pinning two calls inside the module
 * simultaneously needs deterministic suspension that real WASM will not give
 * you. This file proves the BEHAVIOUR the invariant exists for, with nothing
 * substituted: `dist/wasm/movi.js` is the real Emscripten FFmpeg build,
 * `HttpSource` talks to a real `node:http` server on 127.0.0.1 through undici,
 * and the media is a real RIFF/WAVE file FFmpeg's `wav` demuxer parses and
 * seeks through (pcm_s16le is in the build's decoder list).
 *
 * Requires `dist/wasm/movi.js`, which `npm run build:wasm` produces. It is
 * present in the working tree, on the `.88` gate host and in the CI job that
 * builds the WASM. Elsewhere (the plain unit job) the suite is skipped via
 * `hasWasm`, like the audio worker and video decoder WASM suites.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasWasm } from "../helpers/wasm-available";
import { Demuxer } from "../../src/demux/Demuxer";
import { HttpSource } from "../../src/source/HttpSource";
import { startHttpFixture, type HttpFixture } from "../source/http-test-server";

// Demuxer imports FFmpegLoader eagerly, so without the build:wasm artifact the
// file would fail to even load and skipIf would never get a say. Resolve the
// import to an inert stub in that case; with the artifact present the real
// module is used untouched.
vi.mock("../../dist/wasm/movi.js", async (importOriginal) => {
  const { hasWasm } = await import("../helpers/wasm-available");
  return hasWasm ? importOriginal() : { default: vi.fn(async () => ({})) };
});

const MIB = 1024 * 1024;
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 2; // s16le

/**
 * A real RIFF/WAVE file: 44-byte canonical header plus s16le sine data.
 *
 * Synthesised rather than encoded so the suite needs no ffmpeg binary and no
 * checked-in media, and so byte offset maps linearly onto time — which is what
 * lets the assertions below name an exact second.
 */
function makeWav(seconds: number): Buffer {
  const dataLen = seconds * SAMPLE_RATE * BYTES_PER_FRAME;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // WAVE_FORMAT_PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * BYTES_PER_FRAME, 28);
  buf.writeUInt16LE(BYTES_PER_FRAME, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);

  const frames = seconds * SAMPLE_RATE;
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((i * 2 * Math.PI * 440) / SAMPLE_RATE) * 8000);
    const at = 44 + i * BYTES_PER_FRAME;
    buf.writeInt16LE(v, at);
    buf.writeInt16LE(v, at + 2);
  }
  return buf;
}

/** Byte offset of a given second in the payload above. */
function byteAt(seconds: number): number {
  return 44 + seconds * SAMPLE_RATE * BYTES_PER_FRAME;
}

const fixtures: HttpFixture[] = [];
const sources: HttpSource[] = [];
const demuxers: Demuxer[] = [];

afterEach(async () => {
  for (const d of demuxers.splice(0)) {
    try {
      d.close();
    } catch {
      /* ignore */
    }
  }
  for (const s of sources.splice(0)) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  for (const f of fixtures.splice(0)) await f.close();
});

async function openDemuxer(
  opts: Parameters<typeof startHttpFixture>[0],
  maxBufferSizeMB = 4,
): Promise<{ demuxer: Demuxer; source: HttpSource; fixture: HttpFixture }> {
  const fixture = await startHttpFixture(opts);
  fixtures.push(fixture);
  const source = new HttpSource(fixture.url, {}, maxBufferSizeMB);
  sources.push(source);
  // Isolated WASM instance: loadWasmModule() caches a singleton for the whole
  // process, and an aborted module stays permanently dead, so one test must not
  // be able to poison the next.
  const demuxer = new Demuxer(source, undefined, true);
  demuxers.push(demuxer);
  await demuxer.open();
  return { demuxer, source, fixture };
}

function delay(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, cancel: () => clearTimeout(handle!) };
}

// ─── Serialization, as the player actually issues it ───────────────────────

describe.skipIf(!hasWasm)("Demuxer against real WASM: back-to-back seeks", () => {
  it("lands on the LAST target when two seeks are issued without awaiting", async () => {
    const wav = makeWav(120);
    const { demuxer } = await openDemuxer({
      body: wav,
      rangePolicy: "normal",
      responseChunkBytes: 512 * 1024,
    });

    expect(demuxer.getDuration()).toBeGreaterThan(118);

    // Exactly the shape that broke before the entry points were serialized:
    // the element's poster seek and a deep-link/user seek, neither awaited.
    // Re-entering movi_seek_to while the first is unwound left the demuxer
    // reading from the OLD position — the second seek reported success and
    // moved nothing.
    const first = demuxer.seek(15, 1, -1);
    const second = demuxer.seek(95, 1, -1);
    await Promise.all([first, second]);

    const packet = await demuxer.readPacket();
    expect(packet).not.toBeNull();
    // Within a second of the second target, and nowhere near the first.
    expect(packet!.timestamp).toBeGreaterThan(94);
    expect(packet!.timestamp).toBeLessThan(96.5);
  }, 120_000);
});

// ─── M1: a seek must not inherit a read's unbounded wait ───────────────────

describe.skipIf(!hasWasm)("Demuxer against real WASM: a seek queued behind a stalled read", () => {
  it("cuts the read short and completes instead of waiting it out", async () => {
    const wav = makeWav(120);
    // Everything from 8 MiB on is answered with headers and then silence, with
    // the socket held open — the failure mode no error event reports. Reads
    // below that boundary keep working, so open() and the seek that follows
    // the preemption both have a live link to use.
    const STALL_FROM = 8 * MIB;
    const { demuxer, source } = await openDemuxer({
      body: wav,
      rangePolicy: "normal",
      responseChunkBytes: 256 * 1024,
      stallAfterBytes: 0,
      stallMs: 300_000,
      stallRangeStartAtLeast: STALL_FROM,
    });

    // Walk the read cursor forward until a read genuinely parks. Nothing is
    // forced: packets come back normally until the stream needs bytes past the
    // boundary, and then one simply stops coming.
    let parked: Promise<unknown> | null = null;
    for (let i = 0; i < 20_000; i++) {
      const read = demuxer.readPacket();
      const timer = delay(3_000);
      const outcome = await Promise.race([
        read.then(() => "packet" as const),
        timer.promise,
      ]);
      timer.cancel();
      if (outcome === "timeout") {
        parked = read;
        break;
      }
    }

    expect(parked).not.toBeNull();
    // It is expendable and it is about to be abandoned; swallow its rejection
    // so the abandonment is not reported as an unhandled one.
    parked!.catch(() => undefined);
    expect(source.getPosition()).toBeGreaterThan(0);

    // The seek is now queued behind a read that will not return for at least
    // 15s, and on the one-off path used to not return at all. It must get in.
    const startedAt = Date.now();
    await demuxer.seek(20, 1, -1);
    const seekMs = Date.now() - startedAt;
    expect(seekMs).toBeLessThan(5_000);

    // And the demuxer is usable afterwards: FFmpeg saw a failed read, and the
    // seek has to leave it in a state where the next read still works.
    const packet = await demuxer.readPacket();
    expect(packet).not.toBeNull();
    expect(packet!.timestamp).toBeGreaterThan(19);
    expect(packet!.timestamp).toBeLessThan(21.5);
    expect(source.getFatalError()).toBeNull();
    // Sanity: the boundary really was crossed, i.e. the park was the server's
    // silence and not something else.
    expect(byteAt(20)).toBeLessThan(STALL_FROM);
  }, 180_000);
});
