#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

export function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeMoviStats(stats = {}) {
  return {
    decodePath: stats["Decode Path"] ?? stats.decodePath ?? "",
    audioUnderrunRisk:
      stats["Audio Underrun Risk"] ?? stats.audioUnderrunRisk ?? "",
    audioBufferedSeconds: numeric(
      stats["Audio Buffered Seconds"] ??
        stats["Audio Buffered"] ??
        stats.audioBufferedSeconds,
    ),
    audioDecoderQueue: numeric(
      stats["Audio Decoder Queue"] ?? stats.audioDecoderQueue,
    ),
    videoDecoderQueue: numeric(
      stats["Video Decoder Queue"] ?? stats.videoDecoderQueue,
    ),
    audioWorkerQueueDepth: numeric(
      stats["Audio Worker Queue Depth"] ?? stats.audioWorkerQueueDepth,
    ),
    audioWorkerInFlight: numeric(
      stats["Audio Worker In Flight"] ?? stats.audioWorkerInFlight,
    ),
    audioWorkerReorderBacklog: numeric(
      stats["Audio Worker Reorder Backlog"] ?? stats.audioWorkerReorderBacklog,
    ),
    audioWorkerStaleDrops: numeric(
      stats["Audio Worker Stale Drops"] ?? stats.audioWorkerStaleDrops,
    ),
    seekWaitingForVideo:
      stats["Seek Waiting For Video"] ?? stats.seekWaitingForVideo ?? "",
    seekAudioHoldPackets: numeric(
      stats["Seek Audio Hold Packets"] ?? stats.seekAudioHoldPackets,
    ),
    seekAudioDroppedPackets: numeric(
      stats["Seek Audio Dropped Packets"] ?? stats.seekAudioDroppedPackets,
    ),
    pausePrebufferPackets: numeric(
      stats["Pause Prebuffer Packets"] ?? stats.pausePrebufferPackets,
    ),
  };
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizePlaybackSample(sample = {}) {
  const video = sample.video ?? {};
  const moviRenderer = sample.moviRenderer ?? {};
  const audioRenderer = sample.audioRenderer ?? {};

  const hasMoviFrames = finite(moviRenderer.framesPresented);
  const hasMoviTime = finite(moviRenderer.currentTime);
  const videoSource = hasMoviFrames || hasMoviTime ? "movi" : "video";

  return {
    ...sample,
    wallMs: numeric(sample.wallMs),
    video: {
      currentTime: hasMoviTime
        ? moviRenderer.currentTime
        : numeric(video.currentTime),
      presentedFrames: hasMoviFrames
        ? moviRenderer.framesPresented
        : numeric(video.presentedFrames),
      droppedFrames: numeric(video.droppedFrames),
      source: videoSource,
    },
    audio: {
      currentMediaTime: numeric(audioRenderer.currentMediaTime),
      maxScheduledMediaTime: numeric(audioRenderer.maxScheduledMediaTime),
      scheduledCount: numeric(audioRenderer.scheduledCount),
      activeSources: numeric(audioRenderer.activeSources),
      isPlaying: Boolean(audioRenderer.isPlaying),
    },
    moviRenderer: {
      currentTime: numeric(moviRenderer.currentTime),
      framesPresented: numeric(moviRenderer.framesPresented),
      frameQueue: numeric(moviRenderer.frameQueue),
      videoFrameRate: numeric(moviRenderer.videoFrameRate),
      syncedToAudio: Boolean(moviRenderer.syncedToAudio),
    },
  };
}

function deltaRate(first, last, path) {
  const before = path.split(".").reduce((acc, key) => acc?.[key], first);
  const after = path.split(".").reduce((acc, key) => acc?.[key], last);
  const wallSeconds = Math.max(0.001, (last.wallMs - first.wallMs) / 1000);
  if (!finite(before) || !finite(after)) return 0;
  return (after - before) / wallSeconds;
}

export function summarize(samples) {
  const normalized = samples.map(normalizePlaybackSample);
  const first = normalized[0];
  const last = normalized.at(-1);
  if (!first || !last) {
    return {
      samples: samples.length,
      wallSeconds: 0,
      presentedFps: 0,
      mediaRate: 0,
      droppedFrames: 0,
    };
  }

  const wallSeconds = Math.max(0.001, (last.wallMs - first.wallMs) / 1000);
  const presentedFps = deltaRate(first, last, "video.presentedFrames");
  const mediaRate = deltaRate(first, last, "video.currentTime");
  const audioMediaRate = deltaRate(first, last, "audio.currentMediaTime");

  return {
    samples: normalized.length,
    wallSeconds,
    presentedFps,
    mediaRate,
    audioMediaRate,
    droppedFrames: last.video.droppedFrames - first.video.droppedFrames,
    sampleSource: last.video.source,
    lastAudioBufferedSeconds: last.movi.audioBufferedSeconds,
    lastAudioDecoderQueue: last.movi.audioDecoderQueue,
    lastVideoDecoderQueue: last.movi.videoDecoderQueue,
    lastAudioWorkerQueueDepth: last.movi.audioWorkerQueueDepth,
    lastAudioWorkerInFlight: last.movi.audioWorkerInFlight,
    lastAudioWorkerReorderBacklog: last.movi.audioWorkerReorderBacklog,
    lastAudioWorkerStaleDrops: last.movi.audioWorkerStaleDrops,
    lastSeekWaitingForVideo: last.movi.seekWaitingForVideo,
    lastSeekAudioHoldPackets: last.movi.seekAudioHoldPackets,
    lastSeekAudioDroppedPackets: last.movi.seekAudioDroppedPackets,
    lastPausePrebufferPackets: last.movi.pausePrebufferPackets,
    lastDecodePath: last.movi.decodePath,
    lastAudioUnderrunRisk: last.movi.audioUnderrunRisk,
  };
}

export function diffSummary(current, baseline) {
  const keys = [
    "presentedFps",
    "mediaRate",
    "audioMediaRate",
    "droppedFrames",
    "lastAudioBufferedSeconds",
    "lastAudioDecoderQueue",
    "lastVideoDecoderQueue",
    "lastAudioWorkerQueueDepth",
    "lastAudioWorkerInFlight",
    "lastAudioWorkerReorderBacklog",
    "lastAudioWorkerStaleDrops",
    "lastSeekAudioHoldPackets",
    "lastSeekAudioDroppedPackets",
    "lastPausePrebufferPackets",
  ];
  const diff = {};
  for (const key of keys) {
    const before = baseline.summary?.[key];
    const after = current.summary?.[key];
    if (typeof before !== "number" || typeof after !== "number") continue;
    diff[key] = {
      before,
      after,
      delta: after - before,
      percent:
        before === 0
          ? null
          : Number((((after - before) / before) * 100).toFixed(2)),
    };
  }
  return diff;
}

async function main() {
  const pageUrl = process.env.MOVI_BENCH_PAGE_URL;
  const outputPath = resolve(
    process.env.MOVI_BENCH_OUTPUT ?? "bench-results/playback-current.json",
  );
  const baselinePath = process.env.MOVI_BENCH_BASELINE
    ? resolve(process.env.MOVI_BENCH_BASELINE)
    : null;
  const durationMs = Number(process.env.MOVI_BENCH_DURATION_MS ?? 30_000);
  const sampleEveryMs = Number(process.env.MOVI_BENCH_SAMPLE_MS ?? 1_000);

  if (!pageUrl) {
    console.log(
      "MOVI_BENCH_PAGE_URL is not set; skipping playback benchmark. " +
        "Set it to an OpenList/movi playback page URL to collect telemetry.",
    );
    return;
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: process.env.MOVI_BENCH_HEADLESS !== "0",
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
    ],
  });

  const page = await browser.newPage();
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const playSelector = process.env.MOVI_BENCH_PLAY_SELECTOR;
  if (playSelector) {
    await page.locator(playSelector).click({ timeout: 10_000 });
  } else {
    await page.evaluate(() => {
      const video = document.querySelector("video");
      void video?.play?.();
    });
  }

  const started = performance.now();
  const samples = [];
  while (performance.now() - started < durationMs) {
    await page.waitForTimeout(sampleEveryMs);
    const { moviStats, ...sample } = await page.evaluate(() => {
      const localNumeric = (value) =>
        typeof value === "number" && Number.isFinite(value) ? value : 0;
      const findMoviElement = () => {
        let found = null;
        const walk = (root) => {
          if (!root || found) return;
          for (const el of root.querySelectorAll("*")) {
            if (el.tagName?.toLowerCase?.() === "movi-player") {
              found = el;
              return;
            }
            if (el.shadowRoot) walk(el.shadowRoot);
            if (found) return;
          }
        };
        walk(document);
        return found;
      };
      const video = document.querySelector("video");
      const quality = video?.getVideoPlaybackQuality?.();
      const movi =
        globalThis.__moviBenchPlayer ??
        findMoviElement()?.player ??
        null;

      return {
        wallMs: performance.now(),
        video: {
          currentTime: localNumeric(video?.currentTime),
          presentedFrames: localNumeric(
            quality?.totalVideoFrames ?? quality?.presentedFrames,
          ),
          droppedFrames: localNumeric(quality?.droppedVideoFrames),
        },
        moviRenderer: {
          currentTime: localNumeric(movi?.videoRenderer?.currentTime),
          framesPresented: localNumeric(movi?.videoRenderer?.framesPresented),
          frameQueue: localNumeric(movi?.videoRenderer?.frameQueue?.length),
          videoFrameRate: localNumeric(movi?.videoRenderer?.videoFrameRate),
          syncedToAudio: Boolean(movi?.videoRenderer?.syncedToAudio),
        },
        audioRenderer: {
          currentMediaTime: localNumeric(movi?.audioRenderer?.currentMediaTime),
          maxScheduledMediaTime: localNumeric(
            movi?.audioRenderer?.maxScheduledMediaTime,
          ),
          scheduledCount: localNumeric(movi?.audioRenderer?.scheduledCount),
          activeSources: localNumeric(movi?.audioRenderer?.activeSources?.length),
          isPlaying: Boolean(movi?.audioRenderer?.isPlaying),
        },
        moviStats: movi?.getStats?.() ?? {},
      };
    });
    samples.push(
      normalizePlaybackSample({
        ...sample,
        movi: normalizeMoviStats(moviStats),
      }),
    );
  }

  await browser.close();

  const result = {
    pageUrl,
    durationMs,
    sampleEveryMs,
    collectedAt: new Date().toISOString(),
    summary: summarize(samples),
    samples,
  };

  if (baselinePath) {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    result.diffFromBaseline = diffSummary(result, baseline);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.summary, null, 2));
  if (result.diffFromBaseline) {
    console.log("Diff from baseline:");
    console.log(JSON.stringify(result.diffFromBaseline, null, 2));
  }
  console.log(`Wrote ${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
