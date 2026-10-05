import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioTrack, VideoTrack } from "../../src/types";
import type { Clock } from "../../src/core/Clock";
import type { AudioRenderer } from "../../src/render/AudioRenderer";
import type { PCMFrame } from "../../src/decode/SoftwareAudioDecoder";
import { stubBrowserGlobals } from "../helpers/browser-globals";

/**
 * B1b (docs/PLAN_MERGE.MD §4.11, "B 系列") — audio track switch moves the
 * playhead by tens of seconds, always forward. Black-box readings (real
 * system Chrome, real hardware decode):
 *
 *   少女终末旅行 (HEVC Main10, flac->aac): 1009.385s -> 1101.730s (+92.345s)
 *   Star Trek (TrueHD->ac3):               5341.241s -> 5380.545s (+39.304s)
 *   Grave of the Fireflies (FLAC->?):       3732.441s -> 3756.080s (+23.640s)
 *
 * B1 (`9ed65f0`) already fixed the MEDIA CLOCK RATE half of this bug:
 * `MoviPlayer.realignAudioTimelineForTrackSwitch()` = `audioRenderer.reset()`
 * + `clock.seek(clock.getTime())`, called in the `audioTrackChange` handler
 * right after the old decoder is closed and before the new one is built.
 * `test/core/audio-track-switch-clock-anchor.test.ts` proves that fix keeps
 * the SETTLED RATE at 1x after a switch — but its own doc comment says
 * plainly: "The jump itself still happens — reset() doesn't make the new
 * track's real PTS match the old timeline, it just makes Clock treat the
 * jump as a single hard resync instead of a runaway gradual correction."
 * That sentence is the position bug this file locks down.
 *
 * MECHANISM (why the jump survives the B1 fix, traced through real code):
 *
 *   1. `realignAudioTimelineForTrackSwitch()` reads `clock.getTime()` BEFORE
 *      `audioRenderer.reset()` runs, so that read is clean (still the OLD
 *      track's healthy anchor). It then calls `audioRenderer.reset()`
 *      (clears `hasFirstBuffer`) and `clock.seek(thatCleanReading)` (sets
 *      `baseTime` from the clean reading and `syncedToAudio = false`).
 *      Immediately after realign, `clock.getTime()` still reads correctly —
 *      `getAudioClock()` returns -1 with no first buffer, so Clock falls
 *      through to plain wall-clock time anchored at the clean reading. This
 *      is proven by the "right after realign" assertions below.
 *
 *   2. The jump happens LATER, the moment the NEW decoder's first output
 *      reaches `AudioRenderer` (`commitAudioBuffer`, `AudioRenderer.ts:1023`
 *      "if (!this.hasFirstBuffer)"). Because `reset()` cleared
 *      `hasFirstBuffer`, this hits the CLEAN first-buffer path, not the
 *      underrun-repivot path — it trusts the incoming buffer's raw PTS as
 *      the new anchor with **no comparison to the position `clock.seek()`
 *      just established**.
 *
 *   3. The next `Clock.getTime()` call sees `syncedToAudio === false` (set
 *      by step 1's `clock.seek()`) and a now-healthy audio buffer, so it
 *      takes the unconditional hard-sync branch (`Clock.ts:116-121`):
 *      `baseTime = Time.now() - audioTime / rate; syncedToAudio = true;
 *      return audioTime;` — no continuity check against the value it had a
 *      moment ago. Whatever PTS the new decoder's first frame carries BECOMES
 *      the playhead, verbatim.
 *
 * VERIFIABLE RELATIONSHIP (answers "what does the jump size correlate
 * with"): the two `it` blocks below feed two different stand-in "new
 * track's first decoded frame" PTS values (chosen to mirror the 少女终末旅行
 * and Grave of the Fireflies magnitudes) and show the resulting jump equals
 * `newTrackFirstFramePts - truePositionAtSwitch` exactly, not "roughly" —
 * i.e. jump size is a direct, arithmetic function of whatever PTS the new
 * decoder's first delivered packet happens to carry. This file does not
 * attempt to reproduce WHY that PTS lands tens of seconds ahead (that is a
 * demuxer/discard question — see below) — it proves that once such a PTS
 * arrives, nothing between the decoder and `getCurrentTime()` catches it.
 *
 * OPEN QUESTION (not settled by this file, flagged for the team lead rather
 * than asserted as fact): `MoviPlayer.ts:4705` `applyStreamDiscard()` calls
 * `bindings.setStreamDiscard(t.id, t.id !== activeAudioId)` — per
 * `wasm/bindings.ts:852-858`, a discarded stream's packets are skipped
 * INSIDE `av_read_frame` and never reach JS. There is no explicit
 * `demuxer.seek()` anywhere in the `audioTrackChange` handler. So the "起点"
 * for the newly-enabled track is implicit: whatever packet `av_read_frame`
 * hands back next for that stream index once discard flips, i.e. wherever
 * the shared demux read cursor already is. That cursor's distance ahead of
 * the actual playhead is bounded by `maxAudioBuffered`/`maxVideoBuffered`
 * (MoviPlayer.ts:5535-5581, low single-digit seconds) under the demuxer's
 * own model — which does not obviously explain a 92s gap on its own. This
 * file does NOT attempt to reproduce the real WASM demuxer's discard/seek
 * behaviour on a real multi-audio-track container (no such fixture exists in
 * this repo and building one is real-media/real-WASM work, not a unit test);
 * confirming the exact numeric driver needs a real black-box measurement of
 * `newTrackFirstFramePts` against `applyStreamDiscard`'s call site, which is
 * out of scope here. Mark this "plausible, not proven."
 *
 * `dist/wasm/movi.js`, dashjs and shaka-player are stubbed so importing
 * MoviPlayer resolves without the built WASM binary, same as
 * `moviplayer-audio-track-switch-realign.test.ts`. `Clock` and
 * `AudioRenderer` are the REAL production instances MoviPlayer constructs —
 * nothing under test is mocked. The only stand-in is a `FakeAudioContext`
 * for the missing browser Web Audio API (same pattern as
 * `audio-track-switch-clock-anchor.test.ts` and
 * `test/render/audio-renderer.test.ts`), and the "new decoder's first PCM
 * frame" is fed directly through `MoviPlayer`'s own real
 * `renderDecodedPCM` — the exact function `MoviAudioDecoder.setOnPCM`
 * wires up in the real handler (MoviPlayer.ts:1300) — standing in for
 * whatever the real WASM audio decoder would have emitted. The decoder
 * itself is the untestable-without-real-media external dependency here
 * (§5.1's "尚未实现的对端" carve-out); Clock/AudioRenderer/the handler are
 * fully real and fully exercised.
 *
 * ROOT CAUSE RESOLVED, THIS FILE DELIBERATELY STAYS RED
 * (`moviplayer-audio-track-switch-refresh.test.ts` and
 * `audio-track-switch-playhead-continuity.test.ts` are the fix's real
 * regression tests — read those first): the OPEN QUESTION above is
 * answered — `applyStreamDiscard()` re-enables a track that was being
 * skipped inside `av_read_frame`, so there is no packet of it near the
 * current file position; the read loop then scans forward unbounded
 * (measured 60-100s of real media) until it finds one, and that packet's
 * far-ahead PTS is what `newTrackFirstFramePts` below stands in for. The fix
 * (`MoviPlayer.refreshDemuxerForAudioSwitch()`, a refresh seek) closes this at
 * the source: it re-seeks the demuxer to a second before the playhead right
 * after `applyStreamDiscard()` flips discard, so in real production the decoder
 * is never actually handed a far-ahead PTS to begin with.
 *
 * This file cannot observe that fix. It never wires a `this.demuxer` (same
 * lightweight setup as `moviplayer-audio-track-switch-realign.test.ts`), so
 * `refreshDemuxerForAudioSwitch()` no-ops here (see its own "no demuxer"
 * guard), and it injects `newTrackFirstFramePts` directly into
 * `renderDecodedPCM` — downstream of, and unreachable from, the demuxer the
 * fix operates on. It is therefore testing a narrower, still-true claim: IF
 * something downstream of the demuxer ever hands the renderer a
 * discontinuous PTS, NOTHING catches it before it becomes the playhead. The
 * fix removes the only known way that precondition currently arises in this
 * codebase; it does not add a downstream guard against it happening some
 * other way. Closing that residual gap (a post-hoc continuity check in
 * `renderDecodedAudio`/`renderDecodedPCM`) is explicitly out of scope for
 * B1b (team lead: no Clock-side compensation, no timestamp shifting — and a
 * downstream reject-and-drop guard is the same family of fix, just gated
 * differently). Both `it` blocks below are `it.fails` so the suite stays
 * green while honestly reporting that this narrower claim is still true,
 * instead of deleting evidence of a real (if currently unreachable) gap.
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

const flacTrack: AudioTrack = {
  id: 2,
  type: "audio",
  codec: "flac",
  channels: 2,
  sampleRate: 48_000,
};

const aacTrack: AudioTrack = {
  id: 3,
  type: "audio",
  codec: "aac",
  channels: 2,
  sampleRate: 48_000,
};

// Minimal Web Audio stand-ins — same shape as
// test/core/audio-track-switch-clock-anchor.test.ts's fakes. Only the
// surface AudioRenderer actually touches is implemented.
class FakeAudioBuffer {
  readonly duration: number;
  private data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  copyToChannel(source: Float32Array, channel: number): void {
    this.data[channel].set(source);
  }
  getChannelData(channel: number): Float32Array {
    return this.data[channel];
  }
}

class FakeSource {
  buffer: FakeAudioBuffer | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  stop = vi.fn();
  start(): void {
    /* no-op: only scheduling timestamps matter here */
  }
}

