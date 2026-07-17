import { describe, expect, it } from "vitest";
import { PCMFrameTimestampClock } from "../../src/decode/PCMFrameTimestampClock";

describe("PCMFrameTimestampClock", () => {
  it("keeps DTS PCM frames continuous when their packet PTS repeats", () => {
    const clock = new PCMFrameTimestampClock();
    const timestamps = Array.from({ length: 8 }, () =>
      clock.next(0, 512, 48_000),
    );

    const expected = [
      0,
      10_666.666666666666,
      21_333.333333333332,
      32_000,
      42_666.666666666664,
      53_333.33333333333,
      64_000,
      74_666.66666666667,
    ];
    timestamps.forEach((timestamp, index) => {
      expect(timestamp).toBeCloseTo(expected[index], 6);
    });
    expect(clock.next(0.085, 512, 48_000)).toBeCloseTo(85_333.33333333334);
  });

  it("uses a new PTS after reset or a real forward discontinuity", () => {
    const clock = new PCMFrameTimestampClock();

    expect(clock.next(0, 512, 48_000)).toBe(0);
    expect(clock.next(1, 512, 48_000)).toBe(1_000_000);

    clock.reset();
    expect(clock.next(12.5, 512, 48_000)).toBe(12_500_000);
  });
});
