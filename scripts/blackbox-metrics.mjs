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
const VBR_SLACK = 2.5;

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

export function byteBudget({
  sizeBytes,
  durationSeconds,
  wallSeconds,
  generations,
  windowBytes,
}) {
  // Round the bitrate before it feeds the streamed-bytes term. The budget is
  // a ceiling meant to be read alongside `bitrateBytesPerSecond` in a report;
  // deriving streamedTerm from the unrounded fraction would make the two
  // numbers disagree by the rounding error times wallSeconds, for no benefit
  // (nothing here needs sub-byte-per-second precision).
  const rawBitrate = durationSeconds > 0 ? sizeBytes / durationSeconds : 0;
  const bitrate = Math.round(rawBitrate);
  const streamed = wallSeconds * bitrate * VBR_SLACK;
  const perGeneration =
    Math.max(1, generations) * (FIRST_RANGE_CHUNK_BYTES + MAX_RANGE_CHUNK_BYTES);
  const total = streamed + perGeneration + windowBytes;
  return {
    bitrateBytesPerSecond: bitrate,
    streamedTerm: Math.round(streamed),
    generationTerm: perGeneration,
    windowTerm: windowBytes,
    budgetBytes: Math.round(total),
  };
}
