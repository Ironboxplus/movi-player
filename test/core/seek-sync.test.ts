import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoTrack } from "../../src/types";

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

function stubBrowserGlobals() {
  vi.stubGlobal("document", {
    hidden: false,
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setInterval,
    clearInterval,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MoviPlayer seek sync", () => {
  it("does not complete a video seek when the forced timeout fires before the first frame", async () => {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});
    const seeked = vi.fn();

    player.trackManager.setTracks([videoTrack]);
    player.on("seeked", seeked);

    const stateManager = (player as any).stateManager;
    stateManager.setState("loading");
    stateManager.setState("ready");
    stateManager.setState("playing");
    stateManager.setState("seeking");

    Object.assign(player as any, {
      seekSessionId: 1,
      seekArmedSessionId: 1,
      seekTargetTime: 42,
      waitingForVideoSync: true,
      wasPlayingBeforeSeek: true,
      videoRenderer: {
        getQueueSize: () => 0,
      },
    });

    (player as any).notifySeekCompletion(42, true);

    expect(seeked).not.toHaveBeenCalled();
    expect((player as any).waitingForVideoSync).toBe(true);
    expect((player as any).seekTargetTime).toBe(42);
    expect(stateManager.getState()).toBe("buffering");
    expect((player as any).wasPlayingBeforeRebuffer).toBe(true);
  }, 20_000);

  it("caps audio packets held while a video seek is waiting for the first frame", async () => {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});
    Object.assign(player as any, {
      seekTargetTime: 10,
      pendingAudioPackets: [],
      droppedSeekAudioPackets: 0,
    });

    for (let i = 0; i < 700; i++) {
      (player as any).stashSeekAudioPacket({
        streamIndex: 2,
        data: new Uint8Array([i & 0xff]),
        timestamp: 10 + i * 0.001,
        duration: 0.001,
        keyframe: false,
      });
    }

    (player as any).stashSeekAudioPacket({
      streamIndex: 2,
      data: new Uint8Array([1]),
      timestamp: 15,
      duration: 0.001,
      keyframe: false,
    });

    expect((player as any).pendingAudioPackets).toHaveLength(512);
    expect((player as any).droppedSeekAudioPackets).toBeGreaterThan(0);
  }, 20_000);

  it("read-ahead cap engages only after demuxing past the target while waiting for video sync", async () => {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});
    const MAX_AHEAD = (MoviPlayer as any).SEEK_MAX_DEMUX_AHEAD_SECONDS as number;

    // Not waiting for sync → never caps normal playback.
    Object.assign(player as any, {
      waitingForVideoSync: false,
      seekTargetTime: 100,
      seekDemuxAheadTime: 100 + MAX_AHEAD + 50,
    });
    expect((player as any).seekReadAheadExceeded()).toBe(false);

    // Waiting, but demuxed only a little past target → keep reading.
    Object.assign(player as any, {
      waitingForVideoSync: true,
      seekTargetTime: 100,
      seekDemuxAheadTime: 100 + MAX_AHEAD - 1,
    });
    expect((player as any).seekReadAheadExceeded()).toBe(false);

    // Waiting and demuxed well past target → stop reading (traffic cap).
    (player as any).seekDemuxAheadTime = 100 + MAX_AHEAD + 1;
    expect((player as any).seekReadAheadExceeded()).toBe(true);
  }, 20_000);

  it("hard watchdog trips only after the timeout while a frame-starved seek is armed", async () => {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});
    const LIMIT = (MoviPlayer as any).SEEK_SYNC_HARD_TIMEOUT_MS as number;

    // Not waiting → never trips.
    Object.assign(player as any, {
      waitingForVideoSync: false,
      seekSyncArmedAt: 1000,
    });
    expect((player as any).seekSyncHardTimedOut(1000 + LIMIT + 1)).toBe(false);

    // Waiting, armed, but still within the limit → hold.
    Object.assign(player as any, {
      waitingForVideoSync: true,
      seekSyncArmedAt: 1000,
    });
    expect((player as any).seekSyncHardTimedOut(1000 + LIMIT - 1)).toBe(false);

    // Waiting past the limit → trip (terminal completion).
    expect((player as any).seekSyncHardTimedOut(1000 + LIMIT + 1)).toBe(true);

    // Disarmed (armedAt 0) → never trips even if long elapsed.
    (player as any).seekSyncArmedAt = 0;
    expect((player as any).seekSyncHardTimedOut(1_000_000)).toBe(false);
  }, 20_000);

  it("clears the read-ahead cap and watchdog arming when a seek really completes", async () => {
    stubBrowserGlobals();
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});
    const seeked = vi.fn();
    player.trackManager.setTracks([videoTrack]);
    player.on("seeked", seeked);

    const stateManager = (player as any).stateManager;
    stateManager.setState("loading");
    stateManager.setState("ready");
    stateManager.setState("playing");
    stateManager.setState("seeking");

    Object.assign(player as any, {
      seekSessionId: 1,
      seekArmedSessionId: 1,
      seekTargetTime: 42,
      waitingForVideoSync: true,
      seekSyncArmedAt: 5,
      seekDemuxAheadTime: 55,
      // Paused-completion path: no resume machinery, but the seek still fully
      // completes and the read-ahead/watchdog arming must be cleared.
      wasPlayingBeforeSeek: false,
      wasPlayingBeforeRebuffer: false,
      videoRenderer: {
        getQueueSize: () => 1,
      },
    });

    // forced=false, first frame present → real completion (paused) path.
    (player as any).notifySeekCompletion(42);

    expect((player as any).waitingForVideoSync).toBe(false);
    expect((player as any).seekSyncArmedAt).toBe(0);
    expect((player as any).seekDemuxAheadTime).toBe(-1);
    expect((player as any).seekReadAheadExceeded()).toBe(false);
    expect((player as any).seekSyncHardTimedOut(10_000_000)).toBe(false);
  }, 20_000);

  it("does not start pause-time prebuffer while a seek is still waiting for video sync", async () => {
    const setIntervalSpy = vi.fn(() => 123);
    vi.stubGlobal("document", {
      hidden: false,
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval: setIntervalSpy,
      clearInterval: vi.fn(),
    });
    const { MoviPlayer } = await import("../../src/core/MoviPlayer");
    const player = new MoviPlayer({});

    Object.assign(player as any, {
      demuxer: {},
      eofReached: false,
      waitingForVideoSync: true,
      seekTargetTime: 42,
    });

    (player as any).startPauseBuffering();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect((player as any).pauseBufferTimerId).toBeNull();
  }, 20_000);
});
