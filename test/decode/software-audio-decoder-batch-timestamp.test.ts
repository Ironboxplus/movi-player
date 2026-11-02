import { describe, expect, it, vi } from "vitest";
import { SoftwareAudioDecoder, type PCMFrame } from "../../src/decode/SoftwareAudioDecoder";
import type { WasmBindings } from "../../src/wasm/bindings";

/**
 * Legacy-path fix, already-declared "known issue" in docs/PLAN_MERGE.MD's
 * "已备案的潜在问题" — the batch path (decodeBatch, used only when the legacy
 * main-thread decoder handles TrueHD/MLP/DTS — see AudioDecoder.canBatch()'s
 * `swDecoder instanceof SoftwareAudioDecoder` gate) still had A1's original
 * bug: `timestamp: pts * 1_000_000` used the raw packet PTS of wherever a
 * batch started instead of a continuous PCM timeline, same as the per-packet
 * path had before A1 fixed it. Reachability confirmed (not dead code): the
 * gate lets the legacy decoder through whenever WorkerSoftwareAudioDecoder
 * isn't supported, and this call site is the only one that reads `packets`
 * out of AudioDecoder.decodeBatch().
 *
 * This exercises the REAL SoftwareAudioDecoder.decodeBatch() — every line of
 * it runs, including the HEAPU8 plane-pointer extraction — with only the
 * WASM FFI boundary stubbed to hand back controlled values. That boundary
 * (WasmBindings) is the accepted mock seam for decode unit tests throughout
 * this repo (see test/decode/video-decoder.test.ts's `enableDecoder`/
 * `setSkipFrame` stubs); nothing about decodeBatch()'s own logic — the
 * pcmTimestampClock wiring, the coalescing decision, the plane copy — is
 * replaced.
 */
function makeHeapBindings(): {
  bindings: WasmBindings;
  setNextBatch: (opts: { pts: number; numberOfFrames: number }) => void;
} {
  const CHANNELS = 2;
  const SAMPLE_RATE = 48_000;
  const MAX_FRAMES = 48_000;
  // One contiguous fake heap; each channel's plane lives at a fixed, aligned
  // offset far enough apart not to overlap.
  const heap = new Uint8Array(CHANNELS * MAX_FRAMES * 4 + 64);
  let nextPts = 0;
  let nextFrames = 0;

  const bindings = {
    enableDecoder: vi.fn(() => 0),
    enableAudioDownmix: vi.fn(),
    flushDecoder: vi.fn(),
    decodeAudioBatch: vi.fn(
      (_streamIndex: number, packets: { data: Uint8Array; pts: number }[]) =>
        packets.length,
    ),
    audioBatchSamples: vi.fn(() => nextFrames),
    audioBatchChannels: vi.fn(() => CHANNELS),
    audioBatchSampleRate: vi.fn(() => SAMPLE_RATE),
    audioBatchPts: vi.fn(() => nextPts),
    audioBatchPlanePointer: vi.fn((channel: number) => 16 + channel * MAX_FRAMES * 4),
    module: { HEAPU8: heap },
  } as unknown as WasmBindings;

  return {
    bindings,
    setNextBatch: ({ pts, numberOfFrames }) => {
      nextPts = pts;
      nextFrames = numberOfFrames;
    },
  };
}

describe("SoftwareAudioDecoder.decodeBatch — PCM timeline continuity (A1 fix, batch path)", () => {
  it("keeps consecutive batches on a continuous timeline instead of jumping to each batch's raw packet PTS", async () => {
    const { bindings, setNextBatch } = makeHeapBindings();
    const decoder = new SoftwareAudioDecoder(bindings);
    await decoder.configure({
      id: 0,
      type: "audio",
      codec: "truehd",
      codecId: 86060,
      channels: 2,
      sampleRate: 48_000,
    } as any);

    const frames: PCMFrame[] = [];
    decoder.setOnData((f) => frames.push(f));

    // Batch #1: one second of audio, packet PTS anchors the clock at 0.
    setNextBatch({ pts: 0, numberOfFrames: 48_000 });
    decoder.decodeBatch([{ data: new Uint8Array(4), pts: 0 }]);
    // Upstream 0.4.1 cuts a block far past 150ms into pieces that carry their
    // own media times (see SoftwareAudioDecoder.enqueueFrame), so one second of
    // PCM arrives as several frames, not one.
    const firstBatchPieces = frames.length;
    expect(firstBatchPieces).toBeGreaterThan(1);

    // Batch #2: the packet's own PTS (0.99s) undershoots where batch #1's
    // real audio actually ends (1.000s) — exactly the container/decoder
    // slack A1 exists to absorb. It's well inside the clock's forward-
    // discontinuity threshold (250ms), so it must NOT be treated as a jump.
    setNextBatch({ pts: 0.99, numberOfFrames: 48_000 });
    decoder.decodeBatch([{ data: new Uint8Array(4), pts: 0.99 }]);

    const first = frames[0];
    const second = frames[firstBatchPieces];
    expect(first.timestamp).toBe(0);
    // Pieces are contiguous on the PCM timeline, within and across batches.
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1];
      const end = prev.timestamp + (prev.numberOfFrames / prev.sampleRate) * 1_000_000;
      expect(Math.abs(frames[i].timestamp - end)).toBeLessThan(1);
    }
    // The old `pts * 1_000_000` would have produced 990_000 here — BEHIND
    // batch #1's end (1_000_000), a backward jump on the PCM timeline. The
    // fix must place it continuously after batch #1 instead.
    expect(second.timestamp).toBe(1_000_000);
    expect(second.timestamp).toBeGreaterThanOrEqual(first.timestamp);
  });

  it("resets the batch timeline on flush, matching the per-packet path's reset points", async () => {
    const { bindings, setNextBatch } = makeHeapBindings();
    const decoder = new SoftwareAudioDecoder(bindings);
    await decoder.configure({
      id: 0,
      type: "audio",
      codec: "truehd",
      codecId: 86060,
      channels: 2,
      sampleRate: 48_000,
    } as any);

    const frames: PCMFrame[] = [];
    decoder.setOnData((f) => frames.push(f));

    setNextBatch({ pts: 5, numberOfFrames: 48_000 });
    decoder.decodeBatch([{ data: new Uint8Array(4), pts: 5 }]);
    expect(frames[0].timestamp).toBe(5_000_000);
    const beforeFlush = frames.length;

    await decoder.flush();

    // Post-flush (a seek), the next batch's PTS is a fresh anchor, not
    // continued from the pre-seek position.
    setNextBatch({ pts: 40, numberOfFrames: 48_000 });
    decoder.decodeBatch([{ data: new Uint8Array(4), pts: 40 }]);
    expect(frames[beforeFlush].timestamp).toBe(40_000_000);
  });
});
