import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioTrack, VideoTrack } from "../../src/types";
import type { Clock } from "../../src/core/Clock";
import type { Demuxer } from "../../src/demux/Demuxer";
import { stubBrowserGlobals } from "../helpers/browser-globals";

/**
 * B1b (docs/PLAN_MERGE.MD §4.11) — root-cause fix for the playhead jump on
 * audio track switch. B1 (moviplayer-audio-track-switch-realign.test.ts)
 * already closed the RATE-distortion half: it proves the handler re-anchors
 * Clock/AudioRenderer to where playback already was. It does NOT prove the
 * demuxer's shared read cursor gets put back there too — and without that,
 * applyStreamDiscard() re-enables a track that was skipped inside
 * av_read_frame, so the read loop scans forward (unbounded, measured 60-100s
 * on real media) until it finds a packet, and Clock hard-syncs onto that
 * far-ahead PTS instead. That is the actual position jump; this file proves
 * the handler now prevents it by repositioning the demuxer.
 *
 * A fake `demuxer` (a plain object exposing a spy-wrapped `seek()`, the only
 * method this code path calls) is substituted for the real one. The real
 * Demuxer talks to the WASM binary over Asyncify — genuinely unreachable in
 * a unit test per PLAN_MERGE.MD §5.1's external-dependency carve-out — so
 * this is the one boundary mocked; the handler, TrackManager, Clock and
 * AudioRenderer are all real, driven through the public
 * `trackManager.selectAudioTrack()` API exactly as B1's tests do.
 *
 * `dist/wasm/movi.js` and the two optional ABR backends are stubbed so
 * importing MoviPlayer's module graph resolves without the built WASM
 * binary, matching moviplayer-audio-track-switch-realign.test.ts.
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

describe("MoviPlayer B1b fix: audioTrackChange handler repositions the demuxer", () => {
  it("seeks the demuxer to the exact position Clock was just re-anchored to, AFTER discard flips", async () => {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});

    player.trackManager.setTracks([videoTrack, aacTrack, ac3Track]);
    player.trackManager.selectAudioTrack(aacTrack.id);

    const clock = (player as unknown as { clock: Clock }).clock;
    // getBindings/getExtradata are exercised by the handler's decoder-
    // reconfigure step, which runs before applyStreamDiscard()/reposition —
    // stubbed to their "nothing available" shape (undefined) so that step
    // takes its existing, already-safe "no bindings" early-out
    // (AudioDecoder.initSoftwareDecoder logs and returns false) instead of
    // throwing on a missing method.
    const fakeDemuxer = {
      seek: vi.fn(async () => {}),
      getBindings: () => undefined,
      getExtradata: () => undefined,
    };
    (player as unknown as { demuxer: Pick<Demuxer, "seek"> }).demuxer =
      fakeDemuxer as unknown as Demuxer;
    // Real applyStreamDiscard() is safe here: it early-returns when
    // demuxer.getBindings() is falsy (our fake demuxer has no bindings),
    // so spying on it (rather than replacing it) still exercises the real
    // no-op-when-no-bindings behavior while letting the test see the call.
    const discardSpy = vi.spyOn(
      player as unknown as { applyStreamDiscard: () => void },
      "applyStreamDiscard",
    );

    const getTimeSpy = vi.spyOn(clock, "getTime");

    player.trackManager.selectAudioTrack(ac3Track.id);
    // repositionDemuxerForTrackSwitch() awaits demuxer.seek(); let that
    // microtask settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fakeDemuxer.seek).toHaveBeenCalledTimes(1);
    // Same value realignAudioTimelineForTrackSwitch() anchored Clock to —
    // by construction (the pending-target field), not a second independent
    // clock.getTime() read.
    const anchoredTo = getTimeSpy.mock.results[0]?.value as number;
    const seekStreamIndex = (
      player as unknown as { getSeekStreamIndex: () => number }
    ).getSeekStreamIndex();
    expect(fakeDemuxer.seek).toHaveBeenCalledWith(
      anchoredTo,
      1,
      seekStreamIndex,
    );
    // Discard must flip BEFORE the reposition: the re-enabled track has
    // nothing to yield at the old position until discard says it's live.
    const seekCallOrder = fakeDemuxer.seek.mock.invocationCallOrder[0];
    const discardCallOrder = discardSpy.mock.invocationCallOrder.find(
      (order) => order < seekCallOrder,
    );
    expect(discardCallOrder).toBeDefined();
  }, 20_000);

  it("feeds the decoder nothing while the reposition seek is in flight, and resumes once it lands", async () => {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});

    player.trackManager.setTracks([videoTrack, aacTrack, ac3Track]);
    player.trackManager.selectAudioTrack(aacTrack.id);

    // The seek is held open deliberately. Repositioning alone did NOT fix the
    // jump: the read loop does not stop for the `await`, so on real media the
    // decoder was handed a packet 93s ahead of the playhead DURING this exact
    // window and anchored on it (the three-log ordering in
    // `_trackSwitchRepositioning`'s doc comment). A promise that only settles
    // when this test says so is what makes that window observable at all.
    let landSeek: () => void = () => {};
    const seekLanded = new Promise<void>((resolve) => {
      landSeek = resolve;
    });
    const fakeDemuxer = {
      seek: vi.fn(() => seekLanded),
      getBindings: () => undefined,
      getExtradata: () => undefined,
    };
    (player as unknown as { demuxer: Pick<Demuxer, "seek"> }).demuxer =
      fakeDemuxer as unknown as Demuxer;

    const submit = (
      player as unknown as {
        submitAudioPackets: (
          packets: { data: Uint8Array; timestamp: number; keyframe: boolean }[],
          source?: string,
        ) => void;
      }
    ).submitAudioPackets.bind(player);
    // A packet from the position being abandoned — far ahead of the playhead,
    // which is what the old scan-forward behaviour actually produced.
    const strayPacket = [
      { data: new Uint8Array([1, 2, 3]), timestamp: 1_102_443_000, keyframe: true },
    ];

    player.trackManager.selectAudioTrack(ac3Track.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fakeDemuxer.seek).toHaveBeenCalledTimes(1);

    // Spied AFTER the switch, not before: the handler closes the old decoder
    // and constructs a new one, so a spy taken up front sits on an instance
    // this code path no longer feeds and would pass the in-flight assertion
    // below without proving anything.
    const audioDecoder = (
      player as unknown as {
        audioDecoder: { canBatch: () => boolean; decode: (...args: unknown[]) => void };
      }
    ).audioDecoder;
    vi.spyOn(audioDecoder, "canBatch").mockReturnValue(false);
    const decodeSpy = vi
      .spyOn(audioDecoder, "decode")
      .mockImplementation(() => {});

    submit(strayPacket, "test:in-flight");
    expect(decodeSpy).not.toHaveBeenCalled();

    landSeek();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Reopened on the way out — a gate that latched closed would silence audio
    // for the rest of playback, a worse failure than the jump it fixes.
    submit(strayPacket, "test:after-landing");
    expect(decodeSpy).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("does not touch the demuxer when audio is disabled", async () => {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});

    player.trackManager.setTracks([videoTrack, aacTrack, ac3Track]);
    player.trackManager.selectAudioTrack(aacTrack.id);

    // getBindings/getExtradata are exercised by the handler's decoder-
    // reconfigure step, which runs before applyStreamDiscard()/reposition —
    // stubbed to their "nothing available" shape (undefined) so that step
    // takes its existing, already-safe "no bindings" early-out
    // (AudioDecoder.initSoftwareDecoder logs and returns false) instead of
    // throwing on a missing method.
    const fakeDemuxer = {
      seek: vi.fn(async () => {}),
      getBindings: () => undefined,
      getExtradata: () => undefined,
    };
    (player as unknown as { demuxer: Pick<Demuxer, "seek"> }).demuxer =
      fakeDemuxer as unknown as Demuxer;
    (player as unknown as { disableAudio: boolean }).disableAudio = true;

    player.trackManager.selectAudioTrack(ac3Track.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fakeDemuxer.seek).not.toHaveBeenCalled();
  }, 20_000);
});
