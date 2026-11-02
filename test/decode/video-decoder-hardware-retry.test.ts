import { afterEach, describe, expect, it, vi } from "vitest";
import { MoviVideoDecoder } from "../../src/decode/VideoDecoder";
import type { VideoTrack } from "../../src/types";
import type { WasmBindings } from "../../src/wasm/bindings";

/**
 * V3/M3 (docs/PLAN_MERGE.MD §3.2, §3.4c): `shouldRetryHardware()` gates the
 * periodic attempt to switch a software-fallback decoder back to hardware on
 * a real sync frame. These tests exercise the private method directly (same
 * Object.create + field-injection pattern as canvas-renderer-frame-clock and
 * video-worker-policy) since it has no side effects worth routing through
 * the full decode() pipeline for.
 */
function makeDecoder(overrides: Record<string, unknown>) {
  const d = Object.create(MoviVideoDecoder.prototype) as unknown as {
    shouldRetryHardware(data: Uint8Array, isIdr: boolean): boolean;
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

// Upstream 1249b3d: the demuxer classifies IDR C-side and that is the primary
// authority (a CRA is what the hardware decoder refused in the first place),
// so every caller passes `isIdr`; the NAL walk is only the second opinion.
const anyKeyframeBytes = new Uint8Array([0, 0, 1, 0x65]);

describe("VideoDecoder.shouldRetryHardware — resurrection gating", () => {
  it("does not retry when not currently on the software fallback path", () => {
    const d = makeDecoder({ useSoftware: false });
    expect(d.shouldRetryHardware(anyKeyframeBytes, true)).toBe(false);
  });

  it("does not retry without a current track (nothing configured to retry against)", () => {
    const d = makeDecoder({ currentTrack: null });
    expect(d.shouldRetryHardware(anyKeyframeBytes, true)).toBe(false);
  });

  it("caps at hardwareRetryCount >= 10 regardless of cooldown/sync-frame state", () => {
    const d = makeDecoder({ hardwareRetryCount: 10 });
    expect(d.shouldRetryHardware(anyKeyframeBytes, true)).toBe(false);
  });

  it("allows retry #9 (count=9 is still under the cap)", () => {
    const d = makeDecoder({ hardwareRetryCount: 9 });
    expect(d.shouldRetryHardware(anyKeyframeBytes, true)).toBe(true);
  });

  it("first retry (count=0) is blocked before the 10s cooldown elapses", () => {
    const d = makeDecoder({
      hardwareRetryCount: 0,
      lastHardwareRetryTime: performance.now() - 5_000,
    });
    expect(d.shouldRetryHardware(anyKeyframeBytes, true)).toBe(false);
  });

  it("first retry (count=0) is allowed once the 10s cooldown elapses", () => {
    const d = makeDecoder({
      hardwareRetryCount: 0,
      lastHardwareRetryTime: performance.now() - 10_001,
    });
    expect(d.shouldRetryHardware(anyKeyframeBytes, true)).toBe(true);
  });

  it("a later retry (count>0) uses the longer 30s cooldown, not the first-retry 10s one", () => {
    const d = makeDecoder({
      hardwareRetryCount: 1,
      lastHardwareRetryTime: performance.now() - 15_000, // past 10s, short of 30s
    });
    expect(d.shouldRetryHardware(anyKeyframeBytes, true)).toBe(false);
  });

  it("a later retry (count>0) is allowed once the 30s cooldown elapses", () => {
    const d = makeDecoder({
      hardwareRetryCount: 1,
      lastHardwareRetryTime: performance.now() - 30_001,
    });
    expect(d.shouldRetryHardware(anyKeyframeBytes, true)).toBe(true);
  });

  it("refuses a keyframe the demuxer did not classify as IDR, whatever the bytes look like", () => {
    const d = makeDecoder({});
    expect(d.shouldRetryHardware(anyKeyframeBytes, false)).toBe(false);
  });

  it("refuses to retry on a non-IDR H.264 NAL even though every other gate is open", () => {
    const d = makeDecoder({
      lastConfig: { codec: "avc1.640028" },
    });
    // NAL type 1 = non-IDR coded slice (not a real sync point).
    const nonIdr = new Uint8Array([0, 0, 1, 0x01]);
    expect(d.shouldRetryHardware(nonIdr, true)).toBe(false);
  });

  it("retries on a genuine H.264 IDR NAL", () => {
    const d = makeDecoder({
      lastConfig: { codec: "avc1.640028" },
    });
    // NAL type 5 = IDR slice.
    const idr = new Uint8Array([0, 0, 1, 0x65]);
    expect(d.shouldRetryHardware(idr, true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M3 fix: shouldRetryHardware() must not retry when `_softwareReason` is
// permanent for this track ("unmapped" — WebCodecs has no codec string for
// it at all; "no-webcodecs" — the API isn't present in this browser), while
// still retrying for the transient reason ("hardware-refused" — a rejected
// config or decode error, where the hardware might genuinely recover).
//
// These run through the REAL MoviVideoDecoder.configure() + decode() (same
// pattern as video-decoder.test.ts's "reports why the CPU is decoding"
// suite) rather than hand-injecting `_softwareReason`, so the reason comes
// from the real classification logic, not from the test's assumption about
// it. The only stand-ins are WebCodecs itself (genuinely absent in Node —
// window/globalThis stubs) and WasmBindings (its calls ARE the assertions).
// ---------------------------------------------------------------------------
describe("M3: shouldRetryHardware gates on whether the fallback reason is permanent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mpeg2Track: VideoTrack = {
    id: 0,
    type: "video",
    codec: "mpeg2video",
    codecId: 2,
    width: 1920,
    height: 1080,
    frameRate: 23.976,
    bitRate: 0,
    profile: 4,
    level: 4,
    pixelFormat: "yuv420p",
  };

  it('does not attempt resurrection, and hardwareRetryCount stays 0, when the reason is "unmapped"', async () => {
    // WebCodecs is present (both the configure()-time check and the
    // resurrection-time globalThis check) — the codec is simply not one
    // WebCodecs knows, which is the "unmapped" case.
    vi.stubGlobal("window", { VideoDecoder: class {} });
    vi.stubGlobal("VideoDecoder", class {});

    const bindings = {
      enableDecoder: vi.fn(() => 0),
      setSkipFrame: vi.fn(),
      sendPacket: vi.fn(() => -1), // fail fast, don't need a real decode round-trip
    } as unknown as WasmBindings;
    const decoder = new MoviVideoDecoder();
    decoder.setBindings(bindings);

    await expect(decoder.configure(mpeg2Track)).resolves.toBe(true);
    expect(decoder.softwareReason).toBe("unmapped");

    // Cooldown wide open — if the gate were missing, this keyframe would
    // trigger a resurrection attempt.
    (decoder as unknown as { lastHardwareRetryTime: number }).lastHardwareRetryTime = -1e9;

    decoder.decode(new Uint8Array([0, 0, 1, 0x65]), 1.0, true);

    expect(
      (decoder as unknown as { hardwareRetryCount: number }).hardwareRetryCount,
    ).toBe(0);
    expect((decoder as unknown as { useSoftware: boolean }).useSoftware).toBe(
      true,
    );
  });

  it('still attempts resurrection, and hardwareRetryCount increments, when the reason is "hardware-refused"', async () => {
    const isConfigSupported = vi.fn(async () => ({ supported: false }));
    class RefusingVideoDecoder {
      static isConfigSupported = isConfigSupported;
      constructor() {}
      configure(): void {}
      close(): void {}
    }
    vi.stubGlobal("window", { VideoDecoder: RefusingVideoDecoder });
    vi.stubGlobal("VideoDecoder", RefusingVideoDecoder);

    const bindings = {
      enableDecoder: vi.fn(() => 0),
      setSkipFrame: vi.fn(),
      sendPacket: vi.fn(() => -1),
    } as unknown as WasmBindings;
    const decoder = new MoviVideoDecoder();
    decoder.setBindings(bindings);

    const h264Track: VideoTrack = {
      id: 3,
      type: "video",
      codec: "h264",
      codecId: 27,
      width: 1920,
      height: 1080,
      frameRate: 24,
      bitRate: 0,
      profile: 77,
      level: 40,
      pixelFormat: "yuv420p",
    };

    await expect(decoder.configure(h264Track)).resolves.toBe(true);
    expect(decoder.softwareReason).toBe("hardware-refused");

    (decoder as unknown as { lastHardwareRetryTime: number }).lastHardwareRetryTime = -1e9;

    decoder.decode(new Uint8Array([0, 0, 1, 0x65]), 1.0, true);

    // recreateDecoder() bails immediately (no lastConfig for a refused
    // hardware path) and flips back to software — but the retry ATTEMPT,
    // and its count, must still have happened. That's the transient case
    // resurrection exists for.
    expect(
      (decoder as unknown as { hardwareRetryCount: number }).hardwareRetryCount,
    ).toBe(1);
  });
});
