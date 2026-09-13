#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const baseUrl = required("OPENLIST_BASE_URL").replace(/\/$/, "");
const username = required("OPENLIST_USERNAME");
const password = required("OPENLIST_PASSWORD");
const pageUrl = process.env.MOVI_BLACKBOX_PAGE_URL ?? "http://127.0.0.1:4173/dev/";
const outputPath = resolve(
  process.env.MOVI_BLACKBOX_OUTPUT ?? ".blackbox-results/real-openlist.json",
);
const sampleMs = Number(process.env.MOVI_BLACKBOX_SAMPLE_MS ?? 10_000);
const postSeekSampleMs = Number(
  process.env.MOVI_BLACKBOX_POST_SEEK_SAMPLE_MS ?? 8_000,
);
const subtitleProbeMs = Number(
  process.env.MOVI_BLACKBOX_SUBTITLE_PROBE_MS ?? 12_000,
);
// How long each of the shorter probe phases (pause/resume, background,
// audio-track switch) is sampled for. Shorter than the steady window on
// purpose: these are transition tests, and the session already pays for seven
// samples of the steady one.
const phaseSampleMs = Number(process.env.MOVI_BLACKBOX_PHASE_SAMPLE_MS ?? 4_000);
// How long a seek gets to produce a running clock again before the phase is
// declared failed. Deliberately generous — see the recovery numbers recorded
// per sample in the report; this bounds the harness, it is not an SLO.
const seekRecoveryMs = Number(
  process.env.MOVI_BLACKBOX_SEEK_RECOVERY_MS ?? 60_000,
);
// Number of back-to-back seeks issued without waiting for the previous one, and
// the gap between them. This is the pressure test for the demuxer's FIFO op
// chain, P3's restart barrier and A5's worker generation gating.
const rapidSeekCount = Number(process.env.MOVI_BLACKBOX_RAPID_SEEKS ?? 5);
const rapidSeekGapMs = Number(process.env.MOVI_BLACKBOX_RAPID_SEEK_GAP_MS ?? 300);
const traceTransitions =
  process.env.MOVI_BLACKBOX_TRACE_TRANSITIONS === "1";
// Diagnostic-only escape hatch for hosts whose browser cannot expose a
// hardware WebCodecs backend. The default remains strict and release evidence
// must never set this flag.
const allowNoPreference =
  process.env.MOVI_BLACKBOX_ALLOW_NO_PREFERENCE === "1";
const mediaPaths = required("OPENLIST_MEDIA_PATHS")
  .split("\n")
  .map((path) => path.trim())
  .filter(Boolean);

if (mediaPaths.length < 1) throw new Error("OPENLIST_MEDIA_PATHS has no paths");

async function api(path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenList ${path} returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.code !== 200) {
    throw new Error(`OpenList ${path} failed with code ${result.code}: ${result.message}`);
  }
  return result.data;
}

function basename(path) {
  return path.split("/").filter(Boolean).at(-1) ?? "unknown";
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const element = document.querySelector("movi-player");
    const player = element?.player ?? null;
    const renderer = player?.videoRenderer ?? null;
    const audio = player?.audioRenderer ?? null;
    const source = player?.source ?? null;
    const stats = player?.getStats?.() ?? {};
    return {
      wallMs: performance.now(),
      currentTime: Number(element?.currentTime ?? 0),
      duration: Number(element?.duration ?? 0),
      state: String(player?.getState?.() ?? "missing"),
      framesPresented: Number(
        renderer?.getStats?.().framesPresented ?? renderer?.framesPresented ?? 0,
      ),
      frameQueue: Number(renderer?.frameQueue?.length ?? 0),
      frameQueueHeadTime: Number(
        renderer?.frameQueue?.[0]?.timestamp != null
          ? renderer.frameQueue[0].timestamp / 1_000_000
          : -1,
      ),
      frameQueueTailTime: Number(
        renderer?.frameQueue?.length
          ? renderer.frameQueue.at(-1).timestamp / 1_000_000
          : -1,
      ),
      rendererCurrentTime: Number(renderer?.currentTime ?? -1),
      rendererLastPresentedPts: Number(renderer?.lastPresentedPts ?? -1),
      rendererPresentationStartPts: Number(renderer?.presentationStartPts ?? -1),
      rendererSyncedToAudio: Boolean(renderer?.syncedToAudio),
      videoBufferedSeconds: Number(renderer?.getBufferedDuration?.() ?? 0),
      audioMediaTime: Number(audio?.currentMediaTime ?? 0),
      audioClock: Number(audio?.getAudioClock?.() ?? -1),
      audioScheduled: Number(audio?.scheduledCount ?? 0),
      decodePath: String(stats["Decode Path"] ?? ""),
      videoDecoder: String(stats["Video Decoder"] ?? ""),
      audioDecoder: String(stats["Audio Decoder"] ?? ""),
      videoCodec: String(stats["Video Codec"] ?? ""),
      audioCodec: String(stats["Audio Codec"] ?? ""),
      playbackState: String(stats["Playback State"] ?? ""),
      masterClock: String(stats["Master Clock"] ?? ""),
      playbackInvariant: String(stats["Playback Invariant"] ?? ""),
      playerCurrentTime: Number(player?.getCurrentTime?.() ?? -1),
      seekKeyframeOffset: Number(player?.seekKeyframeOffset ?? -1),
      clockTime: Number(player?.clock?.getTime?.() ?? -1),
      clockRunning: Boolean(player?.clock?.isPlaying?.()),
      clockPausedTime: Number(player?.clock?.pausedTime ?? -1),
      audioUnderrunRisk: String(stats["Audio Underrun Risk"] ?? ""),
      audioUnderrunning: String(stats["Audio Underrunning"] ?? ""),
      audioBufferedSeconds: Number(stats["Audio Buffered Seconds"] ?? 0),
      audioDecoderQueue: Number(stats["Audio Decoder Queue"] ?? 0),
      videoDecoderQueue: Number(stats["Video Decoder Queue"] ?? 0),
      audioWorkerQueueDepth: Number(stats["Audio Worker Queue Depth"] ?? 0),
      audioWorkerInFlight: Number(stats["Audio Worker In Flight"] ?? 0),
      audioWorkerReorderBacklog: Number(
        stats["Audio Worker Reorder Backlog"] ?? 0,
      ),
      audioWorkerStaleDrops: Number(stats["Audio Worker Stale Drops"] ?? 0),
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      webCodecsAvailable: typeof globalThis.VideoDecoder === "function",
      sharedSourceBuffer: Boolean(source?.getSharedBuffer?.()),
      network: source?.getNetworkStats?.() ?? null,
      // The sliding window's capacity, read from the source rather than
      // re-derived here: it is 8% of the file clamped to the configured cache
      // cap, and the byte budget needs the real number, not a guess at it.
      sourceBufferBytes: Number(source?.bufferSize ?? 0),
      paused: Boolean(element && !element.playing),
      backgrounded: Boolean(player?.isBackgrounded),
      visibilityState: String(document.visibilityState),
      audioTracks: (player?.getAudioTracks?.() ?? []).map((track) => ({
        id: Number(track.id),
        codec: String(track.codec ?? ""),
        language: String(track.language ?? ""),
        channels: Number(track.channels ?? 0),
        sampleRate: Number(track.sampleRate ?? 0),
      })),
      activeAudioTrackId: Number(
        player?.trackManager?.getActiveAudioTrack?.()?.id ?? -1,
      ),
      // Hardware resurrection attempts made so far. A software-decoding stream
      // that has no hardware path at all still gets these (the gate only asks
      // whether WebCodecs EXISTS, not whether it can decode this codec), and
      // each attempt costs several seconds of missing frames.
      hardwareRetryCount: Number(player?.videoDecoder?.hardwareRetryCount ?? 0),
      softwareDecoding: Boolean(player?.isSoftwareDecoding?.()),
      softwareDecodeReason: String(player?.softwareDecodeReason?.() ?? ""),
      autoQuality: Boolean(player?._autoQuality),
      dashRenditionCount: Number(player?._dashRenditions?.length ?? 0),
      qualityMenuVisible: Boolean(
        element?.shadowRoot?.querySelector(".movi-quality-container") &&
          element.shadowRoot.querySelector(".movi-quality-container").style
            .display !== "none",
      ),
      canvas: element?.shadowRoot
        ? (() => {
            const canvas = element.shadowRoot.querySelector("canvas");
            return canvas
              ? { width: canvas.width, height: canvas.height }
              : null;
          })()
        : null,
      errors: [...(globalThis.__moviBlackboxErrors ?? [])],
      qoe: [...(globalThis.__moviBlackboxQoe ?? [])].slice(-30),
    };
  });
}

