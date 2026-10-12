// The arithmetic real-openlist-playback.mjs uses to turn two observations into
// a verdict, pulled out here so it can be unit-tested offline against fixtures
// recorded from real runs (see test/scripts/fixtures/blackbox-recorded-windows.json).
//
// `progression()` started as the shipping implementation lifted verbatim (RED
// baseline: it reported "presented only -10 frames" for the Grave of the
// Fireflies sample because a renderer reset makes framesPresented go
// backwards). It has since been fixed to recognise a reset and fall back to
// the presented PTS, which is monotone across a reset that contains no seek.

const FIRST_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;

// States a steady-state assertion may sample in. Anything else is a
// transition — seeking, (re)buffering, loading, erroring out — and a sample
// taken there is measuring the transition, not steady playback.
const UNSTEADY_STATES = new Set(["seeking", "buffering", "loading", "error"]);

export function isSteady(sample) {
  return !UNSTEADY_STATES.has(sample.state);
}

export function progression(before, after) {
  const wallSeconds = Math.max(0.001, (after.wallMs - before.wallMs) / 1000);
  const audioBefore =
    before.audioClock >= 0 ? before.audioClock : before.audioMediaTime;
  const audioAfter =
    after.audioClock >= 0 ? after.audioClock : after.audioMediaTime;
  // The renderer's frame counter is per-pipeline and restarts at zero when
  // the video pipeline is rebuilt (a hardware resurrection attempt, or a
  // seek). The delta then comes out negative, which is a statement about the
  // harness's arithmetic, not the player. Detect the reset and fall back to
  // the presented PTS (rendererCurrentTime), which is monotone across a
  // reset that contains no seek and is the honest signal for picture
  // progress in that case.
  const framesReset = after.framesPresented < before.framesPresented;
  const frameDelta = after.framesPresented - before.framesPresented;
  return {
    wallSeconds,
    mediaSeconds: after.currentTime - before.currentTime,
    mediaRate: (after.currentTime - before.currentTime) / wallSeconds,
    framesReset,
    frames: framesReset ? null : frameDelta,
    presentedFps: framesReset ? null : frameDelta / wallSeconds,
    rendererSeconds: after.rendererCurrentTime - before.rendererCurrentTime,
    audioSeconds: audioAfter - audioBefore,
  };
}

/**
 * Name what disturbed a window that assertHealthy is about to judge.
 *
 * Two disturbances are distinguished, and they are mutually exclusive within
 * one window: a window that left steady state for an unsteady one is
 * reported by the state it landed in (the presentation-rebase check would be
 * noise on top of that — of course the renderer re-bases mid-seek); a window
 * that STAYED steady throughout but had the renderer's presentation start pts
 * move underneath it is a rebase happening without any state gate to catch
 * it.
 */
export function classifyWindow([before, after]) {
  if (isSteady(before) && !isSteady(after)) {
    return [{ kind: `state:${after.state}` }];
  }
  if (isSteady(before) && isSteady(after)) {
    if (
      after.rendererPresentationStartPts !== before.rendererPresentationStartPts
    ) {
      return [{ kind: "presentation-rebase" }];
    }
  }
  return [];
}

export function summarizeDisturbances(disturbances) {
  return disturbances.map((d) => d.kind).join(", ");
}

// What one stream generation may download, derived from an invariant of
// HttpSource rather than estimated. A generation downloads forward from its
// startOffset into a window of at most `windowBytes`, and the window only
// slides over bytes the demuxer has already consumed, so by the time the
// demuxer has read up to `consumedEnd` the generation can have fetched
// everything up to consumedEnd plus one window, plus the first chunk and one
// in-flight fill that are in transit when it is superseded:
//
//   bytes <= (consumedEnd - startOffset) + windowBytes + FIRST + MAX chunk
//
// Measuring the consumed span instead of guessing it from lifetime x bitrate
// matters because a forward seek that lands inside the window skips hundreds of
// megabytes without any wall time passing; the window slides over them and
// refills, which is correct and which a time-based estimate cannot see.
//
// The allowance is per generation rather than one window for the whole
// session because every seek outside the window abandons the old stream and
// the new one refills a window from the new position: N generations can
// legitimately move N windows, and how fast the link refills them is the
// link's business. A generation that exceeds this was not held by its window,
// which is the prefetch running away.
export function generationAllowance({ startOffset, consumedEnd, windowBytes }) {
  return (
    Math.max(0, consumedEnd - startOffset) +
    windowBytes +
    FIRST_RANGE_CHUNK_BYTES +
    MAX_RANGE_CHUNK_BYTES
  );
}

// Largest gap between the source-wide byte counter and everything the
// per-source counters add up to before the accounting is declared leaky.
const COUNTER_DRIFT_BYTES = 1024 * 1024;

// The source keeps only this many generations, so once it has reached it the
// sum can no longer be expected to match the total.
const GENERATION_LOG_CAPACITY = 64;

export function byteBudget({
  totalBytes,
  generationBytes,
  oneOff,
  windowBytes,
}) {
  const perGeneration = generationBytes.map((generation) => {
    const allowance = Math.round(
      generationAllowance({
        startOffset: generation.startOffset,
        consumedEnd: generation.consumedEnd,
        windowBytes,
      }),
    );
    return {
      generation: generation.generation,
      startOffset: generation.startOffset,
      consumedEnd: generation.consumedEnd,
      bytes: generation.bytes,
      ms: generation.ms,
      allowance,
      ratio: allowance > 0 ? generation.bytes / allowance : 0,
    };
  });
  let worstGeneration = null;
  for (const entry of perGeneration) {
    if (worstGeneration === null || entry.ratio > worstGeneration.ratio) {
      worstGeneration = entry;
    }
  }
  const summed = generationBytes.reduce((sum, g) => sum + g.bytes, 0);
  const violations = [];
  for (const entry of perGeneration) {
    if (entry.bytes > entry.allowance) {
      violations.push({
        kind: "generation-over-allowance",
        generation: entry.generation,
        startOffset: entry.startOffset,
        consumedEnd: entry.consumedEnd,
        bytes: entry.bytes,
        allowance: entry.allowance,
        ms: entry.ms,
      });
    }
  }
  if (oneOff.bytes > oneOff.requestedBytes) {
    violations.push({
      kind: "one-off-over-request",
      requestedBytes: oneOff.requestedBytes,
      bytes: oneOff.bytes,
    });
  }
  const accounted = summed + oneOff.bytes;
  const logTruncated = generationBytes.length >= GENERATION_LOG_CAPACITY;
  if (!logTruncated && Math.abs(totalBytes - accounted) > COUNTER_DRIFT_BYTES) {
    violations.push({
      kind: "counter-mismatch",
      totalBytes,
      generationSum: summed,
      oneOffBytes: oneOff.bytes,
    });
  }
  return {
    windowTerm: windowBytes,
    budgetBytes: perGeneration.reduce((sum, g) => sum + g.allowance, 0),
    generationSum: summed,
    oneOff,
    perGeneration,
    worstGeneration,
    violations,
  };
}
