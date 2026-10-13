#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  byteBudget,
  classifyWindow,
  isSteady,
  progression,
  summarizeDisturbances,
} from "./blackbox-metrics.mjs";
import { createPageGuard } from "./blackbox-page-guard.mjs";

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
// Optional downlink cap in bytes per second, applied through CDP to the page.
// Total bytes downloaded scale with how fast the link refills the window after
// every seek, so a run on a fast link and a run on a slow one are not
// comparable; this pins the link so player behaviour can be told apart from
// network speed. Unset means no throttling.
const throttleBps = Number(process.env.MOVI_BLACKBOX_THROTTLE_BPS ?? 0);
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
      // Read straight off VideoDecoder's own getter (not re-derived) so a
      // failure snapshot can answer on its own whether hardware retry was
      // ever going to succeed: "unmapped" means there was no WebCodecs codec
      // string for this stream at all, so every hardware resurrection
      // attempt against it is doomed before it starts.
      _softwareReason: String(player?.videoDecoder?.softwareReason ?? ""),
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

// `classifyWindow`/`summarizeDisturbances` were written, exported and unit
// tested — and never called. `presentation-rebase` therefore never appeared in
// a single report since the day it was implemented, and the one time it
// mattered (a renderer presentation start that moved underneath a window that
// stayed in `playing` throughout) it took hand-diffing two raw before/after
// snapshots to notice. This wrapper is the missing wire.
//
// Disturbances are recorded on the way out as well as on the way to a throw:
// a gate that only leaves evidence when it fails cannot explain its own green
// light.
function assertHealthy(label, before, after, phase, options = {}) {
  const disturbances = classifyWindow([before, after]);
  const summary = summarizeDisturbances(disturbances);
  try {
    const progress = assertHealthyInner(label, before, after, phase, options);
    return { ...progress, disturbances: summary };
  } catch (error) {
    if (summary && error instanceof Error) {
      error.message += `; window disturbances: ${summary}`;
    }
    throw error;
  }
}