function progression(before, after) {
  const wallSeconds = Math.max(0.001, (after.wallMs - before.wallMs) / 1000);
  // AudioRenderer.currentMediaTime is the latest frame submitted/scheduled,
  // not the playout head; it can advance slowly while a healthy prebuffer is
  // being consumed. The renderer clock is the user-heard position.
  const audioBefore = before.audioClock >= 0
    ? before.audioClock
    : before.audioMediaTime;
  const audioAfter = after.audioClock >= 0
    ? after.audioClock
    : after.audioMediaTime;
  return {
    wallSeconds,
    mediaSeconds: after.currentTime - before.currentTime,
    mediaRate: (after.currentTime - before.currentTime) / wallSeconds,
    frames: after.framesPresented - before.framesPresented,
    presentedFps: (after.framesPresented - before.framesPresented) / wallSeconds,
    audioSeconds: audioAfter - audioBefore,
  };
}

function assertHealthy(label, before, after, phase, options = {}) {
  const generationBudget = options.generationBudget ?? 4;
  const progress = progression(before, after);
  const errors = after.errors.map((entry) => String(entry));
  if (after.state === "error" || after.playbackState === "error") {
    throw new Error(`${label} entered error state during ${phase}`);
  }
  if (after.state === "playing" && !after.clockRunning) {
    throw new Error(
      `${label} reported playing with a stopped master clock during ${phase}`,
    );
  }
  if (after.playbackInvariant !== "OK") {
    throw new Error(
      `${label} reported playback invariant ${after.playbackInvariant || "missing"} during ${phase}`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`${label} emitted ${errors.length} player error(s) during ${phase}`);
  }
  if (progress.frames < 5) {
    // Name the known cause rather than leaving the reader to infer it. A
    // software-decoding stream periodically tries to go back to hardware; the
    // gate for that only asks whether WebCodecs exists, not whether it can
    // decode THIS codec, so a stream with no hardware path retries anyway and
    // loses the frames between the attempt and the fallback. Measured on
    // HEVC Main10: a ~9.6s hole in the presented picture while the audio clock
    // ran on. Present in the fork and upstream alike (identical gating), so it
    // is reported, not silently tolerated.
    const resurrections = after.hardwareRetryCount - before.hardwareRetryCount;
    const attribution =
      resurrections > 0
        ? ` — ${resurrections} hardware resurrection attempt(s) occurred in this window on a ${after.videoDecoder} stream`
        : "";
    throw new Error(
      `${label} presented only ${progress.frames} frames during ${phase}${attribution}`,
    );
  }
  if (progress.mediaRate < 0.65 || progress.mediaRate > 1.35) {
    throw new Error(
      `${label} media clock rate ${progress.mediaRate.toFixed(3)} during ${phase}; expected near 1x`,
    );
  }
  if (
    after.audioCodec &&
    after.audioCodec !== "N/A" &&
    progress.audioSeconds < progress.wallSeconds * 0.45
  ) {
    throw new Error(
      `${label} audio advanced only ${progress.audioSeconds.toFixed(3)}s over ${progress.wallSeconds.toFixed(3)}s during ${phase}`,
    );
  }
  if (!after.canvas || after.canvas.width <= 0 || after.canvas.height <= 0) {
    throw new Error(`${label} has no drawable canvas during ${phase}`);
  }
  // Buffer mode coherence, NOT "SAB must be on".
  //
  // This gate used to require crossOriginIsolated AND a SharedArrayBuffer
  // source. Upstream's vite config deliberately serves the dev page with
  // COOP `same-origin-allow-popups` and NO COEP — it gave up cross-origin
  // isolation on purpose so the OAuth popup keeps working, and recorded that
  // the player does not need SAB (single-threaded WASM + Asyncify I/O, and
  // HttpSource has a plain-buffer fallback). So the page under test is
  // legitimately not isolated, and the old gate would fail every sample for a
  // reason that is the shipped configuration.
  //
  // What is still worth asserting is that the two agree: a SharedArrayBuffer
  // source can only exist where the page IS isolated, and claiming isolation
  // without one would mean the source silently took the fallback on a page
  // that could have had the fast path. The mode itself is recorded per sample
  // so the report says which path the evidence covers.
  if (after.sharedSourceBuffer && !after.crossOriginIsolated) {
    throw new Error(
      `${label} reports a SharedArrayBuffer source on a page that is not cross-origin isolated`,
    );
  }
  if (after.crossOriginIsolated && !after.sharedSourceBuffer) {
    throw new Error(
      `${label} ran on a cross-origin isolated page but fell back to the plain buffer`,
    );
  }
  if (!after.webCodecsAvailable) {
    throw new Error(`${label} ran without the browser WebCodecs API`);
  }
  if (after.network) {
    if (Number(after.network.readStalls ?? 0) !== 0) {
      throw new Error(`${label} recorded HTTP source stalls during ${phase}`);
    }
    if (Number(after.network.bufferWaiters ?? 0) !== 0) {
      throw new Error(`${label} left HTTP buffer waiters pending during ${phase}`);
    }
    if (Number(after.network.streamGeneration ?? 0) > generationBudget) {
      throw new Error(
        `${label} opened ${after.network.streamGeneration} HTTP stream generations during ${phase}; budget=${generationBudget}`,
      );
    }
  }
  return progress;
}

