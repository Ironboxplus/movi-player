/**
 * Per-stream durations against the REAL WASM build, on two real MP4 files whose
 * streams do not end together (generated once with ffmpeg, a few KB each):
 *
 *   picture-ends-first.mp4  64x64 h264 3s + aac 6s
 *   sound-ends-first.mp4    64x64 h264 6s + aac 3s
 *
 * The player's tail detection (MoviPlayer.declareStreamEnds) trusts
 * Track.duration to say where each stream ends, so what the demuxer reports
 * has to match what the container really holds.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasWasm } from "../helpers/wasm-available";
import { Demuxer } from "../../src/demux/Demuxer";
import { HttpSource } from "../../src/source/HttpSource";
import { startHttpFixture, type HttpFixture } from "../source/http-test-server";

vi.mock("../../dist/wasm/movi.js", async (importOriginal) => {
  const { hasWasm } = await import("../helpers/wasm-available");
  return hasWasm ? importOriginal() : { default: vi.fn(async () => ({})) };
});

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "..", "fixtures", name));

const open: { f: HttpFixture; s: HttpSource; d: Demuxer }[] = [];

afterEach(async () => {
  for (const { f, s, d } of open.splice(0)) {
    try {
      d.close();
    } catch {
      /* ignore */
    }
    try {
      s.close();
    } catch {
      /* ignore */
    }
    await f.close();
  }
});

async function demux(name: string) {
  const f = await startHttpFixture({
    body: fixture(name),
    rangePolicy: "normal",
    responseChunkBytes: 64 * 1024,
  });
  const s = new HttpSource(f.url, {}, 4);
  const d = new Demuxer(s, undefined, true);
  open.push({ f, s, d });
  await d.open();
  return d;
}

async function lastPacketEnds(d: Demuxer) {
  const ends = new Map<number, number>();
  for (;;) {
    const p = await d.readPacket();
    if (!p) break;
    const end = p.timestamp + (p.duration > 0 ? p.duration : 0);
    ends.set(p.streamIndex, Math.max(ends.get(p.streamIndex) ?? 0, end));
  }
  return ends;
}

describe.skipIf(!hasWasm)("Demuxer against real WASM: per-stream durations", () => {
  it.each([
    ["picture-ends-first.mp4", 3, 6],
    ["sound-ends-first.mp4", 6, 3],
  ])("%s declares each track's own duration, and the packets agree", async (name, video, audio) => {
    const d = await demux(name);
    const v = d.getVideoTracks()[0];
    const a = d.getAudioTracks()[0];
    expect(v.duration).toBeCloseTo(video, 0);
    expect(a.duration).toBeCloseTo(audio, 0);
    expect(d.getDuration()).toBeCloseTo(Math.max(video, audio), 0);

    const ends = await lastPacketEnds(d);
    expect(ends.get(v.id)).toBeCloseTo(v.duration!, 0);
    expect(ends.get(a.id)).toBeCloseTo(a.duration!, 0);
  }, 60_000);
});
