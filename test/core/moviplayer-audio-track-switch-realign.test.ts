import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioTrack, VideoTrack } from "../../src/types";
import type { Clock } from "../../src/core/Clock";
import type { AudioRenderer } from "../../src/render/AudioRenderer";
import { stubBrowserGlobals } from "../helpers/browser-globals";

/**
 * B1 (docs/PLAN_MERGE.MD §4.11) — closes the gap the RED-phase investigation
 * flagged explicitly: the mechanism tests in
 * test/core/audio-track-switch-clock-anchor.test.ts drive `Clock` and
 * `AudioRenderer` directly, simulating what the real `audioTrackChange`
 * handler does to them — but the fix lands INSIDE that handler
 * (`MoviPlayer.ts`'s `trackManager.on("audioTrackChange", ...)`, via the
 * extracted `realignAudioTimelineForTrackSwitch()`). A test that only ever
 * drives the primitives directly would stay green regardless of whether the
 * handler actually calls them — a false green. This file exercises the REAL
 * handler, wired by a REAL `MoviPlayer` instance, through its public
 * `trackManager.selectAudioTrack()` API — the same one the UI calls.
 *
 * `dist/wasm/movi.js` (build:wasm artifact, gitignored) and the two optional
 * ABR backends are stubbed so importing MoviPlayer's module graph resolves
 * without the built WASM binary — none of these tests load or run it. This
 * is the same setup already used by test/core/seek-sync.test.ts and friends.
 */
vi.mock("../../dist/wasm/movi.js", () => ({ default: vi.fn(async () => ({})) }));

vi.mock("dashjs", () => ({
  MediaPlayer: vi.fn(),
}));

vi.mock("shaka-player/dist/shaka-player.compiled", () => ({
  default: {
    Player: {
      isBrowserSupported: vi.fn(() => false),
    },
    polyfill: {
      installAll: vi.fn(),
    },
    net: {
      NetworkingEngine: {
        RequestType: {
          LICENSE: 1,
        },
      },
    },
  },
}));

const videoTrack: VideoTrack = {
  id: 1,
  type: "video",
  codec: "h264",
  width: 1920,
  height: 1080,
  frameRate: 24,
};

const aacTrack: AudioTrack = {
  id: 2,
  type: "audio",
  codec: "aac",
  channels: 2,
  sampleRate: 48_000,
};

const ac3Track: AudioTrack = {
  id: 3,
  type: "audio",
  codec: "ac3",
  channels: 6,
  sampleRate: 48_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MoviPlayer B1 fix: audioTrackChange handler actually re-anchors AudioRenderer/Clock", () => {
  it("calls audioRenderer.reset() then clock.seek() exactly once each when the active audio track changes", async () => {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});

    player.trackManager.setTracks([videoTrack, aacTrack, ac3Track]);
    // Establishing the FIRST active track also goes through the handler (and
    // legitimately calls reset()/seek() too, since nothing before this point
    // anchored the clock to a real position). Let it settle, then spy so only
    // the actual switch under test is counted.
    player.trackManager.selectAudioTrack(aacTrack.id);

    const clock = (player as unknown as { clock: Clock }).clock;
    const audioRenderer = (player as unknown as { audioRenderer: AudioRenderer })
      .audioRenderer;
    const resetSpy = vi.spyOn(audioRenderer, "reset");
    const seekSpy = vi.spyOn(clock, "seek");

    player.trackManager.selectAudioTrack(ac3Track.id);

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(seekSpy).toHaveBeenCalledTimes(1);
    // Order matters: reset() must land BEFORE seek() re-anchors Clock. If it
    // ran the other way, Clock would hard-sync to whatever getAudioClock()
    // was still reporting from the OLD (not-yet-reset) anchor.
    expect(resetSpy.mock.invocationCallOrder[0]).toBeLessThan(
      seekSpy.mock.invocationCallOrder[0],
    );
  }, 20_000);

  it("does NOT re-anchor when selectAudioTrack is a no-op (same track re-selected)", async () => {
    // TrackManager.selectAudioTrack() only emits audioTrackChange when the
    // track actually differs (TrackManager.ts) — confirms the realign is
    // gated on a REAL switch, not fired on every call regardless of change.
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});

    player.trackManager.setTracks([videoTrack, aacTrack, ac3Track]);
    player.trackManager.selectAudioTrack(aacTrack.id);

    const clock = (player as unknown as { clock: Clock }).clock;
    const audioRenderer = (player as unknown as { audioRenderer: AudioRenderer })
      .audioRenderer;
    const resetSpy = vi.spyOn(audioRenderer, "reset");
    const seekSpy = vi.spyOn(clock, "seek");

    player.trackManager.selectAudioTrack(aacTrack.id); // same track again

    expect(resetSpy).not.toHaveBeenCalled();
    expect(seekSpy).not.toHaveBeenCalled();
  }, 20_000);

  it("realignAudioTimelineForTrackSwitch() seeks Clock to Clock's OWN current reading, not an arbitrary value", async () => {
    // Unit-level check on the extracted method itself (PLAN_MERGE.MD's
    // suggested "extract for testability" compromise) — a track switch must
    // not move playback position, only re-anchor at wherever it already is.
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});

    const clock = (player as unknown as { clock: Clock }).clock;
    const audioRenderer = (player as unknown as { audioRenderer: AudioRenderer })
      .audioRenderer;
    const resetSpy = vi.spyOn(audioRenderer, "reset");
    const getTimeSpy = vi.spyOn(clock, "getTime");
    const seekSpy = vi.spyOn(clock, "seek");

    (
      player as unknown as { realignAudioTimelineForTrackSwitch: () => void }
    ).realignAudioTimelineForTrackSwitch();

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(getTimeSpy).toHaveBeenCalledTimes(1);
    expect(seekSpy).toHaveBeenCalledWith(getTimeSpy.mock.results[0].value);
    // reset() before seek() here too — see the ordering test above for why.
    expect(resetSpy.mock.invocationCallOrder[0]).toBeLessThan(
      seekSpy.mock.invocationCallOrder[0],
    );
  }, 20_000);
});