// ─── Byte budget ───────────────────────────────────────────────────────────
//
// "30 seconds of playback must not download the whole 19GB file" was recorded
// in the report and never asserted. This is the assertion.
//
// The ceiling is derived from the source's own fetching strategy rather than
// picked:
//
//   * Streaming at ~1x for W wall-seconds consumes about W x (size/duration)
//     bytes. `VBR_SLACK` covers the fact that any given stretch of a
//     variable-bitrate file runs above the file's average — a dialogue-free
//     action sequence on the MPEG-2 sample is the worst case — and covers the
//     container index / Cues / moov reads the demuxer makes on top of the
//     picture.
//   * Each stream generation opens with a FIRST_RANGE_CHUNK (4MiB) and can
//     have at most one MAX_RANGE_CHUNK (8MiB) fill in flight when it is
//     superseded, so a generation costs at most 12MiB of waste.
//   * The source holds one sliding window of read-ahead. `bufferSize` is 8% of
//     the file clamped to the configured cache cap, and is read live off the
//     source instead of being re-derived here.
//
// Paused time only reduces consumption, so wall-clock is a sound upper bound
// for the streaming term.
const FIRST_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;
const VBR_SLACK = 2.5;

function byteBudget({ sizeBytes, durationSeconds, wallSeconds, generations, windowBytes }) {
  const bitrate = durationSeconds > 0 ? sizeBytes / durationSeconds : 0;
  const streamed = wallSeconds * bitrate * VBR_SLACK;
  const perGeneration =
    Math.max(1, generations) * (FIRST_RANGE_CHUNK_BYTES + MAX_RANGE_CHUNK_BYTES);
  const total = streamed + perGeneration + windowBytes;
  return {
    bitrateBytesPerSecond: Math.round(bitrate),
    streamedTerm: Math.round(streamed),
    generationTerm: perGeneration,
    windowTerm: windowBytes,
    budgetBytes: Math.round(total),
  };
}

function assertByteBudget(label, { sizeBytes, durationSeconds, wallSeconds, snapshot: final }) {
  const totalBytes = numeric(final.network?.totalBytes);
  const generations = numeric(final.network?.streamGeneration);
  const windowBytes = numeric(final.sourceBufferBytes);
  const budget = byteBudget({
    sizeBytes,
    durationSeconds,
    wallSeconds,
    generations,
    windowBytes,
  });
  const detail = {
    totalBytes,
    sizeBytes,
    fractionOfFile: sizeBytes > 0 ? totalBytes / sizeBytes : 0,
    wallSeconds: Number(wallSeconds.toFixed(1)),
    generations,
    ...budget,
    headroom: budget.budgetBytes > 0 ? totalBytes / budget.budgetBytes : 0,
  };
  if (totalBytes > budget.budgetBytes) {
    throw new Error(
      `${label} downloaded ${totalBytes} bytes, over the derived budget of ${budget.budgetBytes}: ${JSON.stringify(detail)}`,
    );
  }
  // Independent of the derivation: a session this short must not have pulled
  // half the file, whatever the arithmetic above says. Only meaningful for
  // files large enough that it is not trivially true.
  if (sizeBytes > 4 * budget.budgetBytes && totalBytes > sizeBytes * 0.5) {
    throw new Error(
      `${label} downloaded ${(detail.fractionOfFile * 100).toFixed(1)}% of a ${sizeBytes}-byte file: ${JSON.stringify(detail)}`,
    );
  }
  return detail;
}

function compactSnapshot(sample) {
  return {
    currentTime: sample.currentTime,
    playerCurrentTime: sample.playerCurrentTime,
    seekKeyframeOffset: sample.seekKeyframeOffset,
    clockTime: sample.clockTime,
    clockRunning: sample.clockRunning,
    clockPausedTime: sample.clockPausedTime,
    framesPresented: sample.framesPresented,
    frameQueue: sample.frameQueue,
    frameQueueHeadTime: sample.frameQueueHeadTime,
    frameQueueTailTime: sample.frameQueueTailTime,
    rendererCurrentTime: sample.rendererCurrentTime,
    rendererLastPresentedPts: sample.rendererLastPresentedPts,
    rendererPresentationStartPts: sample.rendererPresentationStartPts,
    rendererSyncedToAudio: sample.rendererSyncedToAudio,
    videoBufferedSeconds: sample.videoBufferedSeconds,
    audioMediaTime: sample.audioMediaTime,
    audioClock: sample.audioClock,
    audioBufferedSeconds: sample.audioBufferedSeconds,
    audioDecoderQueue: sample.audioDecoderQueue,
    videoDecoderQueue: sample.videoDecoderQueue,
    audioWorkerQueueDepth: sample.audioWorkerQueueDepth,
    audioWorkerInFlight: sample.audioWorkerInFlight,
    audioWorkerReorderBacklog: sample.audioWorkerReorderBacklog,
    audioWorkerStaleDrops: sample.audioWorkerStaleDrops,
    audioUnderrunRisk: sample.audioUnderrunRisk,
    audioUnderrunning: sample.audioUnderrunning,
    videoDecoder: sample.videoDecoder,
    audioDecoder: sample.audioDecoder,
    state: sample.state,
    masterClock: sample.masterClock,
    playbackInvariant: sample.playbackInvariant,
    network: sample.network,
  };
}

/**
 * Sample a window, retrying once if the renderer's frame counter was reset.
 *
 * `framesPresented` is per-renderer and starts again at zero when the video
 * pipeline is rebuilt — which a hardware resurrection attempt does mid-window.
 * The delta then comes out NEGATIVE, and "presented only -10 frames" is the
 * harness reporting its own arithmetic, not a player fault. Take one more
 * window in that case; a second reset inside the retry is itself the finding
 * and is reported as such.
 */
async function sampleWindow(page, windowMs) {
  let before = await snapshot(page);
  await page.waitForTimeout(windowMs);
  let after = await snapshot(page);
  if (after.framesPresented < before.framesPresented) {
    before = await snapshot(page);
    await page.waitForTimeout(windowMs);
    after = await snapshot(page);
    if (after.framesPresented < before.framesPresented) {
      throw new Error(
        `the video renderer's frame counter reset twice in a row (${before.framesPresented} -> ${after.framesPresented}); the video pipeline is being rebuilt repeatedly`,
      );
    }
  }
  return { before, after };
}

async function assertPlaybackStillAdvances(page, label, phase) {
  const before = await snapshot(page);
  await page.waitForTimeout(1_500);
  const after = await snapshot(page);
  const progress = progression(before, after);
  if (after.state !== "playing" || !after.clockRunning) {
    throw new Error(
      `${label} did not return to a running playing state after ${phase}`,
    );
  }
  if (progress.mediaRate < 0.65 || progress.mediaRate > 1.35) {
    throw new Error(
      `${label} media clock rate ${progress.mediaRate.toFixed(3)} after ${phase}`,
    );
  }
  return progress;
}

// ─── Seeks ─────────────────────────────────────────────────────────────────

/**
 * Wait until the clock is actually running at ~1x, not merely near the target.
 *
 * A seek "arrives" (currentTime lands within a few seconds of the target, state
 * leaves "seeking") well before the pipeline has settled: the clock is still
 * being re-synced to audio, a video-audio gap correction can jump it several
 * seconds, and a software decoder may stall and rebuffer once. Opening the
 * measurement window at arrival catches those jumps and reads them as a media
 * rate of 2.5x — which is what they are, and which says nothing about whether
 * playback is healthy afterwards.
 *
 * Returns the time from `startedAt` to two consecutive one-second windows that
 * both ran at ~1x. That figure is the honest "seek recovery" number, and it is
 * recorded rather than gated — see seekAndSample.
 */
