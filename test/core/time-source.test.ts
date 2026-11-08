import { describe, expect, it } from "vitest";
import { PlaybackTimeSource } from "../../src/core/TimeSource";

/**
 * The time source is Chromium's TimeSource with a WallClockTimeSource behind it
 * (media/base/time_source.h, media/base/wall_clock_time_source.cc): the sound
 * when it can answer, a wall clock continuing from the last thing it said when
 * it cannot.
 */
describe("PlaybackTimeSource", () => {
  it("has no reference until something positions it", () => {
    const source = new PlaybackTimeSource();
    expect(source.now(1_000)).toBe(-1);
    source.seek(12, 1_000);
    expect(source.now(1_000)).toBe(12);
  });

  it("does not move while stopped, and runs at the rate once started", () => {
    const source = new PlaybackTimeSource();
    source.seek(10, 0);
    expect(source.now(5_000)).toBe(10);

    source.start(5_000);
    expect(source.now(6_000)).toBeCloseTo(11, 9);

    source.setRate(2, 6_000);
    expect(source.now(7_000)).toBeCloseTo(13, 9);

    source.stop(7_000);
    expect(source.now(60_000)).toBeCloseTo(13, 9);
  });

  it("is the audio's answer, whatever the wall clock thought", () => {
    let heard = 100;
    const source = new PlaybackTimeSource();
    source.setAudio({ mediaTimeAt: () => heard });
    source.seek(0, 0);
    source.start(0);
    expect(source.now(2_000)).toBe(100);
    expect(source.isAudioDriven()).toBe(true);

    heard = 100.013; // 13ms under what a free-running clock would say
    expect(source.now(2_016)).toBe(100.013);
  });

  it("continues from the last heard time when the audio stops answering", () => {
    let heard = 50;
    const source = new PlaybackTimeSource();
    source.setAudio({ mediaTimeAt: () => heard });
    source.start(0);
    expect(source.now(1_000)).toBe(50);

    heard = -1;
    // 400ms after the last heard reading: that reading plus 400ms.
    expect(source.now(1_400)).toBeCloseTo(50.4, 9);
    expect(source.isAudioDriven()).toBe(false);

    // And when the audio answers again, it is believed.
    heard = 50.45;
    expect(source.now(1_450)).toBe(50.45);
    expect(source.isAudioDriven()).toBe(true);
  });

  it("holds through a stop even if the audio would have answered differently", () => {
    const source = new PlaybackTimeSource();
    source.setAudio({ mediaTimeAt: () => -1 });
    source.seek(30, 0);
    source.start(0);
    source.stop(2_000);
    expect(source.now(2_000)).toBeCloseTo(32, 9);
    expect(source.now(9_000)).toBeCloseTo(32, 9);
    source.start(9_000);
    expect(source.now(9_500)).toBeCloseTo(32.5, 9);
  });

  it("reset forgets the position and the rate", () => {
    const source = new PlaybackTimeSource();
    source.seek(5, 0);
    source.setRate(3, 0);
    source.start(0);
    source.reset();
    expect(source.now(1_000)).toBe(-1);
    source.seek(1, 1_000);
    source.start(1_000);
    expect(source.now(2_000)).toBeCloseTo(2, 9);
  });
});