function assertHealthyInner(label, before, after, phase, options = {}) {
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
  if (progress.framesReset) {
    // The renderer's frame counter restarted mid-window (a hardware
    // resurrection attempt, or a seek that landed inside this window). The
    // raw delta is negative and says nothing about whether picture actually
    // advanced; rendererCurrentTime (the last presented PTS) is monotone
    // across a reset that contains no seek and is the honest fallback. Judge
    // health against that instead of a frame count that just went backwards.
    if (progress.rendererSeconds < progress.wallSeconds * 0.45) {
      throw new Error(
        `${label} presented pipeline reset (framesPresented went backwards) and picture ` +
          `only advanced ${progress.rendererSeconds.toFixed(3)}s of ${progress.wallSeconds.toFixed(3)}s during ${phase}`,
      );
    }
  } else if (progress.frames < 5) {
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
    // Carry the endpoints, not just the ratio. A rate on its own cannot
    // distinguish "the clock ran fast" from "the clock caught up to an audio
    // anchor that was already ahead of it" — and those want different fixes.
    // Both readings are already in the snapshots; not printing them cost a
    // whole extra real-media round trip the first time this fired (B1c).
    throw new Error(
      `${label} media clock rate ${progress.mediaRate.toFixed(3)} during ${phase}; expected near 1x ` +
        `(clock ${before.currentTime.toFixed(3)}s -> ${after.currentTime.toFixed(3)}s over ` +
        `${progress.wallSeconds.toFixed(3)}s wall; audioClock ${before.audioClock.toFixed(3)}s -> ` +
        `${after.audioClock.toFixed(3)}s; clock-minus-audio ${(before.currentTime - before.audioClock).toFixed(3)}s -> ` +
        `${(after.currentTime - after.audioClock).toFixed(3)}s; audioBuffered ` +
        `${before.audioBufferedSeconds.toFixed(3)}s -> ${after.audioBufferedSeconds.toFixed(3)}s)`,
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
    // bufferWaiters is a LIVE GAUGE, not a leak counter: HttpSource reports
    // `this.bufferWaiters.size` (HttpSource.ts:2774), the number of reads
    // parked in waitForData RIGHT NOW. A parked read is the normal steady
    // state of a streaming source any time the demuxer is momentarily ahead
    // of the network, so a single instantaneous sample cannot tell a stranded
    // read from an in-progress one. It read nonzero on a Star Trek run
    // (2026-09-15) whose state was "playing", clock running, readStalls 0 —
    // and PASSED on the two runs either side of it.
    //
    // What the assertion MEANS is "no read was left stranded". Measure that:
    // require the waiters to still be parked at BOTH ends of the window AND
    // no bytes to have arrived across it — a source that is downloading is a
    // source that is waking waiters. `readStalls` above remains the cumulative
    // counter and is asserted unchanged.
    // `oldestPendingReadWaitMs` is the age of the longest-running waitForData
    // call — the only field that distinguishes one stranded read from a
    // succession of ordinary short ones, which the count cannot.
    const oldestRead = Number(after.network.oldestPendingReadWaitMs ?? 0);
    if (oldestRead >= 10_000) {
      throw new Error(
        `${label} has an HTTP read stranded during ${phase}: waiting ` +
          `${(oldestRead / 1000).toFixed(1)}s for its bytes ` +
          `(${Number(after.network.bufferWaiters ?? 0)} parked waiter(s), ` +
          `${(
            (Number(after.network.totalBytes ?? 0) -
              Number(before.network?.totalBytes ?? 0)) /
            1e6
          ).toFixed(1)} MB arrived across the window)`,
      );
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
// The ceiling is derived from an invariant of the source rather than picked,
// and it is kept PER STREAM GENERATION (the arithmetic lives in
// blackbox-metrics.mjs, the counting in HttpSource.getNetworkStats()): a seek
// outside the window abandons the running stream and the new one refills a
// window from the new position, so a session of N generations can move N
// windows without anything being wrong. What would be wrong is one generation
// not held by its own window, i.e. downloading more than the span the demuxer
// consumed from it plus one window and the chunks in flight. Bytes fetched by
// one-off range reads belong to no generation and are counted on their own,
// and may not exceed what those reads asked for. Everything downloaded must
// be accounted for: the per-generation counters plus the one-off bytes have to
// add up to the source-wide counter, or some download went unrecorded.
function assertByteBudget(label, { sizeBytes, wallSeconds, snapshot: final }) {
  const totalBytes = numeric(final.network?.totalBytes);
  const generations = numeric(final.network?.streamGeneration);
  const windowBytes = numeric(final.network?.streamWindowBytes);
  const budget = byteBudget({
    totalBytes,
    generationBytes: final.network?.generationBytes ?? [],
    oneOff: final.network?.oneOff ?? { fetches: 0, requestedBytes: 0, bytes: 0 },
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
  if (budget.violations.length > 0) {
    throw new Error(
      `${label} broke its byte budget: ${JSON.stringify(budget.violations)}: ${JSON.stringify(detail)}`,
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
    hardwareRetryCount: sample.hardwareRetryCount,
    _softwareReason: sample._softwareReason,
    state: sample.state,
    masterClock: sample.masterClock,
    playbackInvariant: sample.playbackInvariant,
    network: sample.network,
  };
}

// How long sampleWindow will wait for the player to return to a steady state
// before giving up and handing assertHealthy a transitional snapshot anyway
// (which will then fail loudly, correctly, on its own terms).
const STEADY_SETTLE_TIMEOUT_MS = 5_000;
const STEADY_SETTLE_POLL_MS = 250;

/**
 * Sample a window, and never hand assertHealthy an "after" snapshot taken
 * mid-transition.
 *
 * Two bugs used to live here, and they compounded: a plain fixed-length
 * window can land its closing snapshot while the player is mid-seek or
 * mid-rebuffer (state !== "playing"), which is a transition, not steady
 * playback; and on Grave of the Fireflies specifically, that transition was
 * the player's own desync resync firing, which also rebuilds the video
 * pipeline and resets framesPresented to zero — so the same bad sample also
 * produced a negative frame delta ("presented only -10 frames during steady
 * playback", which is a statement about when the sample was taken, not about
 * the player). Fixing only the arithmetic (see progression()'s framesReset
 * handling) without also fixing WHEN the sample is taken would still assert
 * health from inside a transition.
 *
 * If the window closes on an unsteady state, keep polling (bounded by
 * STEADY_SETTLE_TIMEOUT_MS) until it returns to steady, and use THAT as the
 * "after" snapshot. If the deadline passes without settling, hand back the
 * last (still unsteady) snapshot — assertHealthy's own state/clock checks
 * will then report exactly what was unsteady about it, rather than the
 * caller silently accepting a mid-transition read.
 */
async function sampleWindow(page, windowMs) {
  const before = await snapshot(page);
  await page.waitForTimeout(windowMs);
  let after = await snapshot(page);
  const settleDeadline = Date.now() + STEADY_SETTLE_TIMEOUT_MS;
  while (!isSteady(after) && Date.now() < settleDeadline) {
    await page.waitForTimeout(STEADY_SETTLE_POLL_MS);
    after = await snapshot(page);
  }
  return { before, after };
}

// ─── Real decode-effect assertions ─────────────────────────────────────────
//
// assertHealthy only ever looked at clocks, frame counts and canvas
// dimensions — a decoder that outputs solid black or silence passes every one
// of those checks. These three helpers look at CONTENT: actual pixels off the
// canvas, actual samples off the audio graph, actual non-transparent pixels
// off a bitmap subtitle overlay. None of them replace assertHealthy; they run
// alongside it.

const PICTURE_SAMPLE_WIDTH = 48;
const PICTURE_SAMPLE_HEIGHT = 27;
// Below this luma spread across the downscaled frame, call it a solid colour
// rather than a picture. Real footage — even a mostly-dark scene — spans much
// more than this; a black or flat-decode-failure frame does not.
const PICTURE_FLAT_SPREAD = 8;
// Below this max luma, call it black. A dim scene still has highlights above
// this on a 0-255 scale; a genuinely undecoded frame does not.
const PICTURE_BLACK_MAX_LUMA = 20;
// Per-pixel RGB delta (summed) averaged over the sampled grid, above which two
// captures count as "different pictures" rather than the same frozen frame
// with capture noise.
const PICTURE_CHANGE_THRESHOLD = 6;
// Frames that must reach the canvas across the ~3s picture window before an
// unchanging picture may be called a frozen pipeline rather than a static
// shot. Same floor assertHealthy uses for the same question.
const PICTURE_STATIC_MIN_FRAMES = 5;

/**
 * Downscale a screenshot of the video canvas and read it back.
 *
 * NOT `ctx.drawImage(liveCanvas, ...)` + `getImageData()` — that used to read
 * the WebGL-backed canvas directly and was the thing that decided the
 * "steady playback"/"middle seek" verdicts. Proven unreliable by direct A/B
 * (`.secrets/pixel-readback-ab-repro.mjs`, 2026-09-13): sampled the SAME
 * instant through both a live `drawImage(canvas)` read and a
 * `page.screenshot()`, on Good Will Hunting's H.264/hardware-preferred path.
 * The two disagreed by up to ~75 luma-spread points, in BOTH headless and
 * headful Chrome (roughly 1-in-3 of 15 samples each mode crossed a 20-point
 * threshold) — so this is a live-canvas-vs-compositor timing race, not a
 * headless-only artifact, and not something a bigger threshold fixes.
 *
 * The `full-matrix-sweep`/`real-openlist` runs on 2026-09-13 reported
 * "canvas is near-uniform (spread=1.0-7.7, uniqueColors=1-2)" for Good Will
 * Hunting and Grave of the Fireflies during steady playback; the harness's
 * own saved failure screenshots for those exact runs
 * (`.blackbox-results/screenshots/`) show a fully rendered MIRAMAX logo and
 * a clearly visible character portrait respectively. The live-canvas read
 * was reporting a solid colour for a frame that plainly was not one.
 *
 * `page.screenshot()` goes through the browser's own compositor — the same
 * pixels a human looking at the page would see — and does not race the
 * WebGL render loop the way reading the canvas element directly does. The
 * screenshot is clipped to the video canvas's own bounding rect so the
 * player's control-bar UI (a fixed-colour button block) can't get folded
 * into "the picture has content".
 */
async function capturePicture(page) {
  const rect = await page.evaluate(() => {
    const canvas = document
      .querySelector("movi-player")
      ?.shadowRoot?.querySelector("canvas");
    if (!canvas || !canvas.width || !canvas.height) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.max(0, Math.round(r.x)),
      y: Math.max(0, Math.round(r.y)),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  });
  if (!rect) return null;

  let shotBuffer;
  try {
    shotBuffer = await page.screenshot({ clip: rect, type: "png" });
  } catch {
    return null; // page/context gone, or the clip fell outside the viewport
  }
  const base64 = shotBuffer.toString("base64");

  return page.evaluate(
    ({ base64, width, height }) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const off = document.createElement("canvas");
          off.width = width;
          off.height = height;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(null);
          // `img` is a fully-decoded static bitmap by the time `onload`
          // fires — no live render loop to race, unlike the WebGL canvas
          // this replaced.
          ctx.drawImage(img, 0, 0, width, height);
          const { data } = ctx.getImageData(0, 0, width, height);
          let min = 255;
          let max = 0;
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          let n = 0;
          const colorBuckets = new Set();
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const lum = (r + g + b) / 3;
            if (lum < min) min = lum;
            if (lum > max) max = lum;
            sumR += r;
            sumG += g;
            sumB += b;
            n++;
            colorBuckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
          }
          resolve({
            min,
            max,
            spread: max - min,
            avgR: sumR / n,
            avgG: sumG / n,
            avgB: sumB / n,
            uniqueColors: colorBuckets.size,
            pixels: Array.from(data),
          });
        };
        img.onerror = () => resolve(null);
        img.src = "data:image/png;base64," + base64;
      }),
    { base64, width: PICTURE_SAMPLE_WIDTH, height: PICTURE_SAMPLE_HEIGHT },
  );
}

function pictureChanged(a, b) {
  if (!a || !b) return false;
  let diff = 0;
  const n = a.pixels.length / 4;
  for (let i = 0; i < a.pixels.length; i += 4) {
    diff +=
      Math.abs(a.pixels[i] - b.pixels[i]) +
      Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) +
      Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
  }
  return diff / n > PICTURE_CHANGE_THRESHOLD;
}

// Where assertRealPicture drops a PNG the moment it is about to fail. The
// full-matrix sweep that found the headless near-black/frozen H.264 samples
// was decided by a NUMBER (luma spread=1.0) that could not by itself tell
// "the picture is actually black" apart from "the picture is fine and the
// capture path is broken" — that took a human looking at a saved screenshot
// from a headful run to resolve. Saving the frame automatically means nobody
// has to re-run headful just to look.
const SCREENSHOT_DIR = resolve(".blackbox-results/screenshots");

async function saveFailureScreenshot(page, label, phase) {
  try {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const safeName = `${label}-${phase}-${Date.now()}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const path = resolve(SCREENSHOT_DIR, `${safeName}.png`);
    await page.screenshot({ path });
    return path;
  } catch (error) {
    return `(failed to save screenshot: ${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Require the canvas to show a real, changing image — not a solid colour, not
 * black, not the decode-failure green, and not a frozen frame repeated across
 * three samples ~1.5s apart. Covers H.264 hardware (samples 1/2/3/5), HEVC
 * Main10 (sample 6) and MPEG-2 software (sample 4) identically: it reads
 * whatever codec is actually decoding at call time.
 */
async function assertRealPicture(page, label, phase) {
  const shots = [];
  const framesAt = [];
  for (let i = 0; i < 3; i++) {
    // Judge each sample the moment it is captured. The previous shape captured
    // all three first and only then evaluated them, so the failure screenshot
    // was taken >=3s after the frame that actually failed. On a sample whose
    // first seconds are a fade-in (Good Will Hunting's 2.3s black lead-in), the
    // saved PNG showed the Miramax logo that was up by then and flatly
    // contradicted a reading that had been correct — three separate
    // investigations drew three different wrong conclusions from that skew
    // before anyone noticed the evidence and the measurement were not the same
    // frame. Screenshot now lands within milliseconds of the failing sample.
    const shot = await capturePicture(page);
    shots.push(shot);
    // framesPresented rides along with every sample: it is the only thing that
    // separates "the pipeline stopped" from "the shot is static" further down.
    const { at, frames } = await page
      .evaluate(() => {
        const element = document.querySelector("movi-player");
        const renderer = element?.player?.videoRenderer ?? null;
        return {
          at: Number(element?.currentTime ?? -1),
          frames: Number(
            renderer?.getStats?.().framesPresented ?? renderer?.framesPresented ?? -1,
          ),
        };
      })
      .catch(() => ({ at: -1, frames: -1 }));
    framesAt.push(frames);
    const where = `during ${phase} (sample ${i}, currentTime=${at.toFixed(2)}s)`;
    if (!shot) {
      const shotPath = await saveFailureScreenshot(page, label, phase);
      throw new Error(
        `${label} had no readable canvas frame ${where}; screenshot=${shotPath}`,
      );
    }
    // A flat or black single sample is NOT evidence of a dead decoder: fades,
    // transitions and letterboxed title cards are legitimate content, and a
    // luma histogram cannot tell them apart from a broken decode. Judging each
    // sample in isolation is what made this assertion fire on every sweep —
    // Good Will Hunting is genuinely black at t=14.25s (aligned screenshot
    // confirms it) one sample after showing the Miramax logo just fine at
    // t=12.7s. Only "never showed content across the whole window" is a real
    // decoder statement, so that verdict is deferred until all samples are in.
    if (shot.avgG > shot.avgR * 3 && shot.avgG > shot.avgB * 3 && shot.avgG > 80) {
      const shotPath = await saveFailureScreenshot(page, label, phase);
      throw new Error(
        `${label} canvas is dominated by green (avgR=${shot.avgR.toFixed(1)}, ` +
          `avgG=${shot.avgG.toFixed(1)}, avgB=${shot.avgB.toFixed(1)}) ${where} — ` +
          `the typical decode-failure output; screenshot=${shotPath}`,
      );
    }
    if (i < 2) await page.waitForTimeout(1_500);
  }
  // The real decoder verdict: did the canvas EVER carry a picture during this
  // window? One content-bearing sample proves frames are reaching the canvas;
  // zero across ~3s means nothing is being drawn.
  const everShowedContent = shots.some(
    (s) => s.spread >= PICTURE_FLAT_SPREAD && s.max >= PICTURE_BLACK_MAX_LUMA,
  );
  if (!everShowedContent) {
    const shotPath = await saveFailureScreenshot(page, label, phase);
    throw new Error(
      `${label} canvas never showed a picture across 3 samples over ~3s during ${phase} ` +
        `(spreads=${shots.map((s) => s.spread.toFixed(1)).join("/")}, ` +
        `maxLuma=${shots.map((s) => s.max.toFixed(1)).join("/")}) — every sample was flat or black; ` +
        `screenshot=${shotPath}`,
    );
  }
  // A picture that does not change is not by itself a frozen pipeline. Static
  // shots are ordinary content, and the `steady playback` window opens at
  // t≈2s — which on a feature film is the studio logo or the presents card,
  // i.e. deliberately motionless. Measured 2026-09-15, both with a perfect
  // picture on screen (screenshots saved by this very function): 萤火虫之墓 at
  // t=1.97s showing the Shinchosha 1988 logo, Memories at t=2.07s showing
  // "KATSUHIRO OTOMO PRESENTS". Grave failed this twice out of two.
  //
  // This is the same blind spot the flat/black verdict above already had
  // fixed for it — "fades, transitions and letterboxed title cards are
  // legitimate content" — carried over verbatim into the time dimension and
  // left unfixed there.
  //
  // What separates the two cases is not the pixels: it is whether frames are
  // still REACHING the canvas. A static shot still presents a frame per
  // vsync-ish tick; a frozen pipeline presents none. So the verdict is now
  // conjunctive, and the frame floor matches assertHealthy's own (`frames <
  // 5` over its window) so the two cannot disagree about what "the picture
  // stopped" means.
  const framesAcross =
    framesAt[0] >= 0 && framesAt[2] >= 0 ? framesAt[2] - framesAt[0] : -1;
  const pictureStatic =
    !pictureChanged(shots[0], shots[1]) && !pictureChanged(shots[1], shots[2]);
  if (pictureStatic && framesAcross >= 0 && framesAcross < PICTURE_STATIC_MIN_FRAMES) {
    const shotPath = await saveFailureScreenshot(page, label, phase);
    throw new Error(
      `${label} canvas did not change across 3 samples over ~3s during ${phase} and only ` +
        `${framesAcross} frames were presented across that window (framesPresented ` +
        `${framesAt[0]} -> ${framesAt[2]}) — the pipeline is frozen, not the shot; ` +
        `screenshot=${shotPath}`,
    );
  }
  return {
    spreads: shots.map((s) => Number(s.spread.toFixed(1))),
    uniqueColors: shots.map((s) => s.uniqueColors),
    // Recorded on the pass path too: a run that was static-but-presenting
    // should be able to say so afterwards, rather than looking identical in
    // the report to one that had motion.
    framesAcrossPictureWindow: framesAcross,
    pictureStatic,
  };
}

// RMS floor for "there is real audio here", on a [-1, 1] float sample scale.
// True silence (or a decoder emitting zeroed PCM) reads ~0. Any actual mixed
// program audio, even a quiet passage, sits comfortably above this.
const AUDIO_SILENCE_RMS = 0.001;

/**
 * Tap an AnalyserNode onto the SAME node the audio graph already routes
 * through (gainNode, the fixed last node before destination — see
 * AudioRenderer's own comment on that), and read real RMS over a window. The
 * clock advancing (`audioClock`) says nothing about what came out of the
 * speakers; this does. Reused across DTS/TrueHD/DTS-HD MA/FLAC/AAC/AC3 and
 * across an in-place track switch (sample 6: AAC+FLAC in one file).
 */
async function assertRealAudio(page, label, phase, windowMs = 3_000) {
  const result = await page.evaluate(async (ms) => {
    const player = document.querySelector("movi-player")?.player;
    const audio = player?.audioRenderer;
    const ctx = audio?.audioContext;
    const gain = audio?.gainNode;
    if (!ctx || !gain) return { supported: false };
    let tap = globalThis.__moviBlackboxAudioTap;
    if (!tap || tap.context !== ctx) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // A tap: connecting gainNode to it does not change what the destination
      // hears (Web Audio nodes can fan out to more than one destination), and
      // an AnalyserNode processes its input whether or not it is itself
      // connected onward.
      gain.connect(analyser);
      tap = { context: ctx, analyser };
      globalThis.__moviBlackboxAudioTap = tap;
    }
    const buf = new Float32Array(tap.analyser.fftSize);
    const samples = [];
    const start = performance.now();
    while (performance.now() - start < ms) {
      tap.analyser.getFloatTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
      samples.push(Math.sqrt(sumSq / buf.length));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      supported: true,
      avgRms: samples.reduce((a, b) => a + b, 0) / samples.length,
      maxRms: Math.max(...samples),
      samples: samples.length,
    };
  }, windowMs);
  if (!result.supported) {
    throw new Error(`${label} has no AudioContext/gainNode to tap during ${phase}`);
  }
  if (result.maxRms < AUDIO_SILENCE_RMS) {
    throw new Error(
      `${label} audio output is silent (maxRms=${result.maxRms.toExponential(3)} over ` +
        `${result.samples} samples) during ${phase}`,
    );
  }
  return result;
}

// A read that has been waiting this long for its bytes is stranded, not slow.
// HttpSource's own waitForData gives a read a 30s deadline and calls it stalled
// after 15s without progress, so this sits below both: it reports a stuck read
// rather than waiting for the source to give up on it.
const STRANDED_READ_MS = 10_000;

/**
 * Poll until no read has been waiting longer than `STRANDED_READ_MS`.
 *
 * Reads the AGE of the longest-running waitForData call, not the waiter count.
 * The count cannot answer this: the park inside waitForData re-arms every
 * 250ms, so `bufferWaiters === 1` sampled repeatedly looks identical whether
 * one read has been stuck for 30s or four different reads each waited 250ms.
 * The first sweep to use the count over a 5s window flagged Paprika while the
 * source was downloading at 3.2 MB/s with readStalls=0 — a reading that could
 * not be turned into a claim either way. `oldestPendingReadWaitMs` was added to
 * HttpSource for exactly this question.
 */
async function waitForStrandedReads(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = { bufferWaiters: 0, oldestPendingReadWaitMs: 0 };
  for (;;) {
    last = await page
      .evaluate(() => {
        const stats =
          document.querySelector("movi-player")?.player?.source?.getNetworkStats?.() ?? {};
        return {
          bufferWaiters: Number(stats.bufferWaiters ?? 0),
          oldestPendingReadWaitMs: Number(stats.oldestPendingReadWaitMs ?? 0),
        };
      })
      .catch(() => ({ bufferWaiters: 0, oldestPendingReadWaitMs: 0 }));
    if (last.oldestPendingReadWaitMs < STRANDED_READ_MS) return last;
    if (Date.now() >= deadline) return last;
    await page.waitForTimeout(500);
  }
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
  // Real decode-effect evidence at a seek target, not just at startup. Bounded
  // to the middle seek (every sample runs one) rather than all four, so the
  // cost stays proportional to what the matrix already pays for seeking.
  let picture;
  let audio;
  if (phase === "middle seek") {
    picture = await assertRealPicture(page, label, phase);
    if (after.audioCodec && after.audioCodec !== "N/A") {
      audio = await assertRealAudio(page, label, phase);
    }
  }
  return {
    phase,
    target: Number(target.toFixed(2)),
    arrivedMs,
    recoveryMs,
    picture,
    audio,
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
    // the total, which the byte budget also depends on. Budget is
    // rapidSeekCount, not a hardcoded 4: the E-decision experiment (Star
    // Trek, VIRGIN PUNK, 2026-09-13) showed 5 seeks spaced rapidSeekGapMs
    // apart each opening exactly one generation (1:1, zero overlap) is
    // CORRECT behaviour, not a FIFO failure — the fixed "+4" against a
    // default rapidSeekCount of 5 was guaranteed to read as "one over budget"
    // every time none of the seeks in the burst overlap in flight.
    { generationBudget: generationsBefore + rapidSeekCount },
  );

  // The FIFO adjudication, stated as a gate: a burst of N seeks where only the
  // last one matters must not cost MORE than one stream restart per seek —
  // i.e. redundant/overlapping seeks in the burst should collapse, not stack.
  // Seeing exactly N generations for N non-overlapping seeks is the FIFO
  // queue behaving correctly, not failing to collapse anything.
  if (generationsUsed > rapidSeekCount) {
    throw new Error(
      `${label} spent ${generationsUsed} stream generations on ${rapidSeekCount} consecutive seeks (budget ${rapidSeekCount}); the demuxer's FIFO seek queue is not collapsing redundant seeks`,
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

  // How far AHEAD of free-running playback currentTime may land as a side
  // effect of switching tracks. A track switch changes which decoder is
  // producing sound, not where playback is — it is not a seek. Generous
  // (seconds, not frames) because a legitimate flush/re-buffer can cost some
  // ground, but an order-of-magnitude clock displacement is not that.
  const AUDIO_SWITCH_MAX_DISPLACEMENT_S = 1;
  // How far the playhead may go back from the furthest it had reached, and how
  // long the picture may stand still, anywhere between issuing the switch and
  // the end of the measurement window. The forward-jump check below cannot see
  // either: the master clock runs on the wall clock, so it never disagrees with
  // free-running playback even while the picture is held at the old track's
  // time (which is why displacementS read 0 in every report).
  const AUDIO_SWITCH_MAX_BACKWARD_S = 0.5;
  const AUDIO_SWITCH_MAX_FREEZE_S = 1;

  const switched = [];
  let preSwitchTime = start.currentTime;
  let preSwitchWallMs = start.wallMs;
  for (const track of start.audioTracks) {
    if (track.id === start.activeAudioTrackId) continue;
    const switchIssuedAt = Date.now();
    await page.evaluate(() => {
      const element = document.querySelector("movi-player");
      const rows = [];
      globalThis.__moviSwitchWatch = rows;
      const timer = setInterval(() => {
        rows.push({
          t: performance.now(),
          clock: Number(element?.currentTime ?? 0),
          picture: Number(element?.player?.videoRenderer?.currentTime ?? -1),
        });
      }, 50);
      globalThis.__moviSwitchWatchTimer = timer;
    });
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
    // Same reasoning as a seek's arrival vs settling: the moment the active
    // track flips, the clock can still be mid-resync (new decoder cold-
    // priming, audio cushion refilling) — sampling right there reads that
    // transition as a media rate, not a rate. Wait for two consecutive ~1x
    // windows before opening the measurement window, exactly like seeks do.
    await waitForStablePlayback(page, switchIssuedAt);
    const { before, after } = await sampleWindow(page, phaseSampleMs);
    // Displacement is judged BEFORE assertHealthy, and the ordering is load
    // bearing. A track switch is not a seek: if the playhead itself jumped,
    // every throughput number measured across that jump is meaningless, and
    // assertHealthy's frame/rate checks will happily throw first and hide the
    // cause behind a symptom. That is not hypothetical — an A/B against the
    // pre-merge tree (2026-09-15) came back "presented only 0 frames" and was
    // read as a different failure mode, when in fact the run had never reached
    // the displacement check at all, so it said nothing about whether the
    // playhead had moved. The more fundamental fact gets asserted first.
    //
    // The baseline is where free-running playback WOULD have reached, not
    // where the playhead was before the switch. `waitForStablePlayback` above
    // deliberately burns wall time — it polls at 1s and needs two consecutive
    // ~1x windows — and at ~1x that is seconds of entirely legitimate media
    // advance. 574e05f introduced the wait and this bound in one commit and
    // asserted they were independent ("the wait above can't paper over a real
    // jump"); they are not. Subtracting only `preSwitchTime` charged the
    // wait's own cost to the player, putting the floor of a perfect run at
    // ~2s against a 1s budget — the 2.044s the pre-merge tree reported on
    // 2026-09-15 is that floor, not a jump. Only the excess over elapsed time
    // is the player's.
    const elapsedS = (before.wallMs - preSwitchWallMs) / 1_000;
    const displacement = before.currentTime - (preSwitchTime + elapsedS);
    if (displacement > AUDIO_SWITCH_MAX_DISPLACEMENT_S) {
      throw new Error(
        `${label} playhead jumped ${displacement.toFixed(3)}s ahead of free-running playback ` +
          `(from ${preSwitchTime.toFixed(3)}s to ${before.currentTime.toFixed(3)}s over ${elapsedS.toFixed(3)}s of wall time) ` +
          `just from switching to audio track ${track.id} (${track.codec}); a track switch must not move the playhead`,
      );
    }
    // Landing BEHIND free-running playback is a stall, not a jump, and it is
    // a different defect with its own owner: `waitForStablePlayback` requires
    // ~1x windows to exit and assertHealthy asserts the rate across the
    // measurement window. Record it, do not double-report it here.
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
    const watch = await page.evaluate(() => {
      clearInterval(globalThis.__moviSwitchWatchTimer);
      return globalThis.__moviSwitchWatch ?? [];
    });
    let furthest = -Infinity;
    let backwardS = 0;
    let pictureAt = -Infinity;
    let pictureSince = watch[0]?.t ?? 0;
    let freezeS = 0;
    for (const row of watch) {
      furthest = Math.max(furthest, row.clock);
      backwardS = Math.max(backwardS, furthest - row.clock);
      if (row.picture > pictureAt + 1e-6) {
        pictureAt = row.picture;
        pictureSince = row.t;
      }
      freezeS = Math.max(freezeS, (row.t - pictureSince) / 1_000);
    }
    if (backwardS > AUDIO_SWITCH_MAX_BACKWARD_S) {
      throw new Error(
        `${label} playhead went back ${backwardS.toFixed(3)}s after switching to audio track ${track.id} (${track.codec}); a track switch must not pull the clock back`,
      );
    }
    if (freezeS > AUDIO_SWITCH_MAX_FREEZE_S) {
      throw new Error(
        `${label} picture frozen ${freezeS.toFixed(1)}s after switching to audio track ${track.id} (${track.codec}) while the clock ran on`,
      );
    }
    const trace = traceTransitions
      ? await page.evaluate(
          () => document.querySelector("movi-player")?.player?.audioSwitchTrace ?? [],
        )
      : undefined;
    switched.push({
      trackId: track.id,
      codec: track.codec,
      trace,
      audioDecoder: after.audioDecoder,
      displacementS: Number(displacement.toFixed(3)),
      clockBackwardS: Number(backwardS.toFixed(3)),
      pictureFreezeS: Number(freezeS.toFixed(2)),
      settleElapsedS: Number(elapsedS.toFixed(3)),
      ...progress,
    });
    preSwitchTime = after.currentTime;
    preSwitchWallMs = after.wallMs;
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

  if (traceTransitions) {
    // The picture's own state around the return, so a low foreground rate can
    // be told apart as the audio-clock cap, a refill after the cleared queue,
    // or something else.
    await page.evaluate(() => {
      const player = document.querySelector("movi-player")?.player;
      const t0 = performance.now();
      const rows = [];
      globalThis.__moviForegroundTrace = rows;
      const timer = setInterval(() => {
        const r = player?.videoRenderer;
        const a = player?.audioRenderer;
        const stats = r?.getFrameStats?.() ?? {};
        rows.push({
          t: Math.round(performance.now() - t0),
          clock: player?.clock?.getTime?.() ?? -1,
          audioClock: a?.getAudioClock?.() ?? -1,
          audioHealthy: a?.hasHealthyBuffer?.() ?? null,
          lastKnownAudio: r?.lastKnownAudioTime ?? null,
          synced: r?.syncedToAudio ?? null,
          lastPts: stats.lastPts ?? -1,
          frameQueue: stats.queued ?? -1,
          presented: stats.presented ?? -1,
          skipped: stats.skipped ?? -1,
          videoPackets: player?.videoQueue?.length ?? -1,
          state: player?.getState?.() ?? "",
        });
        if (performance.now() - t0 > 8000) clearInterval(timer);
      }, 250);
    });
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
  const foregroundTrace = traceTransitions
    ? await page.evaluate(() => globalThis.__moviForegroundTrace ?? [])
    : undefined;
  return {
    backgroundedAt: Number(before.currentTime.toFixed(2)),
    hidden: hiddenProgress,
    foreground: visibleProgress,
    foregroundTrace,
  };
}

/**
 * Seek and wait for the seek to finish before a subtitle probe opens its cue
 * window, so the window measures the subtitle path and not seek recovery (which
 * the seek matrix already measures on its own).
 *
 * The bitmap branch used to give the seek a fixed 1s and then start its 12s cue
 * window. On a heavy DTS-HD MA remux the post-seek audio cold-prime holds
 * playback until a 2s audio cushion and a few video frames are buffered, and
 * on a link slower than the file's bitrate that alone can outlast 13s. Memories
 * (2026-09-15, run on a weak local network) read as "bitmap subtitles never
 * render" six times in a row while its only decoded cue sat 1.4s ahead of a
 * playhead still held in cold-prime — consistent with that, though not proven
 * to be it; either way the probe was charging seek recovery to subtitles.
 */
async function seekForSubtitleProbe(page, label, target) {
  await page.evaluate((seconds) => {
    document.querySelector("movi-player").currentTime = seconds;
  }, target);
  try {
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
  } catch (error) {
    const state = await page
      .evaluate(() => {
        const element = document.querySelector("movi-player");
        return { at: element?.currentTime ?? null, state: element?.player?.getState?.() ?? "missing" };
      })
      .catch(() => null);
    throw new Error(
      `${label} subtitle probe: seek to ${target.toFixed(2)}s did not settle within 60s ` +
        `(${JSON.stringify(state)}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
      await seekForSubtitleProbe(page, label, target);
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
      await seekForSubtitleProbe(page, label, target);
      if (!(await page.evaluate(() => document.querySelector("movi-player")?.playing))) {
        await page.evaluate(() => document.querySelector("movi-player").play());
      }
      try {
        await page.waitForFunction(
          () => {
            const renderer = document.querySelector("movi-player")?.player?.videoRenderer;
            const overlay = renderer?.subtitleOverlay;
            if (
              !renderer?.activeSubtitleCue?.image ||
              !overlay ||
              overlay.style.display === "none"
            ) {
              return false;
            }
            const media = overlay.querySelector("canvas, img");
            if (!media) return false;
            // <img>.src is set fire-and-forget by CanvasRenderer (a data:
            // URL PNG built from an already-decoded ImageBitmap — see
            // docs/PLAN_MERGE.MD's PGS pixel-path hop table). DOM presence
            // alone doesn't prove the browser has finished decoding that
            // data URL yet, so a read landing in that window would draw an
            // incomplete/blank image. This is a one-shot "not yet decoded
            // -> decoded" transition (unlike the live WebGL video canvas
            // this harness's picture check used to race against — that one
            // is a continuously-redrawn surface with no "done" signal at
            // all); requiring `complete && naturalWidth > 0` here is a
            // narrow, theoretical window this closes, not a reproduced bug.
            // The <canvas> branch (text-shaped bitmap subtitle renderers,
            // if any) is left exactly as before — canvas has no decode
            // step to wait for.
            if (media.tagName === "IMG") {
              return media.complete === true && media.naturalWidth > 0;
            }
            return true;
          },
          null,
          { timeout: subtitleProbeMs },
        );
        // The waitForFunction above proves the <canvas>/<img> element exists,
        // is displayed, and (for <img>) has finished decoding — it does NOT
        // prove the bitmap has any actual content. An all-transparent bitmap
        // (empty PGS frame, or a decode failure that produces a correctly-
        // sized but blank surface) satisfies all of that with zero rendered
        // content. Read the alpha channel back and require some of it to be
        // opaque.
        const pixels = await page.evaluate(() => {
          const renderer = document.querySelector("movi-player")?.player?.videoRenderer;
          const media = renderer?.subtitleOverlay?.querySelector("canvas, img");
          if (!media) return { hasMedia: false, totalPixels: 0, opaquePixels: 0 };
          const off = document.createElement("canvas");
          off.width = media.tagName === "IMG" ? media.naturalWidth || media.width : media.width;
          off.height = media.tagName === "IMG" ? media.naturalHeight || media.height : media.height;
          if (!off.width || !off.height) {
            return { hasMedia: true, totalPixels: 0, opaquePixels: 0 };
          }
          const ctx = off.getContext("2d", { willReadFrequently: true });
          if (!ctx) return { hasMedia: true, totalPixels: 0, opaquePixels: 0 };
          try {
            ctx.drawImage(media, 0, 0, off.width, off.height);
          } catch {
            return { hasMedia: true, totalPixels: 0, opaquePixels: 0 };
          }
          const { data } = ctx.getImageData(0, 0, off.width, off.height);
          let opaquePixels = 0;
          let totalPixels = 0;
          for (let i = 3; i < data.length; i += 4) {
            totalPixels++;
            if (data[i] > 10) opaquePixels++;
          }
          return { hasMedia: true, totalPixels, opaquePixels };
        });
        if (!pixels.hasMedia || pixels.totalPixels === 0 || pixels.opaquePixels === 0) {
          throw new Error(
            `bitmap subtitle overlay rendered with zero non-transparent pixels: ${JSON.stringify(pixels)}`,
          );
        }
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
          pixels,
          postProbePlayback,
        };
      } catch (error) {
        // "No cue appeared at t" has two readings and the bare timeout cannot
        // tell them apart: the bitmap pipeline is broken, or this position
        // simply has nothing to show. Samples with many PGS tracks hide the
        // ambiguity by brute force — Paprika needed 7 attempts before one
        // landed, Star Trek 3 — but a 2-track sample only gets 6 chances and
        // can run out while the decoder is perfectly healthy. So record what
        // the streaming decoder actually produced: how many cues it has for
        // this track, and where the nearest one to this target is. A nonzero
        // cue list with the nearest cue minutes away is a sampling miss; an
        // empty list after a 12s wait is a real failure.
        const cueContext = await page
          .evaluate(() => {
            const renderer = document.querySelector("movi-player")?.player?.videoRenderer;
            const cues = renderer?.subtitleCues ?? [];
            const at = Number(
              document.querySelector("movi-player")?.currentTime ?? -1,
            );
            let nearest = null;
            for (const cue of cues) {
              const distance =
                at < cue.start ? cue.start - at : at > cue.end ? at - cue.end : 0;
              if (nearest === null || distance < nearest.distance) {
                nearest = { start: cue.start, end: cue.end, distance };
              }
            }
            return { streamedCueCount: cues.length, at, nearest };
          })
          .catch(() => null);
        attempts.push({
          trackId: track.id,
          target,
          result: "no-visible-image-cue",
          error: error instanceof Error ? error.message : String(error),
          ...(cueContext ?? {}),
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
  const pageGuard = createPageGuard(page);
  if (throttleBps > 0) {
    const session = await context.newCDPSession(page);
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: throttleBps,
      uploadThroughput: -1,
    });
  }
  const decoderDiagnostics = [];
  page.on("console", (message) => {
    const text = message
      .text()
      .replace(/https?:\/\/\S+/gi, "[URL]")
      .replace(/[?&](?:token|sign|signature|authorization)=[^\s&]+/gi, "[REDACTED]");
    // B1b instrumentation (docs/PLAN_MERGE.MD §4.11) — printed live, unbounded,
    // separately from the 240-entry decoderDiagnostics ring buffer below. A
    // multi-GB sample generates enough HttpSource/buffer spam over the REST of
    // the run (final state check, subtitle testing, etc.) to evict the
    // switch-instant lines from that ring buffer long before the JSON gets
    // serialized at the end — confirmed empirically (Star Trek/Grave of the
    // Fireflies lost both B1b lines this way; only the small 少女终末旅行
    // sample kept one of two). This line is the reliable capture path.
    if (/B1b instrumentation/i.test(text)) {
      process.stderr.write(`[B1b LIVE] ${label}: ${text}\n`);
    }
    // Per-read HttpSource chatter matches the filter below on "buffer"
    // (bufferStart=/bufferEnd=) and it is emitted once per 512KB, so on a
    // multi-GB remux it is the overwhelming majority of the ring and evicts
    // everything worth reading. Measured on 萤火虫之墓: the 100-entry tail
    // attached to a `steady playback` failure held 85 of these and 15 lines
    // of actual state, which was not enough to say what stopped the picture.
    // Stalls, restarts and generation changes still come through — only the
    // routine per-read lines are dropped.
    if (/HttpSource\] Read:/.test(text)) return;
    // `desync` / `Black-frame recovery` are the player's own seek triggers.
    // Without them a run shows that a seek happened (the clock and decoder
    // lines get through) but never why: 萤火虫之墓 on 2026-09-15 recorded a
    // seek to 3735.774s two seconds after an audio track switch, with nothing
    // naming the desync detector or the black-frame watchdog as its source.
    if (
      /VideoDecoder|codec|decoder|software|WebCodecs|post-seek|burst|backpressure|buffer|worker|underrun|starv|Clock|PlayerState|playback-transition|B1b instrumentation|desync|Black-frame recovery/i.test(
        text,
      )
    ) {
      decoderDiagnostics.push(text.slice(0, 500));
      if (decoderDiagnostics.length > 240) decoderDiagnostics.shift();
    }
  });

  // Every step below is recorded individually and does NOT abort the sample.
  // A plain throw-on-first-failure loop meant one failing seek threw away
  // every check queued after it — including, on the samples that matter most,
  // the MPEG-2/AC3/PGS evidence that only a LATER step exercises (e.g. the
  // "middle seek" phase's real-picture/real-audio assertions never ran if
  // "head seek" failed first). A failed step is pushed to stepFailures with
  // its own snapshot and the run moves on to the next one; the sample is
  // judged failed at the end if stepFailures is non-empty, but every step
  // that COULD run still did, and the report keeps its result.
  const completed = {};
  const stepFailures = [];
  // Once the page is lost, later steps would only measure a fresh page (or
  // none) and each burn its own timeout; record them as skipped with the cause.
  const runPhase = async (name, fn) => {
    const lostBefore = pageGuard.lostReason();
    if (lostBefore !== null) {
      stepFailures.push({ step: name, error: `skipped: ${lostBefore}`, snapshot: null });
      process.stderr.write(`  [${label}] step "${name}" skipped: ${lostBefore}\n`);
      return null;
    }
    try {
      const value = await fn();
      completed[name] = value;
      return value;
    } catch (error) {
      const current = await snapshot(page).catch(() => null);
      const lost = pageGuard.lostReason();
      const message =
        (error instanceof Error ? error.message : String(error)) +
        (lost === null ? "" : ` [${lost}]`);
      stepFailures.push({
        step: name,
        error: message,
        snapshot: current ? compactSnapshot(current) : null,
      });
      process.stderr.write(
        `  [${label}] step "${name}" failed, continuing to the next step: ${message}\n`,
      );
      return null;
    }
  };

  try {
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(
    () => customElements.get("movi-player") !== undefined,
    null,
    { timeout: 30_000 },
  );
  pageGuard.arm();
  await page.evaluate(({ rawUrl, bufferSizeMb }) => {
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
    // Diagnostic-only knob for the 2026-09-13 headful memmove-starvation
    // investigation: without this the element never gets a `buffersize`
    // attribute, so HttpSource keeps its own computed 3%-of-file default and
    // there is no way to ask the harness for a specific stream window. Off
    // (element default) unless MOVI_BLACKBOX_BUFFER_MB is set.
    if (bufferSizeMb) element.setAttribute("buffersize", String(bufferSizeMb));
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
  }, { rawUrl: media.raw_url, bufferSizeMb: Number(process.env.MOVI_BLACKBOX_BUFFER_MB || 0) });

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
    player.audioSwitchTraceEnabled = true;
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

  // Content, not just clocks, gated behind runPhase like every other check
  // below: a failure here (e.g. the real-picture assertion) used to abort the
  // whole sample, which meant a codec whose steady-state picture assertion
  // trips never got to the seek matrix that would otherwise have shown
  // whether the SAME codec decodes correctly at a seek target.
  const steadyResult = await runPhase("steady playback", async () => {
    const { before: playBefore, after: playAfter } = await sampleWindow(page, sampleMs);
    try {
      const playProgress = assertHealthy(label, playBefore, playAfter, "steady playback");
      // CONTENT is recorded here, not asserted. This window opens ~2s after
      // play() by construction, and on a feature film that is the studio card:
      // the picture is legitimately motionless and the audio legitimately
      // silent. Measured on 萤火虫之墓, three different runs, three different
      // "failures" at the same t≈1.97s — flat picture, then unchanged picture,
      // then maxRms=2.08e-4 — while the SAME run read avgRms=0.0059 (37x the
      // silence floor) with a moving picture at the middle seek. Nothing was
      // wrong with the pipeline in any of them.
      //
      // A content assertion can only be made where content must exist, and no
      // fixed timestamp near t=0 is such a place. The binding picture/audio
      // assertions therefore live at the seek positions (mid-film, chosen
      // fractions of duration) and the end-of-run gate below requires that at
      // least one of them actually produced evidence — so this is a relocation
      // of the content gate, not a removal of it.
      const pictureEvidence = await assertRealPicture(page, label, "steady playback").catch(
        (error) => ({ advisory: error instanceof Error ? error.message : String(error) }),
      );
      let audioEvidence;
      if (playAfter.audioCodec && playAfter.audioCodec !== "N/A") {
        audioEvidence = await assertRealAudio(page, label, "steady playback").catch(
          (error) => ({ advisory: error instanceof Error ? error.message : String(error) }),
        );
      }
      return { playAfter, playProgress, pictureEvidence, audioEvidence };
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ` +
          `before=${JSON.stringify(compactSnapshot(playBefore))}; ` +
          `after=${JSON.stringify(compactSnapshot(playAfter))}; ` +
          `diagnostics=${decoderDiagnostics.slice(-100).join(" | ")}`,
      );
    }
  });

  // Whatever the steady-playback step did or didn't prove, take a fresh
  // snapshot to drive the rest of the session — the seek matrix needs
  // `duration` whether or not the content assertion above passed.
  const postStartupSnapshot = (await snapshot(page).catch(() => null)) ?? {};
  if (throttleBps > 0) {
    // A throttle that silently did not apply would make the whole run
    // meaningless, so prove it took effect before spending the rest of it.
    const measured = numeric(postStartupSnapshot.network?.lastSpeed);
    if (!(measured > 0) || measured > throttleBps * 1.2) {
      throw new Error(
        `${label} throttle of ${throttleBps} B/s did not take effect: measured lastSpeed ${measured} B/s`,
      );
    }
  }
  const playAfter = steadyResult?.playAfter ?? postStartupSnapshot;
  const playProgress = steadyResult?.playProgress;
  const pictureEvidence = steadyResult?.pictureEvidence;
  const audioEvidence = steadyResult?.audioEvidence;

  // Diagnostic early-exit for a single, apples-to-apples question: does THIS
  // harness's steady-playback picture assertion pass under a given headless
  // mode, on a given sample, without paying for the rest of the matrix? Added
  // for the 2026-09-13 headful-vs-headless investigation, where a hand-rolled
  // probe script (different buffersize, different startup path) was ruled out
  // as not equivalent to the real harness. Off by default.
  if (process.env.MOVI_BLACKBOX_STOP_AFTER_STEADY === "1") {
    return {
      label,
      status: stepFailures.length > 0 ? "fail" : "pass",
      stepFailures,
      stoppedAfterSteady: true,
      videoDecoder: playAfter.videoDecoder,
      videoCodec: playAfter.videoCodec,
      softwareDecodeReason: playAfter.softwareDecodeReason,
      steady: playProgress,
      pictureEvidence,
      audioEvidence,
      decoderDiagnostics,
    };
  }

  // Named precisely: this checks that WebCodecs ACCEPTED the prefer-hardware
  // config and did not fall back to the WASM software decoder — it does not
  // and cannot prove the frames were actually produced by a hardware decode
  // unit. `hardwareAcceleration: "prefer-hardware"` is a hint; a browser is
  // free to honour the config string while still decoding on the CPU.
  await runPhase("hardware-preferred config check", async () => {
  // The probe result is recorded whether or not it fails. A gate that only
  // leaves evidence when it trips cannot explain its own green light: the
  // first run of this capability check passed on a HEVC sample that was
  // demonstrably sitting on the software decoder, and nothing in the report
  // said whether the probe had answered "hardware not available" or had
  // simply failed to run.
  let hardwareProbeEvidence = { probed: false, reason: "decoder was not software" };
  // Capability-driven, NOT a codec allowlist. This phase used to run only for
  // /h\.?264|avc/, so the matrix's one HEVC Main10 sample could sit on
  // `Software (FFmpeg Worker)` and still pass the gate — which is what it was
  // doing on 2026-09-15, on a host whose capability probe reports HEVC
  // Main/Main10 (1080p and 4K), VP9 and AV1 all `supported: true` with
  // `powerEfficient: true` (Chrome 152, headless). Any allowlist has the same
  // shape of bug waiting in it: the next codec added to the matrix is exempt
  // until somebody remembers to extend the regex.
  //
  // So the question asked is the one that actually matters — "the player chose
  // software; could this browser have done it in hardware?" — and it is asked
  // of whatever codec is really playing. MPEG-2 (the Paprika sample) exempts
  // itself for free: WebCodecs has no MPEG-2 support, the probe comes back
  // unsupported, and software there is the only correct choice.
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
        // A representative codec string per family, used only to ask "is this
        // family hardware-decodable here". Deliberately generic: the player's
        // own resolved string is what it should have used, and if it failed to
        // resolve one at all (videoCodec === undefined in the stats snapshot)
        // that is itself the thing being caught.
        const family = String(track.codec ?? "").toLowerCase();
        const probeCodec = /hevc|h\.?265|hvc1|hev1/.test(family)
          ? (/10|main10/.test(family) ? "hvc1.2.4.L120.B0" : "hvc1.1.6.L120.B0")
          : /av01|av1/.test(family)
            ? "av01.0.04M.08"
            : /vp9|vp09/.test(family)
              ? "vp09.00.10.08"
              : /avc|h\.?264/.test(family)
                ? "avc1.640028"
                : null;
        if (!probeCodec) {
          // No WebCodecs equivalent (MPEG-2, and anything else the browser has
          // no decoder for). Software is correct here, not a defect.
          return {
            trackCodec: family,
            trackWidth: track.width,
            trackHeight: track.height,
            probeCodec: null,
            hardwareCapable: false,
            reason: "no WebCodecs equivalent for this codec family",
          };
        }
        const base = {
          codec: probeCodec,
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
        const hardwareCapable = await check({
          ...base,
          hardwareAcceleration: "prefer-hardware",
        });
        return {
          trackCodec: family,
          trackWidth: track.width,
          trackHeight: track.height,
          probeCodec,
          hardwareCapable,
          extradataHex: extradata
            ? [...extradata.slice(0, 48)]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("")
            : "",
          genericHardwareNoDescription: hardwareCapable,
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
      hardwareProbeEvidence = {
        videoDecoder: playAfter.videoDecoder,
        videoCodec: playAfter.videoCodec ?? null,
        softwareDecodeReason: playAfter.softwareDecodeReason ?? null,
        probe: supportProbe,
      };
      // Only a defect when the browser says it COULD have done this in
      // hardware. A `hardwareCapable: false` probe means software was the
      // right call and this is not a finding.
      if (supportProbe?.hardwareCapable) {
        throw new Error(
          `${label} used ${playAfter.videoDecoder} for ${supportProbe.trackCodec || "this codec"} ` +
            `even though the browser reports hardware support for it ` +
            `(probe codec ${supportProbe.probeCodec}); ` +
            `videoCodec in stats=${String(playAfter.videoCodec)}; ` +
            `softwareDecodeReason=${String(playAfter.softwareDecodeReason)}; ` +
            `support probe: ${JSON.stringify(supportProbe)}; ` +
            `decoder diagnostics: ${decoderDiagnostics.slice(-30).join(" | ")}`,
        );
      }
    } else if (!/hardware-preferred/i.test(playAfter.videoDecoder)) {
      const message =
        `${label} used ${playAfter.videoDecoder}; blackbox requires the hardware-preferred WebCodecs config; ` +
        `queue=${playAfter.frameQueue} [${playAfter.frameQueueHeadTime.toFixed(3)}, ${playAfter.frameQueueTailTime.toFixed(3)}], ` +
        `renderer=${playAfter.rendererCurrentTime.toFixed(3)}, audioClock=${playAfter.audioClock.toFixed(3)}`;
      if (!allowNoPreference) throw new Error(message);
      process.stderr.write(`DIAGNOSTIC-ONLY: ${message}\n`);
    }
  // runPhase already records a phase's return value under `completedPhases`
  // in the report, so returning the evidence here is all that is needed to
  // make it readable after the fact.
  return hardwareProbeEvidence;
  });

  // Observation, not an assertion (team-lead call, 2026-09-13): `powerEfficient`
  // from navigator.mediaCapabilities.decodingInfo() is the browser's own
  // self-report of whether a config actually runs on the power-efficient
  // (hardware) path — a real answer where `hardwareAcceleration:
  // "prefer-hardware"` is only a request. Recorded here so a report can say
  // something stronger than "the config was accepted" without yet gating on
  // it; only implemented for H.264 so far (the codec the ambiguity was about).
  const mediaCapabilities = await (async () => {
    if (!/h\.?264|avc/i.test(playAfter.videoCodec || label)) {
      return { probed: false, reason: "only implemented for h264/avc so far" };
    }
    try {
      return await page.evaluate(async () => {
        const element = document.querySelector("movi-player");
        const track = element?.player?.trackManager?.getActiveVideoTrack?.();
        if (!track || !navigator.mediaCapabilities?.decodingInfo) {
          return { probed: false, reason: "no active track or no mediaCapabilities API" };
        }
        const info = await navigator.mediaCapabilities.decodingInfo({
          type: "file",
          video: {
            contentType: 'video/mp4; codecs="avc1.640028"',
            width: track.width,
            height: track.height,
            bitrate: 8_000_000,
            framerate: 24,
          },
        });
        return {
          probed: true,
          supported: Boolean(info.supported),
          powerEfficient: Boolean(info.powerEfficient),
          smooth: Boolean(info.smooth),
        };
      });
    } catch (error) {
      return { probed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  })();

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
    const pre = await snapshot(page).catch(() => null);
    const result = await runPhase(phase, () =>
      seekAndSample(
        page,
        label,
        target,
        phase,
        numeric(pre?.network?.streamGeneration) + 2,
      ),
    );
    // A failed seek still needs to carry its phase/target so the report
    // stays legible — a bare `null` in the seeks array loses which of the
    // four targets it was.
    seeks.push(result ?? { phase, target: Number(target.toFixed(2)), status: "failed" });
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
  // A/B against the fork baseline stays comparable. Prefer a seek that
  // actually succeeded over one recorded merely as failed.
  const seekProgress =
    seeks.find((s) => s.phase === "middle seek" && s.status !== "failed") ??
    seeks.find((s) => s.status !== "failed") ??
    seeks[0];

  const subtitles = await runPhase("subtitles", () =>
    validateSubtitles(page, label),
  );

  // The content gate, stated once for the whole session. `steady playback`
  // records picture/audio evidence rather than asserting it (see the note
  // there: its window lands on the studio card), so SOMETHING has to still
  // require that this sample proved it can put a picture on the canvas and
  // sound in the graph. That is this step. It is deliberately position-
  // agnostic — any step that produced real evidence satisfies it — so it
  // cannot be defeated by a title card, and it cannot be satisfied by a
  // decoder that never produced content anywhere.
  await runPhase("content evidence", async () => {
    const real = (evidence) =>
      Boolean(evidence) && !evidence.advisory;
    const pictureProofs = [pictureEvidence, ...seeks.map((s) => s?.picture)].filter(real);
    const audioProofs = [audioEvidence, ...seeks.map((s) => s?.audio)].filter(real);
    const needsAudio = Boolean(playAfter.audioCodec && playAfter.audioCodec !== "N/A");
    if (pictureProofs.length === 0) {
      throw new Error(
        `${label} never produced real picture evidence at any position this session ` +
          `(steady playback advisory: ${pictureEvidence?.advisory ?? "n/a"})`,
      );
    }
    if (needsAudio && audioProofs.length === 0) {
      throw new Error(
        `${label} never produced real audio evidence at any position this session ` +
          `(steady playback advisory: ${audioEvidence?.advisory ?? "n/a"})`,
      );
    }
    return {
      picturePositions: pictureProofs.length,
      audioPositions: audioProofs.length,
      steadyPictureAdvisory: pictureEvidence?.advisory ?? null,
      steadyAudioAdvisory: audioEvidence?.advisory ?? null,
    };
  });

  await runPhase("final state check", async () => {
    const check = await snapshot(page);
    if (check.state !== "playing" || !check.clockRunning) {
      throw new Error(`${label} did not finish subtitle-integrated playback with a running clock`);
    }
    if (check.errors.length > 0) {
      throw new Error(`${label} emitted player errors during subtitle-integrated playback`);
    }
    if (check.network) {
      if (Number(check.network.readStalls ?? 0) !== 0) {
        throw new Error(`${label} recorded HTTP source stalls after subtitle testing`);
      }
      // Same gauge-vs-counter problem as assertHealthy's copy of this check
      // (see the long note there). Here there IS a page to poll, so measure
      // the thing the message claims outright: give the parked reads a bounded
      // window to drain and fail only if they never do. This is the site that
      // actually fired — one Star Trek run in three, immediately after a
      // subtitle probe's burst of seeks, with playback otherwise healthy.
      const reads = await waitForStrandedReads(page, 15_000);
      if (reads.oldestPendingReadWaitMs >= STRANDED_READ_MS) {
        throw new Error(
          `${label} has an HTTP read stranded after subtitle testing: waiting ` +
            `${(reads.oldestPendingReadWaitMs / 1000).toFixed(1)}s for its bytes ` +
            `(${reads.bufferWaiters} parked waiter(s))`,
        );
      }
    }
    return null;
  });

  const finalSnapshot = (await snapshot(page).catch(() => null)) ?? postStartupSnapshot;

  // The byte budget is checked LAST, against the whole session: every seek,
  // every subtitle probe and every restart above has already been paid for by
  // the time this runs. It runs even if earlier steps failed — the bytes were
  // still spent either way, and are exactly what a stuck/thrashing failure
  // mode would inflate.
  const budget = await runPhase("byte budget", async () =>
    assertByteBudget(label, {
      sizeBytes: media.size,
      wallSeconds: (Date.now() - sessionStartedAt) / 1000,
      snapshot: finalSnapshot,
    }),
  );

  return {
    label,
    status: stepFailures.length > 0 ? "fail" : "pass",
    stepFailures,
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
    mediaCapabilities,
    _softwareReason: playAfter._softwareReason,
    hardwareRetryCount: playAfter.hardwareRetryCount,
    hardwareResurrectionAttempts: finalSnapshot.hardwareRetryCount,
    bufferMode: playAfter.sharedSourceBuffer ? "shared-array-buffer" : "plain-buffer",
    crossOriginIsolated: playAfter.crossOriginIsolated,
    videoDecoder: playAfter.videoDecoder,
    audioDecoder: playAfter.audioDecoder,
    videoCodec: playAfter.videoCodec,
    audioCodec: playAfter.audioCodec,
    steady: playProgress,
    pictureEvidence,
    audioEvidence,
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
  } catch (error) {
    // A setup-level failure (login/page-load/element-mount, or anything else
    // thrown OUTSIDE a runPhase-wrapped step) — nothing above produced a
    // per-step record for this. Attach whatever diagnostics and network state
    // exist so the failure entry in the report is not just a bare message;
    // this is the gap the team lead flagged: failed samples had none of
    // decoderDiagnostics/getNetworkStats() attached, which is exactly what
    // triage needs most.
    const current = await snapshot(page).catch(() => null);
    if (error instanceof Error) {
      const lost = pageGuard.lostReason();
      if (lost !== null) error.message += ` [${lost}]`;
      error.decoderDiagnostics = decoderDiagnostics.slice(-120);
      error.networkStats = current?.network ?? null;
      error.partial = { failedPhase: "setup", completed };
    }
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

// Default stays OLD headless — an escalation was tried on 2026-09-13 and it
// did NOT end at headful, despite a decisive single-metric experiment
// pointing that way. In order:
//   1. old headless (Chrome's default when Playwright drives an external
//      Chrome binary): a WebCodecs hardware decode path fed a near-black/
//      frozen frame back to assertRealPicture (luma spread ~1.0, 1 unique
//      colour).
//   2. "--headless=new" (keeps GPU compositing on paper): SAME sample, SAME
//      real Chrome build — still black (spread 0.0). Screenshot saved by the
//      failure-capture path this same investigation added:
//      .blackbox-results/screenshots/Good.Will.Hunting...steady_playback-*.png.
//   3. headful, as a narrow team-lead probe (one metric, one short window,
//      script at .secrets/headful-picture-probe.mjs outside this repo): DID
//      get a normal picture back (luma spread 176.1, 800 unique colours).
//      But running the FULL harness (this file, not the probe) headful on
//      the SAME sample got stuck in "buffering" and never reached 1x twice
//      in a row within 90s, TWICE in a row (elapsedSeconds 88.4s and 119.3s,
//      currentTime creeping to only 6.8s / 10.4s) — it never even reached the
//      picture assertion to test whether the black-frame problem was fixed.
// So headful is NOT a safe default for the full harness on this host as it
// stands: it trades a known, narrow gap (no real picture evidence for
// hardware-decode streams under headless) for an unknown, broader one
// (playback not reliably reaching steady state at all). Staying on old
// headless keeps the harness able to finish a full 7-sample sweep, which is
// what it did on 2026-09-13. MOVI_BLACKBOX_HEADLESS=new or =false remain
// available for a deliberate, isolated re-investigation — never
// "swiftshader": that forces software GL and reintroduces the very
// hardware/software confound this investigation exists to remove.
const headlessMode = process.env.MOVI_BLACKBOX_HEADLESS ?? "old";

async function main() {
  const login = await api("/api/auth/login", { username, password });
  const { chromium } = await import("playwright");
  const executablePath = process.env.MOVI_CHROME_EXECUTABLE || undefined;
  const browser = await chromium.launch({
    headless: headlessMode !== "false",
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--enable-features=SharedArrayBuffer",
      ...(headlessMode === "new" ? ["--headless=new"] : []),
    ],
  });
  // Chrome version and GPU renderer string, once per run: hardware-decode
  // evidence without a browser version and GPU attached is not reproducible —
  // WebCodecs hardware support depends on both.
  const chromeVersion = browser.version();
  const gpuRenderer = await (async () => {
    const probePage = await browser.newPage();
    try {
      return await probePage.evaluate(() => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (!gl) return "no-webgl-context";
        const info = gl.getExtension("WEBGL_debug_renderer_info");
        return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "debug-info-unavailable";
      });
    } catch (error) {
      return `probe-failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      await probePage.close();
    }
  })();

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
        // runOne no longer throws for a step that failed mid-sample — it
        // keeps going and comes back with status:"fail" plus a stepFailures
        // array covering every step that tripped, alongside every step that
        // DID complete (seeks, evidence, byte budget, ...). Only a
        // setup-level problem (login/page-load/element-mount) still throws.
        const result = await runOne(browser, login.token, mediaPath);
        results.push(result);
        if (result.status === "fail") {
          failures.push({
            label,
            message: result.stepFailures.map((f) => `[${f.step}] ${f.error}`).join(" | "),
          });
          console.log(`FAIL (${((Date.now() - sampleStartedAt) / 1000).toFixed(1)}s)`);
          for (const f of result.stepFailures) {
            process.stderr.write(`  ${label} [${f.step}]: ${f.error}\n`);
          }
        } else {
          console.log(`PASS (${((Date.now() - sampleStartedAt) / 1000).toFixed(1)}s)`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ label, message });
        results.push({
          label,
          status: "fail",
          elapsedSeconds: Number(((Date.now() - sampleStartedAt) / 1000).toFixed(1)),
          error: message,
          // Whatever this sample DID prove before it stopped, plus the
          // diagnostics/network state runOne attaches to a setup-level throw
          // (see the catch at the bottom of runOne) — a failed sample used to
          // carry none of this, which is exactly what triage needs most.
          failedPhase: error?.partial?.failedPhase ?? null,
          completedPhases: error?.partial?.completed ?? null,
          decoderDiagnostics: error?.decoderDiagnostics ?? null,
          network: error?.networkStats ?? null,
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
    headless: headlessMode !== "false",
    headlessMode,
    // Hardware-decode evidence is meaningless without knowing which browser
    // build and GPU produced it — support and behaviour both move with these.
    chromeVersion,
    gpuRenderer,
    executablePath: executablePath ?? "(playwright bundled chromium)",
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