async function waitForStablePlayback(page, startedAt, deadlineMs = seekRecoveryMs) {
  const deadline = startedAt + deadlineMs;
  let consecutive = 0;
  let last = await snapshot(page);
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const now = await snapshot(page);
    if (now.state === "error") {
      throw new Error(`entered error state while waiting for playback to settle`);
    }
    const rate = progression(last, now).mediaRate;
    last = now;
    if (now.state === "playing" && now.clockRunning && rate > 0.7 && rate < 1.3) {
      consecutive++;
      if (consecutive >= 2) return Date.now() - startedAt;
    } else {
      consecutive = 0;
      // A settling pipeline can land in "paused" (the rebuffer path exits
      // through it). Nudge it back, the way a viewer staring at a stopped
      // picture would, rather than waiting out the deadline on it.
      if (now.paused && now.state === "paused") {
        await page.evaluate(() => document.querySelector("movi-player").play());
      }
    }
  }
  throw new Error(
    `playback did not settle to ~1x within ${deadlineMs}ms (state=${last.state}, clockRunning=${last.clockRunning}, currentTime=${last.currentTime.toFixed(2)})`,
  );
}

/** Issue a seek and wait for the element to settle near the target. */
async function seekTo(page, seconds) {
  await page.evaluate((target) => {
    document.querySelector("movi-player").currentTime = target;
  }, seconds);
  await page.waitForFunction(
    (target) => {
      const element = document.querySelector("movi-player");
      return (
        Math.abs(element.currentTime - target) < 5 &&
        ["playing", "paused"].includes(element.player?.getState?.())
      );
    },
    seconds,
    { timeout: seekRecoveryMs },
  );
  if (!(await page.evaluate(() => document.querySelector("movi-player")?.playing))) {
    await page.evaluate(() => document.querySelector("movi-player").play());
  }
}

/**
 * Seek to `seconds`, then sample real playback there.
 *
 * `recoveryMs` — how long from issuing the seek to a running clock at the
 * target — is RECORDED, not asserted against an SLO. The 12s figure in
 * PLAN_MERGE §5.5 is a target the 30GB TrueHD remux does not meet either side
 * of the merge; the numbers per sample are the evidence for that, and turning
 * them into a gate here would only encode a known-failing threshold.
 */
async function seekAndSample(page, label, target, phase, generationBudget) {
  const issuedAt = Date.now();
  await seekTo(page, target);
  const arrivedMs = Date.now() - issuedAt;
  const recoveryMs = await waitForStablePlayback(page, issuedAt);
  const { before, after } = await sampleWindow(page, postSeekSampleMs);
  const progress = assertHealthy(label, before, after, phase, { generationBudget });
  return {
    phase,
    target: Number(target.toFixed(2)),
    arrivedMs,
    recoveryMs,
    ...progress,
  };
}

/**
 * A burst of seeks issued WITHOUT awaiting the previous one.
 *
 * This is the experiment that adjudicates whether the demuxer's plain FIFO op
 * chain is enough, or whether queued seeks need to be collapsed to the latest.
 * If MoviPlayer's seekSessionId supersede is already dropping the redundant
 * ones, the burst costs few stream generations; if every seek in the burst
 * drags its own stream restart behind it, the generation count is what shows
 * that. The number is recorded either way.
 */
async function runRapidSeeks(page, label, duration) {
  const before = await snapshot(page);
  const generationsBefore = numeric(before.network?.streamGeneration);
  const targets = [];
  for (let i = 0; i < rapidSeekCount; i++) {
    // Spread across the middle of the file so each target is a genuinely
    // different position and none of them lands in already-buffered bytes.
    const target = duration * (0.3 + (0.4 * i) / Math.max(1, rapidSeekCount - 1));
    targets.push(Number(target.toFixed(2)));
    await page.evaluate((seconds) => {
      document.querySelector("movi-player").currentTime = seconds;
    }, target);
    await page.waitForTimeout(rapidSeekGapMs);
  }

  const finalTarget = targets.at(-1);
  const burstEndedAt = Date.now();
  await page.waitForFunction(
    (target) => {
      const element = document.querySelector("movi-player");
      return (
        Math.abs(element.currentTime - target) < 5 &&
        ["playing", "paused"].includes(element.player?.getState?.())
      );
    },
    finalTarget,
    { timeout: seekRecoveryMs },
  );
  if (!(await page.evaluate(() => document.querySelector("movi-player")?.playing))) {
    await page.evaluate(() => document.querySelector("movi-player").play());
  }
  const recoveryMs = await waitForStablePlayback(page, burstEndedAt);

  const settled = await snapshot(page);
  const { after } = await sampleWindow(page, postSeekSampleMs);
  const generationsUsed =
    numeric(after.network?.streamGeneration) - generationsBefore;

  const progress = assertHealthy(
    label,
    settled,
    after,
    `${rapidSeekCount} consecutive seeks`,
    // The burst itself is allowed to open streams; what is being bounded is
    // the total, which the byte budget also depends on.
    { generationBudget: generationsBefore + 4 },
  );

  // The FIFO adjudication, stated as a gate: a burst of N seeks where only the
  // last one matters must not cost a stream restart per seek.
  if (generationsUsed > 4) {
    throw new Error(
      `${label} spent ${generationsUsed} stream generations on ${rapidSeekCount} consecutive seeks (budget 4); the demuxer's FIFO seek queue is not collapsing redundant seeks`,
    );
  }
  // It landed on the LAST target, not an earlier one that won the race.
  if (Math.abs(settled.currentTime - finalTarget) > 5) {
    throw new Error(
      `${label} settled at ${settled.currentTime.toFixed(2)}s after a seek burst whose last target was ${finalTarget}s`,
    );
  }

  return {
    targets,
    generationsBefore,
    generationsUsed,
    recoveryMs,
    settledAt: Number(settled.currentTime.toFixed(2)),
    ...progress,
  };
}

// ─── Pause / resume ────────────────────────────────────────────────────────

/**
 * Pause, hold, resume, and require playback to come back.
 *
 * P2's decodeMode, P3's restart barrier and A6's session-shared AudioContext
 * (upstream deleted the fork's close(), so the context must survive this) all
 * sit on this path and none of them was exercised.
 */
