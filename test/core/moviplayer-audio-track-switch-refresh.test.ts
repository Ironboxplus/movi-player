import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioTrack } from "../../src/types";
import {
  audioPacket,
  flacTrack,
  makePipelinePlayer,
  packetRun,
  videoPacket,
} from "../helpers/pipeline-player";

vi.mock("../../dist/wasm/movi.js", () => ({ default: vi.fn(async () => ({})) }));
vi.mock("dashjs", () => ({ MediaPlayer: vi.fn() }));
vi.mock("shaka-player/dist/shaka-player.compiled", () => ({
  default: {
    Player: { isBrowserSupported: vi.fn(() => false) },
    polyfill: { installAll: vi.fn() },
    net: { NetworkingEngine: { RequestType: { LICENSE: 1 } } },
  },
}));

const aacTrack: AudioTrack = {
  id: 2,
  type: "audio",
  codec: "aac",
  channels: 2,
  sampleRate: 48_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * An audio track switch is a refresh seek, and only audio moves
 * (docs/PLAN_MOVI_PIPELINE.md P4, mpv's demux.c initiate_refresh_seek and
 * loadfile.c mp_switch_track_n): the demuxer goes back a second and reads
 * the file again from there; the streams already playing drop what they
 * already took; the new audio drops what is older than the playhead and
 * joins at the clock. The video decoder, its queue and the renderer's frames
 * are not touched, so the picture never notices.
 */
async function switching(opts: Parameters<typeof makePipelinePlayer>[0] = {}) {
  let finishConfigure: (ok: boolean) => void = () => {};
  const configuring = new Promise<boolean>((resolve) => {
    finishConfigure = resolve;
  });
  const f = await makePipelinePlayer({
    ...opts,
    tracks: [
      ...(opts.tracks ?? [
        { id: 0, type: "video", codec: "hevc", width: 1920, height: 1080, frameRate: 24 },
      ]),
      flacTrack,
      aacTrack,
    ] as never,
  });
  // The switch reconfigures the player's decoder rather than building a new
  // one, so the stub is the thing to steer.
  const decode = vi.fn(() => {});
  Object.assign(f.audioDecoder, {
    configure: vi.fn(() => configuring),
    decode,
  });
  f.player.trackManager.selectAudioTrack(flacTrack.id);
  const demuxerSeek = f.player.demuxer.seek as ReturnType<typeof vi.fn>;
  return {
    ...f,
    decode,
    demuxerSeek,
    finishConfigure,
    /** Switch to the second audio track; the new decoder is still configuring. */
    switchNow: () => f.player.trackManager.selectAudioTrack(aacTrack.id),
    /** Let the new decoder finish configuring and the handler run to its end. */
    settle: async (ok = true) => {
      finishConfigure(ok);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("audio track switch: the demuxer refreshes, the picture does not", () => {
  it("seeks the demuxer back a second the moment discard flips, without waiting for the decoder", async () => {
    const f = await switching();
    f.player.startTime = 1000;
    f.player.clock.seek(1030.5);
    const discard = vi.spyOn(f.player, "applyStreamDiscard");

    f.switchNow();

    // Synchronously: nothing awaited the new decoder's configure first, which
    // is what let the old read-forward scan run for seconds (4.5s for a
    // worker AAC decoder, while the scan hit EOF in 70ms).
    expect(f.demuxerSeek).toHaveBeenCalledTimes(1);
    // Clock time is absolute media time (startTime included) and so are the
    // demuxer's timestamps: no second startTime on top.
    expect(f.demuxerSeek).toHaveBeenCalledWith(
      1029.5,
      1,
      f.player.getSeekStreamIndex(),
    );
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard.mock.invocationCallOrder[0]).toBeLessThan(
      f.demuxerSeek.mock.invocationCallOrder[0],
    );
    await f.settle();
  }, 20_000);

  it("keeps the audio decoder object, and with it the worker, across the switch", async () => {
    const f = await switching();
    f.player.clock.seek(10);
    const before = f.player.audioDecoder;
    f.switchNow();
    expect(f.player.audioDecoder).toBe(before);
    expect(before.reset).toHaveBeenCalledTimes(1);
    expect(before.close).not.toHaveBeenCalled();
    await f.settle();
  }, 20_000);

  it("starts the audio timeline over and re-seats the clock where the playhead was", async () => {
    const f = await switching();
    f.player.clock.seek(10);
    f.switchNow();
    // The old track's timeline is gone with its sound: a new segment list, not
    // an anchor patched. The picture is not told anything — it reads the same
    // time source, which carries on from 10s on the wall clock until the new
    // sound arrives.
    expect(f.player.audioRenderer.reset).toHaveBeenCalledTimes(1);
    expect(f.player.clock.getTime()).toBeCloseTo(10, 1);
    await f.settle();
  }, 20_000);

  it("never refreshes to before the start of the file", async () => {
    const f = await switching();
    f.player.clock.seek(0.4);
    f.switchNow();
    expect(f.demuxerSeek.mock.calls[0][0]).toBe(0);
    await f.settle();
  }, 20_000);

  it("leaves the video pipeline alone: no flush, no cleared frames, no keyframe scan, queue kept", async () => {
    const f = await switching({
      queuedVideo: packetRun((t) => videoPacket(t), 10, 12, 1 / 24),
    });
    f.player.clock.seek(10);
    const queued = f.player.videoQueue.length;

    f.switchNow();
    await f.settle();

    expect(f.videoDecoder.flush).not.toHaveBeenCalled();
    expect(f.player.videoRenderer.clearQueue).not.toHaveBeenCalled();
    expect(f.player.seekingToKeyframe).toBe(false);
    expect(f.player.videoQueue.length).toBe(queued);
  }, 20_000);

  it("keeps feeding the video decoder on the next tick: the picture keeps advancing", async () => {
    const f = await switching({
      queuedVideo: packetRun((t) => videoPacket(t), 10, 11, 1 / 24),
      reads: [],
    });
    f.player.clock.seek(10);
    f.switchNow();
    await f.tick();
    expect(f.videoDecode).toHaveBeenCalled();
    await f.settle();
  }, 20_000);

  it("a switch after the file has been read to its end still reads again", async () => {
    const f = await switching();
    f.player.eofReached = true;
    f.player.eofSince = 1234;
    f.switchNow();
    await f.settle();
    // The cursor is no longer at the end, whatever the read-ahead had found:
    // processLoop reads nothing while the flag is up.
    expect(f.player.eofReached).toBe(false);
    expect(f.player.eofSince).toBe(0);
  }, 20_000);

  it("does not touch the demuxer when audio is disabled", async () => {
    const f = await switching();
    f.player.disableAudio = true;
    f.switchNow();
    await f.settle();
    expect(f.demuxerSeek).not.toHaveBeenCalled();
  }, 20_000);
});

describe("audio track switch: what the re-read gives each stream", () => {
  it("drops video it already queued, and carries on from the first packet past it", async () => {
    const f = await switching({
      queuedVideo: packetRun((t) => videoPacket(t), 10, 12, 1 / 24),
    });
    f.player.clock.seek(10);
    const last = f.player.videoQueue.lastDts;
    const queued = f.player.videoQueue.length;
    f.switchNow();

    // The re-read starts a second before the playhead and walks over what the
    // queue took already.
    for (const t of [9.5, 10.5, 11.5, last]) f.player.enqueuePacket(videoPacket(t));
    expect(f.player.videoQueue.length).toBe(queued);

    f.player.enqueuePacket(videoPacket(last + 1 / 24));
    expect(f.player.videoQueue.length).toBe(queued + 1);
    expect(f.player.videoQueue.lastDts).toBeCloseTo(last + 1 / 24);

    // Past it, the refresh is over: nothing else is dropped.
    f.player.enqueuePacket(videoPacket(last + 2 / 24));
    expect(f.player.videoQueue.length).toBe(queued + 2);
    await f.settle();
  }, 20_000);

  it("does the same for subtitle packets", async () => {
    const f = await switching();
    const sub = vi.fn();
    f.player.subtitleDecoder = { decode: vi.fn(async (...a: unknown[]) => sub(...a)) };
    f.player.trackManager.setTracks([
      { id: 0, type: "video", codec: "hevc", width: 1920, height: 1080, frameRate: 24 },
      flacTrack,
      aacTrack,
      { id: 5, type: "subtitle", codec: "subrip" },
    ] as never);
    f.player.trackManager.selectAudioTrack(flacTrack.id);
    f.player.trackManager.selectSubtitleTrack(5);
    const cue = (t: number) => ({
      ...audioPacket(t),
      streamIndex: 5,
      duration: 2,
    });
    f.player.enqueuePacket(cue(20));
    f.player.enqueuePacket(cue(25));
    expect(sub).toHaveBeenCalledTimes(2);

    f.switchNow();
    f.player.enqueuePacket(cue(20));
    f.player.enqueuePacket(cue(25));
    expect(sub).toHaveBeenCalledTimes(2);
    f.player.enqueuePacket(cue(30));
    expect(sub).toHaveBeenCalledTimes(3);
    await f.settle();
  }, 20_000);

  it("empties the audio queue and takes the new track's packets from the re-read", async () => {
    const f = await switching({
      queuedAudio: packetRun((t) => audioPacket(t), 10, 11, 0.02),
    });
    f.switchNow();
    expect(f.player.audioQueue.length).toBe(0);

    // Read before the seek landed: from the position being abandoned, however
    // far ahead the new track's first packet happens to be there.
    const ahead = { ...audioPacket(1102.4), streamIndex: aacTrack.id };
    f.player.enqueuePacket(ahead, true);
    expect(f.player.audioQueue.length).toBe(0);

    f.player.enqueuePacket({ ...audioPacket(9.5), streamIndex: aacTrack.id });
    expect(f.player.audioQueue.length).toBe(1);
    await f.settle();
  }, 20_000);

  it("a video packet read before the seek landed is still the next one, not a duplicate", async () => {
    const f = await switching({
      queuedVideo: packetRun((t) => videoPacket(t), 10, 11, 1 / 24),
    });
    f.player.clock.seek(10);
    const last = f.player.videoQueue.lastDts;
    const queued = f.player.videoQueue.length;
    f.switchNow();

    f.player.enqueuePacket(videoPacket(last + 1 / 24), true);
    expect(f.player.videoQueue.length).toBe(queued + 1);
    // …and what the re-read brings up to that point is dropped like the rest.
    f.player.enqueuePacket(videoPacket(last + 1 / 24));
    expect(f.player.videoQueue.length).toBe(queued + 1);
    await f.settle();
  }, 20_000);

  it("a real seek ends the refresh", async () => {
    const f = await switching({
      queuedVideo: packetRun((t) => videoPacket(t), 10, 11, 1 / 24),
    });
    f.player.clock.seek(10);
    f.switchNow();
    f.player.clearPacketQueues();
    f.player.enqueuePacket(videoPacket(3));
    expect(f.player.videoQueue.length).toBe(1);
    await f.settle();
  }, 20_000);
});

describe("audio track switch: the new audio joins at the clock", () => {
  it("holds the new audio packets until the new decoder is configured", async () => {
    const f = await switching();
    f.player.clock.seek(100);
    f.switchNow();
    f.player.enqueuePacket({ ...audioPacket(99.5), streamIndex: aacTrack.id });

    await f.tick();
    expect(f.decode).not.toHaveBeenCalled();

    await f.settle();
    await f.tick();
    expect(f.decode).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("drops what the new track decodes from before the clock, and plays from the first frame at it", async () => {
    const f = await switching();
    f.player.clock.seek(100);
    f.switchNow();
    await f.settle();
    // The picture played on while the decoder started up: the clock is not
    // where it was at the switch, and the cut is made against where it is.
    f.player.clock.seek(101);

    const pcm = (t: number) =>
      ({ timestamp: Math.round(t * 1e6), planes: [], numberOfFrames: 0 }) as never;
    f.player.renderDecodedPCM(pcm(99.0));
    f.player.renderDecodedPCM(pcm(100.5));
    f.player.renderDecodedPCM(pcm(100.97));
    expect(f.player.audioRenderer.renderPCM).not.toHaveBeenCalled();

    f.player.renderDecodedPCM(pcm(101.0));
    expect(f.player.audioRenderer.renderPCM).toHaveBeenCalledTimes(1);

    // Joined: nothing after that is dropped, whatever it says.
    f.player.renderDecodedPCM(pcm(101.02));
    expect(f.player.audioRenderer.renderPCM).toHaveBeenCalledTimes(2);
  }, 20_000);
});

describe("audio track switch: no stall while the sound is being rebuilt", () => {
  async function stalledPlayer() {
    const f = await switching({ rendererQueue: 10, audioBuffered: 0 });
    f.player._bindAV = true;
    f.player.clock.seek(100);
    f.player._stallStartTime = performance.now() - 1000;
    f.player._stallStartFrames = 0;
    return f;
  }

  it("control: with no sound buffered and nothing to read, a bound player does stall", async () => {
    const f = await stalledPlayer();
    await f.tick();
    expect(f.player.stateManager.getState()).toBe("buffering");
    await f.settle();
  }, 20_000);

  it("after the switch the picture plays on over the silence", async () => {
    const f = await stalledPlayer();
    f.switchNow();
    f.player._stallStartTime = performance.now() - 1000;
    await f.tick();
    expect(f.player.stateManager.getState()).toBe("playing");
    await f.settle();
  }, 20_000);

  it("and the stall detector is back once the new sound has arrived", async () => {
    const f = await stalledPlayer();
    f.switchNow();
    await f.settle();
    f.player.renderDecodedPCM({
      timestamp: 100_000_000,
      planes: [],
      numberOfFrames: 0,
    } as never);
    f.player._stallStartTime = performance.now() - 1000;
    await f.tick();
    expect(f.player.stateManager.getState()).toBe("buffering");
  }, 20_000);

  it("a decoder that fails to configure gives the detector back at once", async () => {
    const f = await stalledPlayer();
    f.switchNow();
    await f.settle(false);
    f.player._stallStartTime = performance.now() - 1000;
    await f.tick();
    expect(f.player.stateManager.getState()).toBe("buffering");
  }, 20_000);
});
