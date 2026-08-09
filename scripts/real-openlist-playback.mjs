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

function assertHealthy(label, before, after, phase) {
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
    throw new Error(`${label} presented only ${progress.frames} frames during ${phase}`);
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
  if (!after.crossOriginIsolated || !after.sharedSourceBuffer) {
    throw new Error(`${label} did not exercise the SharedArrayBuffer source path`);
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
    if (Number(after.network.streamGeneration ?? 0) > 4) {
      throw new Error(`${label} opened too many HTTP stream generations during ${phase}`);
    }
  }
  return progress;
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

  const playBefore = await snapshot(page);
  await page.waitForTimeout(sampleMs);
  const playAfter = await snapshot(page);
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

  const target = Math.max(
    5,
    Math.min(playAfter.duration - 5, playAfter.duration * 0.35),
  );
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

  const seekBefore = await snapshot(page);
  await page.waitForTimeout(postSeekSampleMs);
  const seekAfter = await snapshot(page);
  let seekProgress;
  try {
    seekProgress = assertHealthy(label, seekBefore, seekAfter, "post-seek playback");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
        `before=${JSON.stringify(compactSnapshot(seekBefore))}; ` +
        `after=${JSON.stringify(compactSnapshot(seekAfter))}; ` +
      `diagnostics=${decoderDiagnostics.slice(-120).join(" | ")}`,
    );
  }

  const subtitles = await validateSubtitles(page, label);
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
    const generationBudget = 4 + Number(subtitles.attempts?.length ?? 0);
    const streamGeneration = Number(finalSnapshot.network.streamGeneration ?? 0);
    if (streamGeneration > generationBudget) {
      throw new Error(
        `${label} opened ${streamGeneration} HTTP stream generations after subtitle testing; budget=${generationBudget}`,
      );
    }
  }

  await context.close();
  return {
    label,
    size: media.size,
    duration: playAfter.duration,
    decodePath: playAfter.decodePath,
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
  try {
    for (const mediaPath of mediaPaths) {
      const label = basename(mediaPath);
      process.stdout.write(`blackbox: ${label} ... `);
      const result = await runOne(browser, login.token, mediaPath);
      results.push(result);
      console.log("PASS");
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
    results,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