async function runPauseResume(page, label) {
  await page.evaluate(() => document.querySelector("movi-player").pause());
  await page.waitForFunction(
    () => document.querySelector("movi-player")?.playing === false,
    null,
    { timeout: 30_000 },
  );
  const paused = await snapshot(page);
  if (paused.clockRunning) {
    throw new Error(`${label} left the master clock running while paused`);
  }
  await page.waitForTimeout(phaseSampleMs);
  const stillPaused = await snapshot(page);
  const drift = Math.abs(stillPaused.currentTime - paused.currentTime);
  if (drift > 0.5) {
    throw new Error(
      `${label} advanced ${drift.toFixed(3)}s of media time while paused`,
    );
  }

  await page.evaluate(async () => {
    await document.querySelector("movi-player").play();
  });
  await page.waitForFunction(
    () => document.querySelector("movi-player")?.playing === true,
    null,
    { timeout: 60_000 },
  );
  const { before, after } = await sampleWindow(page, phaseSampleMs);
  const progress = assertHealthy(label, before, after, "resume after pause", {
    generationBudget: numeric(before.network?.streamGeneration) + 2,
  });
  // A6: the AudioContext is session-shared now. If the pause had closed it,
  // audio would not come back at all — which the audio term of assertHealthy
  // already catches, but say so explicitly.
  if (after.audioCodec && after.audioCodec !== "N/A" && after.audioClock < 0) {
    throw new Error(`${label} has no audio clock after resuming`);
  }
  return { pausedAt: Number(paused.currentTime.toFixed(2)), pausedDrift: drift, ...progress };
}

// ─── Audio track switching ─────────────────────────────────────────────────

/**
 * Switch to every other audio track and require real audio at each one.
 *
 * A5/A5b's worker generation gating had zero black-box coverage. The sample
 * that matters most here carries AAC and FLAC in one file, so the switch
 * crosses two different decoder configurations in the same worker.
 */
async function runAudioTrackSwitch(page, label) {
  const start = await snapshot(page);
  if (start.audioTracks.length < 2) {
    return {
      status: "single-track",
      tracks: start.audioTracks,
      activeTrackId: start.activeAudioTrackId,
    };
  }

  const switched = [];
  for (const track of start.audioTracks) {
    if (track.id === start.activeAudioTrackId) continue;
    const accepted = await page.evaluate(
      (trackId) =>
        Boolean(
          document.querySelector("movi-player")?.player?.selectAudioTrack(trackId),
        ),
      track.id,
    );
    if (!accepted) {
      throw new Error(`${label} refused audio track ${track.id} (${track.codec})`);
    }
    await page.waitForFunction(
      (trackId) =>
        Number(
          document.querySelector("movi-player")?.player?.trackManager
            ?.getActiveAudioTrack?.()?.id ?? -1,
        ) === trackId,
      track.id,
      { timeout: 30_000 },
    );
    if (!(await page.evaluate(() => document.querySelector("movi-player")?.playing))) {
      await page.evaluate(() => document.querySelector("movi-player").play());
    }
    const { before, after } = await sampleWindow(page, phaseSampleMs);
    const progress = assertHealthy(
      label,
      before,
      after,
      `audio track ${track.id} (${track.codec})`,
      { generationBudget: numeric(before.network?.streamGeneration) + 2 },
    );
    if (after.audioWorkerStaleDrops > before.audioWorkerStaleDrops + 64) {
      throw new Error(
        `${label} dropped ${after.audioWorkerStaleDrops - before.audioWorkerStaleDrops} stale worker frames after switching to track ${track.id}; the generation gate is letting the old track's work through`,
      );
    }
    switched.push({
      trackId: track.id,
      codec: track.codec,
      audioDecoder: after.audioDecoder,
      ...progress,
    });
  }

  return { status: "switched", tracks: start.audioTracks, switched };
}

// ─── Quality / ABR ─────────────────────────────────────────────────────────

/**
 * What CAN be asserted about quality on a single-file source.
 *
 * The quality menu and the ABR both key off adaptive renditions: the element
 * only builds a menu for HLS/DASH/host-supplied premuxed lists, and the ABR's
 * rung table is `_dashRenditions`, which is empty for a plain raw_url. Every
 * sample in the OpenList matrix is a single-file MKV/MP4, so there is no rung
 * to switch TO and a "switch quality" step would assert nothing.
 *
 * What is covered here is the guard: the menu must stay hidden, turning Auto
 * on must be accepted, and the ABR timer it starts must not disturb playback.
 * Rung switching itself needs an adaptive fixture and is reported as not
 * executed rather than claimed.
 */
async function runQualityProbe(page, label) {
  const before = await snapshot(page);
  if (before.dashRenditionCount > 1) {
    // An adaptive source did turn up — exercise the real switch rather than
    // the guard, so this does not silently under-test a fixture that grew.
    await page.evaluate(() => {
      document.querySelector("movi-player")?.player?.setAutoQuality(true);
    });
    const after = await snapshot(page);
    return {
      status: "adaptive-source-present",
      renditions: after.dashRenditionCount,
      autoQuality: after.autoQuality,
    };
  }

  if (before.qualityMenuVisible) {
    throw new Error(
      `${label} shows a quality menu for a single-rendition source`,
    );
  }
  await page.evaluate(() => {
    document.querySelector("movi-player")?.player?.setAutoQuality(true);
  });
  const enabled = await snapshot(page);
  if (!enabled.autoQuality) {
    throw new Error(`${label} refused setAutoQuality(true)`);
  }
  const { after } = await sampleWindow(page, phaseSampleMs);
  const progress = assertHealthy(label, enabled, after, "ABR enabled", {
    generationBudget: numeric(enabled.network?.streamGeneration) + 2,
  });
  await page.evaluate(() => {
    document.querySelector("movi-player")?.player?.setAutoQuality(false);
  });
  return {
    status: "single-rendition",
    renditions: before.dashRenditionCount,
    menuHidden: true,
    ...progress,
  };
}

// ─── Background / foreground ───────────────────────────────────────────────

/**
 * Hide the page, hold, and bring it back.
 *
 * A headless page is never really hidden, so `document.visibilityState` is
 * redefined and the REAL `visibilitychange` event is dispatched: the player's
 * own handler then runs unmodified — background timer instead of rAF, video
 * presentation stopped, queue cleared, AudioContext resumed on return. That is
 * providing the environment, in the same sense as handing a unit test a real
 * EventTarget for `self`; nothing in the handler is replaced.
 *
 * Note the launch flags disable timer throttling, so this covers the player's
 * own backgrounding logic and NOT the browser's throttling of it.
 */