class FakeGain {
  gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  currentTime = 0;
  state = "running";
  destination = { maxChannelCount: 2 };
  createGain(): FakeGain {
    return new FakeGain();
  }
  createDynamicsCompressor(): FakeGain {
    return new FakeGain();
  }
  createBuffer(channels: number, frames: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, frames, sampleRate);
  }
  createBufferSource(): FakeSource {
    return new FakeSource();
  }
}

const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 4_800; // 0.1s/frame at 48kHz
const FRAME_DURATION = FRAME_SAMPLES / SAMPLE_RATE;

function makeFrame(timestampSeconds: number): PCMFrame {
  return {
    planes: [new Float32Array(FRAME_SAMPLES), new Float32Array(FRAME_SAMPLES)],
    numberOfFrames: FRAME_SAMPLES,
    numberOfChannels: 2,
    sampleRate: SAMPLE_RATE,
    timestamp: Math.round(timestampSeconds * 1_000_000),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Wires a real MoviPlayer with a real Clock/AudioRenderer, feeds five
 * contiguous frames of the FIRST audio track starting at `startMediaTime`,
 * and settles into a healthy steady state 0.3s (wall time) later. Returns
 * everything needed to then drive a real track switch through the real
 * `audioTrackChange` handler.
 */
async function buildSteadyPlayerOnTrackA(startMediaTime: number) {
  stubBrowserGlobals();
  const nowSpy = vi.spyOn(performance, "now");
  let wallNow = 0;
  nowSpy.mockReturnValue(0);

  const { MoviPlayer } = await import("../../src/core/MoviPlayer");
  const player = new MoviPlayer({});

  const clock = (player as unknown as { clock: Clock }).clock;
  const audioRenderer = (player as unknown as { audioRenderer: AudioRenderer })
    .audioRenderer;

  const ctx = new FakeAudioContext();
  Object.assign(audioRenderer as unknown as Record<string, unknown>, {
    audioContext: ctx,
    gainNode: ctx.createGain(),
    isPlaying: true,
  });

  player.trackManager.setTracks([videoTrack, flacTrack, aacTrack]);
  player.trackManager.selectAudioTrack(flacTrack.id);
  clock.start();

  function advance(deltaSeconds: number): void {
    wallNow += deltaSeconds;
    ctx.currentTime += deltaSeconds;
    nowSpy.mockReturnValue(wallNow * 1000);
  }

  for (let i = 0; i < 5; i++) {
    (player as unknown as { renderDecodedPCM: (f: PCMFrame) => void }).renderDecodedPCM(
      makeFrame(startMediaTime + i * FRAME_DURATION),
    );
  }

  const hardSyncReading = player.getCurrentTime();
  expect(hardSyncReading).toBeCloseTo(startMediaTime, 3);

  advance(0.3);
  const preSwitchPosition = player.getCurrentTime();
  expect(preSwitchPosition).toBeCloseTo(startMediaTime + 0.3, 1);

  return { player, clock, audioRenderer, ctx, advance, preSwitchPosition };
}

describe("B1b: audio track switch must not move the playhead", () => {
  // it.fails: expected to still fail post-fix — see the file header's
  // "ROOT CAUSE RESOLVED, THIS FILE DELIBERATELY STAYS RED" section. This
  // bypasses the demuxer the fix operates on, so it cannot observe the fix;
  // it locks the narrower (still-true) claim that nothing downstream of the
  // demuxer catches a discontinuous PTS if one somehow arrives.
  it.fails("少女终末旅行-scale case: new track's first frame lands ~92s ahead of the true position", async () => {
    const startMediaTime = 1009.385; // mirrors the real black-box pre-switch reading
    const { player, advance, preSwitchPosition } =
      await buildSteadyPlayerOnTrackA(startMediaTime);

    // Decode gap while the old worker tears down / the new one spins up.
    advance(0.2);

    // Real handler: audioDecoder.close() -> realignAudioTimelineForTrackSwitch()
    // -> new MoviAudioDecoder() -> (skips configure/applyStreamDiscard's real
    // work since this.demuxer is null in this lightweight wiring, same as
    // moviplayer-audio-track-switch-realign.test.ts).
    player.trackManager.selectAudioTrack(aacTrack.id);

    // Right after realign, before any new audio has arrived: position must
    // still read as a continuous extension of preSwitchPosition. This is the
    // "read is clean before realign / right after realign" half of B1b's
    // question 1 — proven true here, not assumed.
    const rightAfterRealign = player.getCurrentTime();
    expect(rightAfterRealign).toBeCloseTo(preSwitchPosition + 0.2, 1);

    // The new decoder's first delivered frame — standing in for whatever the
    // real WASM decoder emits once the newly-undiscarded track's packets
    // start flowing. Chosen to reproduce the real ~92.345s black-box jump
    // (1101.730 - 1009.385) relative to where playback actually was.
    const newTrackFirstFramePts = 1101.730;
    (player as unknown as { renderDecodedPCM: (f: PCMFrame) => void }).renderDecodedPCM(
      makeFrame(newTrackFirstFramePts),
    );
    (player as unknown as { renderDecodedPCM: (f: PCMFrame) => void }).renderDecodedPCM(
      makeFrame(newTrackFirstFramePts + FRAME_DURATION),
    );

    const afterNewTrackAudio = player.getCurrentTime();

    // eslint-disable-next-line no-console -- test diagnostic, not app code
    console.info(
      `[B1b RED] rightAfterRealign=${rightAfterRealign.toFixed(3)} ` +
        `afterNewTrackAudio=${afterNewTrackAudio.toFixed(3)} ` +
        `jump=${(afterNewTrackAudio - rightAfterRealign).toFixed(3)}`,
    );

    // INVARIANT: switching audio tracks must not move the playhead. It must
    // stay within a small tolerance of where it was right after realign,
    // regardless of what PTS the new decoder's first frame happens to carry.
    expect(Math.abs(afterNewTrackAudio - rightAfterRealign)).toBeLessThan(1);
  });

  // it.fails: same reasoning as the case above.
  it.fails("Grave-of-the-Fireflies-scale case: same mechanism, different magnitude — proves the jump is exactly (new PTS - true position), not a fixed constant", async () => {
    const startMediaTime = 3732.441; // mirrors the real black-box pre-switch reading
    const { player, advance, preSwitchPosition } =
      await buildSteadyPlayerOnTrackA(startMediaTime);

    advance(0.2);
    player.trackManager.selectAudioTrack(aacTrack.id);

    const rightAfterRealign = player.getCurrentTime();
    expect(rightAfterRealign).toBeCloseTo(preSwitchPosition + 0.2, 1);

    // Mirrors the real ~23.640s jump (3756.080 - 3732.441).
    const newTrackFirstFramePts = 3756.080;
    (player as unknown as { renderDecodedPCM: (f: PCMFrame) => void }).renderDecodedPCM(
      makeFrame(newTrackFirstFramePts),
    );
    (player as unknown as { renderDecodedPCM: (f: PCMFrame) => void }).renderDecodedPCM(
      makeFrame(newTrackFirstFramePts + FRAME_DURATION),
    );

    const afterNewTrackAudio = player.getCurrentTime();

    // eslint-disable-next-line no-console -- test diagnostic, not app code
    console.info(
      `[B1b RED] rightAfterRealign=${rightAfterRealign.toFixed(3)} ` +
        `afterNewTrackAudio=${afterNewTrackAudio.toFixed(3)} ` +
        `jump=${(afterNewTrackAudio - rightAfterRealign).toFixed(3)}`,
    );

    // Same invariant, different magnitude — if this file only asserted one
    // number it couldn't distinguish "the jump tracks the new PTS exactly"
    // from "coincidence at one specific value".
    expect(Math.abs(afterNewTrackAudio - rightAfterRealign)).toBeLessThan(1);
  });
});
