import { describe, expect, it } from "vitest";
import { MoviVideoDecoder } from "../../src/decode/VideoDecoder";

/**
 * V3/M3 (docs/PLAN_MERGE.MD §3.2, §3.4c): `shouldRetryHardware()` gates the
 * periodic attempt to switch a software-fallback decoder back to hardware on
 * a real sync frame. These tests exercise the private method directly (same
 * Object.create + field-injection pattern as canvas-renderer-frame-clock and
 * video-worker-policy) since it has no side effects worth routing through
 * the full decode() pipeline for.
 *
 * NOTE: this file deliberately does NOT test gating on `_softwareReason`.
 * Reading the implementation (VideoDecoder.ts:1613-1630) and its only call
 * site (:850-889), neither reads `_softwareReason` — an "unmapped" codec
 * (WebCodecs never had a mapping for it at all) is retried on exactly the
 * same cooldown as "hardware-refused" (a transient hardware failure).
 * Verified empirically: with `_softwareReason` set to each of the two
 * values and every other gate satisfied, `shouldRetryHardware()` returns
 * `true` in both cases. Flagged to the team lead as a possible gap rather
 * than assumed — not fixed here without sign-off.
 */
function makeDecoder(overrides: Record<string, unknown>) {
  const d = Object.create(MoviVideoDecoder.prototype) as unknown as {
    shouldRetryHardware(data: Uint8Array): boolean;
  };
  Object.assign(d, {
    useSoftware: true,
    currentTrack: { id: 0 },
    hardwareRetryCount: 0,
    lastHardwareRetryTime: -1e9, // effectively "long ago" so cooldown never blocks by default
    lastConfig: null, // isLikelySyncFrame() treats "no config yet" as sync-frame-true
    ...overrides,
  });
  return d;
}

const anyKeyframeBytes = new Uint8Array([0, 0, 1, 0x65]);

describe("VideoDecoder.shouldRetryHardware — resurrection gating", () => {
  it("does not retry when not currently on the software fallback path", () => {
    const d = makeDecoder({ useSoftware: false });
    expect(d.shouldRetryHardware(anyKeyframeBytes)).toBe(false);
  });

  it("does not retry without a current track (nothing configured to retry against)", () => {
    const d = makeDecoder({ currentTrack: null });
    expect(d.shouldRetryHardware(anyKeyframeBytes)).toBe(false);
  });

  it("caps at hardwareRetryCount >= 10 regardless of cooldown/sync-frame state", () => {
    const d = makeDecoder({ hardwareRetryCount: 10 });
    expect(d.shouldRetryHardware(anyKeyframeBytes)).toBe(false);
  });

  it("allows retry #9 (count=9 is still under the cap)", () => {
    const d = makeDecoder({ hardwareRetryCount: 9 });
    expect(d.shouldRetryHardware(anyKeyframeBytes)).toBe(true);
  });

  it("first retry (count=0) is blocked before the 10s cooldown elapses", () => {
    const d = makeDecoder({
      hardwareRetryCount: 0,
      lastHardwareRetryTime: performance.now() - 5_000,
    });
    expect(d.shouldRetryHardware(anyKeyframeBytes)).toBe(false);
  });

  it("first retry (count=0) is allowed once the 10s cooldown elapses", () => {
    const d = makeDecoder({
      hardwareRetryCount: 0,
      lastHardwareRetryTime: performance.now() - 10_001,
    });
    expect(d.shouldRetryHardware(anyKeyframeBytes)).toBe(true);
  });

  it("a later retry (count>0) uses the longer 30s cooldown, not the first-retry 10s one", () => {
    const d = makeDecoder({
      hardwareRetryCount: 1,
      lastHardwareRetryTime: performance.now() - 15_000, // past 10s, short of 30s
    });
    expect(d.shouldRetryHardware(anyKeyframeBytes)).toBe(false);
  });

  it("a later retry (count>0) is allowed once the 30s cooldown elapses", () => {
    const d = makeDecoder({
      hardwareRetryCount: 1,
      lastHardwareRetryTime: performance.now() - 30_001,
    });
    expect(d.shouldRetryHardware(anyKeyframeBytes)).toBe(true);
  });

  it("refuses to retry on a non-IDR H.264 NAL even though every other gate is open", () => {
    const d = makeDecoder({
      lastConfig: { codec: "avc1.640028" },
    });
    // NAL type 1 = non-IDR coded slice (not a real sync point).
    const nonIdr = new Uint8Array([0, 0, 1, 0x01]);
    expect(d.shouldRetryHardware(nonIdr)).toBe(false);
  });

  it("retries on a genuine H.264 IDR NAL", () => {
    const d = makeDecoder({
      lastConfig: { codec: "avc1.640028" },
    });
    // NAL type 5 = IDR slice.
    const idr = new Uint8Array([0, 0, 1, 0x65]);
    expect(d.shouldRetryHardware(idr)).toBe(true);
  });
});