async function runVisibilityCycle(page, label) {
  const before = await snapshot(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(
    () => document.querySelector("movi-player")?.player?.isBackgrounded === true,
    null,
    { timeout: 15_000 },
  );
  const hiddenBefore = await snapshot(page);
  await page.waitForTimeout(phaseSampleMs);
  const hiddenAfter = await snapshot(page);
  // Hidden: the picture is deliberately not decoded, so frames are NOT
  // expected. Audio is the playback here and it has to keep moving.
  const hiddenProgress = progression(hiddenBefore, hiddenAfter);
  if (hiddenAfter.state === "error") {
    throw new Error(`${label} entered error state while backgrounded`);
  }
  if (
    hiddenAfter.audioCodec &&
    hiddenAfter.audioCodec !== "N/A" &&
    hiddenProgress.audioSeconds < hiddenProgress.wallSeconds * 0.45
  ) {
    throw new Error(
      `${label} audio advanced only ${hiddenProgress.audioSeconds.toFixed(3)}s over ${hiddenProgress.wallSeconds.toFixed(3)}s while backgrounded`,
    );
  }

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(
    () => document.querySelector("movi-player")?.player?.isBackgrounded === false,
    null,
    { timeout: 15_000 },
  );
  if (!(await page.evaluate(() => document.querySelector("movi-player")?.playing))) {
    await page.evaluate(() => document.querySelector("movi-player").play());
  }
  const { before: visibleBefore, after: visibleAfter } = await sampleWindow(
    page,
    phaseSampleMs,
  );
  const visibleProgress = assertHealthy(
    label,
    visibleBefore,
    visibleAfter,
    "returned to foreground",
    { generationBudget: numeric(visibleBefore.network?.streamGeneration) + 2 },
  );
  return {
    backgroundedAt: Number(before.currentTime.toFixed(2)),
    hidden: hiddenProgress,
    foreground: visibleProgress,
  };
}

async function validateSubtitles(page, label) {
  const tracks = await page.evaluate(() => {
    const player = document.querySelector("movi-player")?.player;
    return (player?.getSubtitleTracks?.() ?? []).map((track) => ({
      id: Number(track.id),
      codec: String(track.codec ?? ""),
      language: String(track.language ?? ""),
      title: String(track.title ?? ""),
      subtitleType: String(track.subtitleType ?? ""),
    }));
  });
  if (tracks.length === 0) {
    return { status: "not-present", tracks: [], attempts: [] };
  }

  const attempts = [];
  const preferredTrackOrder = (track) => {
    const language = track.language.toLowerCase();
    if (["eng", "en"].includes(language)) return 0;
    if (["zho", "chi", "zh"].includes(language)) return 1;
    if (!language || language === "und") return 2;
    return 3;
  };
  const candidates = (type) =>
    tracks
      .filter((track) => track.subtitleType === type)
      .sort((a, b) => preferredTrackOrder(a) - preferredTrackOrder(b))
      .slice(0, 4);
  const textTracks = candidates("text");
  for (const track of textTracks) {
    const configured = await page.evaluate(
      (trackId) =>
        document.querySelector("movi-player")?.player?.selectSubtitleTrack(trackId),
      track.id,
    );
    if (!configured) {
      attempts.push({ trackId: track.id, result: "configure-failed" });
      continue;
    }
    const duration = await page.evaluate(
      () => Number(document.querySelector("movi-player")?.duration ?? 0),
    );
    for (const target of [duration * 0.35, duration * 0.2, duration * 0.5, duration * 0.75]) {
      await page.evaluate((seconds) => {
        document.querySelector("movi-player").currentTime = seconds;
      }, target);
      await page.waitForFunction(
        (seconds) => {
          const element = document.querySelector("movi-player");
          return (
            Math.abs(element.currentTime - seconds) < 5 &&
            ["playing", "paused"].includes(element.player?.getState?.())
          );
        },
        target,
        { timeout: 60_000 },
      );
      if (!(await page.evaluate(() => document.querySelector("movi-player")?.playing))) {
        await page.evaluate(() => document.querySelector("movi-player").play());
      }
      try {
        await page.waitForFunction(
          () => {
            const player = document.querySelector("movi-player")?.player;
            const renderer = player?.videoRenderer;
            const overlay = renderer?.subtitleOverlay;
            return Boolean(
              renderer?.activeSubtitleCue?.text &&
                overlay &&
                overlay.style.display !== "none" &&
                overlay.textContent?.trim(),
            );
          },
          null,
          { timeout: subtitleProbeMs },
        );
        const rendered = await page.evaluate(() => {
          const renderer = document.querySelector("movi-player")?.player?.videoRenderer;
          const overlay = renderer?.subtitleOverlay;
          const cue = renderer?.activeSubtitleCue;
          const rect = overlay?.getBoundingClientRect?.();
          return {
            cueStart: Number(cue?.start ?? -1),
            cueEnd: Number(cue?.end ?? -1),
            cueText: String(cue?.text ?? ""),
            overlayText: String(overlay?.textContent ?? "").trim(),
            display: String(overlay?.style?.display ?? ""),
            width: Number(rect?.width ?? 0),
            height: Number(rect?.height ?? 0),
            streamedCueCount: Number(renderer?.subtitleCues?.length ?? 0),
          };
        });
        if (
          !rendered.overlayText ||
          rendered.width <= 0 ||
          rendered.height <= 0 ||
          !Number.isFinite(rendered.cueStart) ||
          !Number.isFinite(rendered.cueEnd) ||
          rendered.cueEnd <= rendered.cueStart
        ) {
          throw new Error(
            `subtitle overlay/cue was malformed: ${JSON.stringify(rendered)}`,
          );
        }
        const postProbePlayback = await assertPlaybackStillAdvances(
          page,
          label,
          "text subtitle selection/streaming/render",
        );
        return {
          status: "rendered-text",
          tracks,
          attempts,
          selectedTrack: track,
          rendered,
          postProbePlayback,
        };
      } catch (error) {
        attempts.push({
          trackId: track.id,
          target,
          result: "no-visible-text-cue",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Bitmap subtitles cannot be prefetched through the text-only cue API.
  // Exercise their real streaming decoder/render path at several ordinary
  // dialogue positions and require an actual image cue in the HTML overlay.
  const imageTracks = candidates("image");
  for (const track of imageTracks) {
    const configured = await page.evaluate(
      (trackId) => document.querySelector("movi-player")?.player?.selectSubtitleTrack(trackId),
      track.id,
    );
    if (!configured) {
      attempts.push({ trackId: track.id, result: "configure-failed" });
      continue;
    }
    const duration = await page.evaluate(
      () => Number(document.querySelector("movi-player")?.duration ?? 0),
    );
    for (const target of [duration * 0.2, duration * 0.5, duration * 0.75]) {
      await page.evaluate((seconds) => {
        document.querySelector("movi-player").currentTime = seconds;
      }, target);
      await page.waitForTimeout(1_000);
      if (!(await page.evaluate(() => document.querySelector("movi-player")?.playing))) {
        await page.evaluate(() => document.querySelector("movi-player").play());
      }
      try {
        await page.waitForFunction(
          () => {
            const renderer = document.querySelector("movi-player")?.player?.videoRenderer;
            const overlay = renderer?.subtitleOverlay;
            return Boolean(
              renderer?.activeSubtitleCue?.image &&
                overlay &&
                overlay.style.display !== "none" &&
                overlay.querySelector("canvas, img"),
            );
          },
          null,
          { timeout: subtitleProbeMs },
        );
        const postProbePlayback = await assertPlaybackStillAdvances(
          page,
          label,
          "bitmap subtitle selection/render",
        );
        return {
          status: "rendered-image",
          tracks,
          attempts,
          selectedTrack: track,
          postProbePlayback,
        };
      } catch (error) {
        attempts.push({
          trackId: track.id,
          target,
          result: "no-visible-image-cue",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  throw new Error(
    `${label} has subtitle tracks but none completed real cue rendering: tracks=${JSON.stringify(tracks)} attempts=${JSON.stringify(attempts)}`,
  );
}

async function runOne(browser, token, mediaPath) {
  const label = basename(mediaPath);
  const media = await api(
    "/api/fs/get",
    { path: mediaPath, password: "" },
    token,
  );
  if (!media.raw_url || !(media.size > 0)) {
    throw new Error(`${label} did not resolve to a raw media object`);
  }

  // Wall-clock baseline for the byte budget: everything this sample downloads
  // is measured against how long it was allowed to stream.
  const sessionStartedAt = Date.now();
  const context = await browser.newContext();
  const page = await context.newPage();
  const decoderDiagnostics = [];
  page.on("console", (message) => {
    const text = message
      .text()
      .replace(/https?:\/\/\S+/gi, "[URL]")
      .replace(/[?&](?:token|sign|signature|authorization)=[^\s&]+/gi, "[REDACTED]");
    if (
      /VideoDecoder|codec|decoder|software|WebCodecs|post-seek|burst|backpressure|buffer|worker|underrun|starv|Clock|PlayerState|playback-transition/i.test(
        text,
      )
    ) {
      decoderDiagnostics.push(text.slice(0, 500));
      if (decoderDiagnostics.length > 240) decoderDiagnostics.shift();
    }
  });
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(
    () => customElements.get("movi-player") !== undefined,
    null,
    { timeout: 30_000 },
  );
  await page.evaluate((rawUrl) => {
    globalThis.__moviBlackboxErrors = [];
    globalThis.__moviBlackboxQoe = [];
    const element = document.querySelector("movi-player");
    // Take the silent software fallback.
    //
    // Without this, upstream's `handleUnsupportedVideo` path puts a "Format
    // Unsupported" overlay up and refuses to play whenever WebCodecs declines
    // HARDWARE for a codec — which is correct product behaviour (software
    // costs battery and may stutter, so it offers the viewer the trade) but
    // makes the two samples that exist to cover software decode untestable:
    // MPEG-2 and HEVC Main10 both get declined for hardware on this host.
    // `sw="auto"` is the documented way to say "fall back silently", and it
    // does NOT force software — H.264 still takes the hardware path, so the
    // hardware-preferred assertion below is unaffected.
    element.setAttribute("sw", "auto");
    element.addEventListener("error", (event) => {
      const value = event?.detail ?? event?.message ?? "player error";
      globalThis.__moviBlackboxErrors.push(String(value));
    });
    element.addEventListener("movi-qoe", (event) => {
      const detail = event?.detail ?? {};
      globalThis.__moviBlackboxQoe.push({
        type: String(detail.type ?? "unknown"),
        at: Number(detail.at ?? performance.now()),
      });
    });
    element.src = rawUrl;
  }, media.raw_url);

  await page.waitForFunction(
    () => {
      const element = document.querySelector("movi-player");
      return element && element.duration > 0 && element.player?.getState?.() !== "loading";
    },
    null,
    { timeout: 120_000 },
  );
  if (traceTransitions) await page.evaluate(() => {
    const player = document.querySelector("movi-player")?.player;
    const clock = player?.clock;
    const states = player?.stateManager;
    if (!clock || !states || clock.__blackboxTraced) return;
    clock.__blackboxTraced = true;
    for (const method of ["start", "pause"]) {
      const original = clock[method].bind(clock);
      clock[method] = (...args) => {
        console.debug(
          `[playback-transition] clock.${method} state=${states.getState()} running=${clock.isPlaying()} stack=${new Error().stack}`,
        );
        return original(...args);
      };
    }
    const originalSetState = states.setState.bind(states);
    states.setState = (next) => {
      console.debug(
        `[playback-transition] state.${states.getState()}->${next} clockRunning=${clock.isPlaying()} stack=${new Error().stack}`,
      );
      return originalSetState(next);
    };
  });
  await page.evaluate(async () => {
    const element = document.querySelector("movi-player");
    await element.play();
  });
  await page.waitForFunction(
    () => document.querySelector("movi-player")?.playing === true,
    null,
    { timeout: 60_000 },
  );

  // Let startup settle before opening the steady-state window: the first
  // seconds after play() include the clock's first sync to audio, which is a
  // jump, not a rate.
  const startupRecoveryMs = await waitForStablePlayback(page, Date.now());
  const { before: playBefore, after: playAfter } = await sampleWindow(
    page,
    sampleMs,
  );
  let playProgress;
  try {
    playProgress = assertHealthy(label, playBefore, playAfter, "steady playback");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
        `before=${JSON.stringify(compactSnapshot(playBefore))}; ` +
        `after=${JSON.stringify(compactSnapshot(playAfter))}; ` +
        `diagnostics=${decoderDiagnostics.slice(-100).join(" | ")}`,
    );
  }

  if (/h\.?264|avc/i.test(playAfter.videoCodec || label)) {
    if (/software|wasm/i.test(playAfter.videoDecoder)) {
      const supportProbe = await page.evaluate(async () => {
        const element = document.querySelector("movi-player");
        const player = element?.player;
        const track = player?.trackManager?.getActiveVideoTrack?.();
        const extradata = track
          ? player?.demuxer?.getExtradata?.(track.id) ?? track.extradata
          : null;
        if (!track || typeof VideoDecoder?.isConfigSupported !== "function") {
          return null;
        }
        const base = {
          codec: "avc1.640028",
          codedWidth: track.width,
          codedHeight: track.height,
        };
        const check = async (config) => {
          try {
            return Boolean((await VideoDecoder.isConfigSupported(config)).supported);
          } catch {
            return false;
          }
        };
        return {
          extradataHex: extradata
            ? [...extradata.slice(0, 48)]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("")
            : "",
          genericHardwareNoDescription: await check({
            ...base,
            hardwareAcceleration: "prefer-hardware",
          }),
          genericDefaultNoDescription: await check(base),
          genericHardwareWithDescription: extradata
            ? await check({
                ...base,
                hardwareAcceleration: "prefer-hardware",
                description: extradata,
              })
            : null,
          genericDefaultWithDescription: extradata
            ? await check({ ...base, description: extradata })
            : null,
        };
      });
      throw new Error(
        `${label} used ${playAfter.videoDecoder} for H.264 instead of WebCodecs hardware decoding; ` +
          `support probe: ${JSON.stringify(supportProbe)}; ` +
          `decoder diagnostics: ${decoderDiagnostics.slice(-30).join(" | ")}`,
      );
    }
    if (!/hardware-preferred/i.test(playAfter.videoDecoder)) {
      const message =
        `${label} used ${playAfter.videoDecoder}; H.264 blackbox requires the hardware-preferred WebCodecs config; ` +
        `queue=${playAfter.frameQueue} [${playAfter.frameQueueHeadTime.toFixed(3)}, ${playAfter.frameQueueTailTime.toFixed(3)}], ` +
        `renderer=${playAfter.rendererCurrentTime.toFixed(3)}, audioClock=${playAfter.audioClock.toFixed(3)}`;
      if (!allowNoPreference) throw new Error(message);
      process.stderr.write(`DIAGNOSTIC-ONLY: ${message}\n`);
    }
  }

  // Everything past this point runs a phase and decorates any failure with the
  // snapshot and the console trail, so a failing gate says WHY rather than just
  // which assertion tripped.
  // Phases that completed are kept even when a later one fails. Without this a
  // failing sample reported only its error, so the seek matrix, the stream
  // generations the consecutive-seek burst cost, and the byte budget — the
  // numbers the run exists to produce — were all thrown away with it.
  const completed = {};
  const runPhase = async (name, fn) => {
    try {
      const value = await fn();
      completed[name] = value;
      return value;
    } catch (error) {
      const current = await snapshot(page).catch(() => null);
      const wrapped = new Error(
        `[${name}] ${error instanceof Error ? error.message : String(error)}; ` +
          `snapshot=${current ? JSON.stringify(compactSnapshot(current)) : "unavailable"}; ` +
          `diagnostics=${decoderDiagnostics.slice(-120).join(" | ")}`,
      );
      wrapped.partial = { failedPhase: name, completed };
      throw wrapped;
    }
  };

  const duration = playAfter.duration;
  // Head / middle / tail / near-keyframe. The near-keyframe target is the
  // middle one nudged by a fraction of a second: a seek that lands just off a
  // keyframe is the case P3's restart barrier exists for, and it is a different
  // path from a seek that lands on one.
  const seekMatrix = [
    ["head seek", Math.max(2, duration * 0.02)],
    ["middle seek", duration * 0.5],
    ["tail seek", Math.min(duration - 10, duration * 0.95)],
    ["near-keyframe seek", duration * 0.5 + 0.4],
  ];

  const seeks = [];
  for (const [phase, rawTarget] of seekMatrix) {
    const target = Math.max(1, Math.min(duration - 5, rawTarget));
    const pre = await snapshot(page);
    seeks.push(
      await runPhase(phase, () =>
        seekAndSample(
          page,
          label,
          target,
          phase,
          numeric(pre.network?.streamGeneration) + 2,
        ),
      ),
    );
  }

  const rapidSeeks = await runPhase("consecutive seeks", () =>
    runRapidSeeks(page, label, duration),
  );
  const pauseResume = await runPhase("pause/resume", () =>
    runPauseResume(page, label),
  );
  const audioTrackSwitch = await runPhase("audio track switch", () =>
    runAudioTrackSwitch(page, label),
  );
  const quality = await runPhase("quality/ABR", () => runQualityProbe(page, label));
  const visibility = await runPhase("background/foreground", () =>
    runVisibilityCycle(page, label),
  );

  // Keep the single "post-seek playback" figure the old report carried, so the
  // A/B against the fork baseline stays comparable.
  const seekProgress = seeks.find((s) => s.phase === "middle seek") ?? seeks[0];

  const subtitles = await runPhase("subtitles", () =>
    validateSubtitles(page, label),
  );
  const finalSnapshot = await snapshot(page);
  if (finalSnapshot.state !== "playing" || !finalSnapshot.clockRunning) {
    throw new Error(`${label} did not finish subtitle-integrated playback with a running clock`);
  }
  if (finalSnapshot.errors.length > 0) {
    throw new Error(`${label} emitted player errors during subtitle-integrated playback`);
  }
  if (finalSnapshot.network) {
    if (Number(finalSnapshot.network.readStalls ?? 0) !== 0) {
      throw new Error(`${label} recorded HTTP source stalls after subtitle testing`);
    }
    if (Number(finalSnapshot.network.bufferWaiters ?? 0) !== 0) {
      throw new Error(`${label} left HTTP buffer waiters after subtitle testing`);
    }
  }

  // The byte budget is checked LAST, against the whole session: every seek,
  // every subtitle probe and every restart above has already been paid for by
  // the time this runs.
  const budget = await runPhase("byte budget", async () =>
    assertByteBudget(label, {
      sizeBytes: media.size,
      durationSeconds: playAfter.duration,
      wallSeconds: (Date.now() - sessionStartedAt) / 1000,
      snapshot: finalSnapshot,
    }),
  );

  await context.close();
  return {
    label,
    size: media.size,
    duration: playAfter.duration,
    byteBudget: budget,
    startupRecoveryMs,
    seeks,
    rapidSeeks,
    pauseResume,
    audioTrackSwitch,
    quality,
    visibility,
    decodePath: playAfter.decodePath,
    softwareDecoding: playAfter.softwareDecoding,
    softwareDecodeReason: playAfter.softwareDecodeReason,
    hardwareResurrectionAttempts: finalSnapshot.hardwareRetryCount,
    bufferMode: playAfter.sharedSourceBuffer ? "shared-array-buffer" : "plain-buffer",
    crossOriginIsolated: playAfter.crossOriginIsolated,
    videoDecoder: playAfter.videoDecoder,
    audioDecoder: playAfter.audioDecoder,
    videoCodec: playAfter.videoCodec,
    audioCodec: playAfter.audioCodec,
    steady: playProgress,
    postSeek: seekProgress,
    subtitles,
    finalState: finalSnapshot.state,
    network: finalSnapshot.network
      ? {
          totalBytes: numeric(finalSnapshot.network.totalBytes),
          streamGeneration: numeric(finalSnapshot.network.streamGeneration),
          rangeOpenEndedSwitches: numeric(finalSnapshot.network.rangeOpenEndedSwitches),
          readStalls: numeric(finalSnapshot.network.readStalls),
          supersededStreams: numeric(finalSnapshot.network.supersededStreams),
        }
      : null,
    qoe: finalSnapshot.qoe,
    decoderDiagnostics,
  };
}

async function main() {
  const login = await api("/api/auth/login", { username, password });
  const { chromium } = await import("playwright");
  const executablePath = process.env.MOVI_CHROME_EXECUTABLE || undefined;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--enable-features=SharedArrayBuffer",
    ],
  });

  const startedAt = new Date().toISOString();
  const results = [];
  const failures = [];
  try {
    // Every sample runs, whatever the ones before it did. Aborting on the first
    // failure meant a seven-sample matrix showed one bug per full re-run, and a
    // full re-run is tens of minutes of real streaming.
    for (const mediaPath of mediaPaths) {
      const label = basename(mediaPath);
      process.stdout.write(`blackbox: ${label} ... `);
      const sampleStartedAt = Date.now();
      try {
        const result = await runOne(browser, login.token, mediaPath);
        results.push({ ...result, status: "pass" });
        console.log(`PASS (${((Date.now() - sampleStartedAt) / 1000).toFixed(1)}s)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ label, message });
        results.push({
          label,
          status: "fail",
          elapsedSeconds: Number(((Date.now() - sampleStartedAt) / 1000).toFixed(1)),
          error: message,
          // Whatever this sample DID prove before it stopped.
          failedPhase: error?.partial?.failedPhase ?? null,
          completedPhases: error?.partial?.completed ?? null,
        });
        console.log(`FAIL (${((Date.now() - sampleStartedAt) / 1000).toFixed(1)}s)`);
        process.stderr.write(`  ${label}: ${message}\n`);
      }
    }
  } finally {
    await browser.close();
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    pageUrl,
    headless: true,
    acceptanceMode: allowNoPreference ? "diagnostic-no-preference" : "strict-hardware",
    samples: mediaPaths.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: failures.length,
    failures,
    results,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Wrote ${outputPath} — ${report.passed}/${report.samples} passed`,
  );
  if (failures.length > 0) {
    throw new Error(
      `${failures.length}/${mediaPaths.length} black-box samples failed: ${failures
        .map((f) => f.label)
        .join(", ")}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
