/**
 * MoviPlayer - Main public API for the streaming video library
 */

import type {
  PlayerConfig,
  SourceConfig,
  Track,
  PlayerState,
  PlayerEventMap,
  MediaInfo,
  VideoTrack,
  AudioTrack,
  AudioSourceEntry,
  SubtitleTrack,
  SubtitleSourceEntry,
  SubtitleCue,
  SubtitleRenderer,
  Packet,
  PlaybackAssessment,
  PlaybackAssessmentOptions,
  PlaybackQuery,
  DecodeAudioOptions,
  DecodedAudioChunk,
} from "../types";
import { EventEmitter } from "../events/EventEmitter";
import {
  HttpSource,
  FileSource,
  ThumbnailHttpSource,
  EncryptedHttpSource,
  analyzeDashFallback,
  analyzeHlsFallback,
  loadHlsVariant,
  buildVttFromSegments,
  SegmentStreamSource,
  getSourceAdapterFactory,
  type SourceAdapter,
  type HlsSubtitleRendition,
} from "../source";
import { LRUCache } from "../cache";
import { Demuxer } from "../demux";
import { TrackManager } from "./TrackManager";
import { Clock } from "./Clock";
import { VIDEO_UNDERFLOW_THRESHOLD_MS } from "./TimeSource";
import { PlayerStateManager } from "./PlayerState";
import {
  loadPersistedLinkBps,
  lowerLinkBps,
  raiseLinkBps,
} from "../utils/LinkRate";
import { Logger, LogLevel } from "../utils/Logger";
import {
  Storyboard,
  type StoryboardSpec,
  type StoryboardTile,
} from "../utils/Storyboard";
import { probeLinkBandwidth } from "../utils/bandwidthProbe";
import { MoviVideoDecoder } from "../decode/VideoDecoder";
import { MoviAudioDecoder } from "../decode/AudioDecoder";
import type { PCMFrame } from "../decode/SoftwareAudioDecoder";
import { CodecParser } from "../decode/CodecParser";
import { SubtitleDecoder } from "../decode/SubtitleDecoder";
import { FontCatalog, styleFontNames } from "../decode/SubtitleFonts";
import {
  CanvasRenderer,
  type VRView,
  type RenderSource,
} from "../render/CanvasRenderer";
import { AudioRenderer } from "../render/AudioRenderer";
import {
  updateAllBindingsLogLevel,
  ThumbnailBindings,
  WasmBindings,
} from "../wasm/bindings";
import { loadWasmModuleNew, resetWasmModule } from "../wasm/FFmpegLoader";
import { ShakaPlayerWrapper } from "../render/ShakaPlayerWrapper";
import { HLSPlayerWrapper } from "../render/HLSPlayerWrapper";
import { DASHPlayerWrapper } from "../render/DASHPlayerWrapper";
import { ThumbnailRenderer } from "../utils/ThumbnailRenderer";
import { getDecodeMode, isSoftwareDecodePath } from "./decodeMode";
import { PacketQueue } from "./PacketQueue";
import { childAbort } from "../utils/abort";

// Any of the three adaptive-streaming engines (Shaka primary; hls.js / dash.js
// as fallbacks). They share the same surface; the Shaka-only extras (isLive,
// thumbnails, …) are called through optional chaining where used.
type StreamWrapper = ShakaPlayerWrapper | HLSPlayerWrapper | DASHPlayerWrapper;

const TAG = "MoviPlayer";

/**
 * Whether a stream engine turned a source down for want of a LICENCE, rather
 * than for any of the other reasons it turns sources down.
 *
 * Both engines say so plainly — Shaka's wrapper produces "This video is
 * protected and can't be played here", dash.js produces "DRM: No license server
 * URL specified!" — and the difference matters: a licence refusal is the one
 * failure where the demuxer tier below already knows it has nothing to gain.
 */
function looksLikeDrmFailure(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e ?? "");
  return /protected|licen[cs]e|key[ _-]?system|\bdrm\b|widevine|playready|fairplay/i.test(
    msg,
  );
}

// Module-level device decode-capability cache — survives player/element
// recreates for the whole page session, so a fresh MoviPlayer (per video, or
// after a recovery) doesn't re-learn the same limit and re-stutter. Keyed by
// rung HEIGHT (device-meaningful and stable across sources, unlike bandwidth).
// A height lands here the FIRST time it goes decode-bound — which, because the
// renderer tries an FPS cap first, means "can't sustain even at half rate": a
// device limit, not a transient. Cleared only on a full page reload.
const deviceDecodeBoundHeights = new Set<string>();
// …and the same lesson, kept across reloads — of this TAB, and no further.
// The in-memory set above is cleared by a reload, so a fresh visit paid the
// same stutter to re-learn a limit it had just found; carrying it in session
// storage saves that without the verdict outliving the run it was made in.
//
// Which matters, because the verdict is made from one machine on one evening:
// a laptop on battery, a GPU busy behind another tab, a browser mid-update.
// None of those is a property of the device, and all of them were being
// written down forever. The ceiling only ever rises — nothing lowers it — so
// a bad evening barred a rung on that device for good, on every video, with
// nothing in the interface to say why 4K was never chosen again. A session is
// the longest any of it can honestly claim to be true for.
// The thumbnail pipeline's WASM module, kept for the whole page session.
//
// It used to be built fresh per video — a second emscripten instance, its own
// multi-megabyte heap, its own compile. On a low-end device that is the most
// expensive thing a video change does, and it lands exactly where it hurts:
// alongside the new video's decode ramp, which is what pushed audio into
// underrun ("gap filled" → duck → the clicking) after a couple of playbacks.
// The module is stateless between videos; only the FFmpeg CONTEXT inside it is
// per-file, and that is still created and destroyed each time.
//
// Handlers (onReadRequest / _pendingSeek) live on the MODULE, so exactly one
// ThumbnailBindings may use it at a time. `inUse` enforces that: a second
// pipeline — which happens only in the overlap of an in-place quality switch —
// gets its own throwaway instance rather than corrupting this one.
let sharedThumbnailModule: Awaited<
  ReturnType<typeof loadWasmModuleNew>
> | null = null;
let sharedThumbnailModuleInUse = false;

// Stand-ins for a bare codec FAMILY, so a host that knows only "av01" per rung
// can still be asked a valid MediaCapabilities question. Profile/level here are
// ordinary high-resolution choices — the answer turns on the codec and the
// width/height passed alongside, not on the exact level digits.
const REPRESENTATIVE_CODECS: Record<string, string> = {
  av01: "av01.0.13M.08",
  av1: "av01.0.13M.08",
  vp9: "vp09.00.51.08",
  vp09: "vp09.00.51.08",
  avc1: "avc1.640033",
  h264: "avc1.640033",
  hvc1: "hvc1.1.6.L153.90",
  hev1: "hev1.1.6.L153.90",
  hevc: "hvc1.1.6.L153.90",
};

// One name per codec, whichever spelling reached us. A ladder writes what its
// extractor happened to emit ("av1", "h264") and a WebCodecs string carries the
// registered fourcc ("av01.0.12M.08", "avc1.640033"); comparing the two raw
// makes the same codec look like two, which is exactly the mistake that makes a
// codec-aware rule silently fall back to the codec-blind one.
const CODEC_FAMILY_ALIASES: Record<string, string> = {
  av1: "av01",
  h264: "avc1",
  avc3: "avc1",
  h265: "hvc1",
  hevc: "hvc1",
  hev1: "hvc1",
  vp9: "vp09",
  vp8: "vp08",
};

function codecFamily(codec?: string): string {
  const raw = (codec || "").split(".")[0].toLowerCase();
  return CODEC_FAMILY_ALIASES[raw] || raw;
}

// What software decode can actually sustain. Once the video is being decoded in
// software, resolution is the only lever left, and Auto must not climb past what
// the CPU can hold — whatever the link can carry.
//
// 480p for every codec, H.264 included. H.264 used to get 720p as "the cheap
// one", and on a phone it isn't: opening at 720p H.264 held, but the moment Auto
// stepped to 1080p the picture stalled and the correction dropped it to 480p
// anyway — a climb, a stall and a drop, every load, to arrive where it should
// have started. Software decode is not the place to find the limit by hitting
// it. Only applies while software is in use; a hardware path keeps the full
// ladder.
function softwareDecodeCeiling(viaWebCodecs: boolean): number {
  // Two very different CPUs are doing the work depending on how we got here.
  //
  // Our WASM decoder is single-threaded and pays an Asyncify tax: 480p, and
  // even 720p H.264 only held until the first upshift stalled it.
  //
  // A WebCodecs decoder that merely lost `prefer-hardware` is the browser's own
  // — multithreaded, SIMD, years of tuning — and it carries 1080p on hardware
  // this modest. Capping it at 480 too took a 1080p AV1 that was playing and
  // dropped it three rungs for no reason anyone could see.
  return viaWebCodecs ? 1080 : 480;
}

/**
 * True when the browser has no WebCodecs at all, so software decode is a
 * certainty rather than a state to be discovered. `isSoftwareDecoding()` only
 * becomes true once the decoder has configured and fallen back — and the ABR
 * can reach a decision before that, which is how an upshift to 1080p slipped
 * past the ceiling on a browser that never had a hardware path.
 */
function webCodecsUnavailable(): boolean {
  return (
    typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder ===
    "undefined"
  );
}

/**
 * A rung this device has been shown not to decode, keyed by CODEC FAMILY AND
 * HEIGHT — not height alone.
 *
 * Height alone was codec-blind, and it barred by association: one video's 2160p
 * AV1 failing on a Safari with no AV1 path wrote down "2160", and from then on
 * every 2160p rung was refused — including the H.264 and VP9 ones that browser
 * decodes perfectly. The quality menu still listed 4K; Auto simply never chose
 * it, on any video, forever.
 *
 * The key is bumped to :v2 so the old height-only entries are dropped rather
 * than misread — a device carrying a poisoned ceiling heals on next load.
 */
const DECODE_CEILING_KEY = "movi:decode-ceiling:v2";

/**
 * The store is session storage: the ceiling belongs to this tab's run of the
 * player and goes when the tab does. See deviceDecodeBoundHeights.
 */
function decodeCeilingStore(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    // Blocked storage (a sandboxed frame, a privacy mode): the in-memory set
    // still holds for the life of the page.
    return null;
  }
}

/**
 * Resolve `p`, or TIMED_OUT once `ms` have passed.
 *
 * The losing promise is NOT cancelled — it cannot be — so every caller must
 * tear its demuxer down straight after, which is exactly what abandonPrep and
 * primeRendition's discard path do. Used only where an await has no bound of
 * its own and the thing being waited on is holding the link.
 */
const TIMED_OUT = Symbol("timed-out");
async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<typeof TIMED_OUT>((r) => {
    t = setTimeout(() => r(TIMED_OUT), Math.max(0, ms));
  });
  try {
    return await Promise.race([p, timer]);
  } finally {
    clearTimeout(t);
  }
}

/** `av01@2160` — what actually failed, not just how tall it was. */
function decodeBoundKey(codec: string, height: number): string {
  const family = (codec || "").split(".")[0].toLowerCase() || "unknown";
  return `${family}@${height}`;
}

/**
 * `av01.0.17m.08@4320` — the exact rung SHAPE, for a bar that gets written
 * down.
 *
 * The family key above collapses everything a codec string carries: profile,
 * level and BIT DEPTH. That is right for the reactive bar, which comes from
 * this device visibly failing to play something and is a statement about the
 * machine right now. It is wrong for a persisted capability verdict, because
 * "8K AV1" is not one thing — a GPU can decode 8-bit and refuse 10-bit, and
 * two videos' 8K rungs are routinely different profiles. Keyed by family, one
 * refusal retired every 8K AV1 rung on that device for good, including the
 * ones it could have played.
 *
 * Empty for a bare family ("av01"), which has no shape to be exact about.
 */
function decodeBoundExactKey(codec: string, height: number): string {
  if (!codec.includes(".")) return "";
  return `${codec.toLowerCase()}@${height}`;
}

function loadPersistedDecodeCeiling(): void {
  try {
    // Whatever earlier versions wrote down for ever: drop it on sight. A
    // ceiling from another day is the thing this stopped keeping.
    localStorage.removeItem(DECODE_CEILING_KEY);
  } catch {
    /* nothing there to clear, or nowhere to clear it from */
  }
  try {
    const raw = decodeCeilingStore()?.getItem(DECODE_CEILING_KEY);
    if (!raw) return;
    for (const k of JSON.parse(raw) as string[]) {
      if (typeof k === "string" && k.includes("@"))
        deviceDecodeBoundHeights.add(k);
    }
  } catch {
    /* private mode / bad JSON — the session just re-learns */
  }
}

/**
 * Heights barred for THIS SESSION only — learned while software-decoding, so
 * they describe the CPU's limit, not the device's. Excluded from what gets
 * written down, and excluded even when a later, unrelated persist runs: the
 * write serialises the whole set, so without this a software-session bar
 * hitched a ride on the next hardware verdict.
 */
const sessionOnlyDecodeBoundHeights = new Set<string>();

function persistDecodeCeiling(): void {
  try {
    decodeCeilingStore()?.setItem(
      DECODE_CEILING_KEY,
      JSON.stringify(
        [...deviceDecodeBoundHeights].filter(
          (k) => !sessionOnlyDecodeBoundHeights.has(k),
        ),
      ),
    );
  } catch {
    /* storage unavailable — the in-memory set still holds for this session */
  }
}

loadPersistedDecodeCeiling();

/**
 * Ask MediaCapabilities whether this device can actually play each heavy rung,
 * and record the ones it cannot in the module-level ceiling. Shared by the
 * player (which knows the codec in play) and the element's opening pick (which
 * runs before any player exists) — see MoviPlayer.screenLadder.
 */
/**
 * What a rung costs to decode in software, in H.264-equivalent pixels per
 * second: `width × height × fps × codec factor`. The factors are rough — a
 * modern codec buys its bitrate with per-pixel work, and AV1/HEVC land around
 * 3× H.264 while VP9 sits near 2×.
 *
 * This replaced a plain `height >= 1440` test, which is a proxy that breaks in
 * both directions the moment a rung isn't 16:9. A 2.39:1 film's "1440p" rung is
 * 2560×1072 — under the height cut, never screened, though it is heavier than
 * ordinary 1080p. A portrait 1080×1920 is over the cut and would be barred,
 * though it is exactly as many pixels as the 1080p that passes. Both fall out
 * correctly once the real frame is measured instead of one of its sides.
 */
function softwareDecodeCost(
  width: number,
  height: number,
  fps: number,
  codec: string,
): number {
  const family = (codec || "").split(".")[0].toLowerCase();
  const factor = /^(av01|av1|hvc1|hev1|hevc|h265)/.test(family)
    ? 3
    : /^(vp0?9|vp9)/.test(family)
      ? 2
      : 1;
  return width * height * Math.max(1, fps) * factor;
}

/**
 * Cost above which a rung with NO hardware path is refused. Calibrated to the
 * old height thresholds at a nominal 30fps — mobile's 2560×1440×30 ≈ 110M,
 * desktop's headroom several times that — then rounded to numbers that hold up
 * against what was actually observed: a phone that could not produce one frame
 * of 1440p AV1 (332M), and the 1080p30 H.264 (62M) it plays without complaint.
 * Two constants, one place to tune.
 */
const SOFTWARE_DECODE_BUDGET_MOBILE = 100_000_000;
// Measured, where the mobile figure above was measured and the old desktop
// one (400M) was only "several times" it: Chrome's software H.264 on an M4
// decoded 124 fps of 3840x2160 (~1.03G px/s) at 2x and kept exact pace with
// the clock — but only just: it held for one pass and then stuttered in
// bursts, holds of up to 384ms. That is the edge, not headroom, so the budget
// sits below it: ~1G per 10 threads at the edge, 600M per 8 is what carries
// without stutter (1.5x of that file, not 2x). A machine that falls short is
// caught by what playback actually did — see the stutter hint.
const SOFTWARE_DECODE_BUDGET_DESKTOP = 600_000_000;

/**
 * The budget above, scaled by the cores this machine actually has.
 *
 * The browser's software decoders are threaded, so what they carry grows with
 * the core count — and a flat number judged every desktop as the same one. On
 * an M4 (10 cores) a 4K60 H.264 4:2:2 file, which has no hardware path, came
 * out 1.24x over the flat budget and raised "may not play smoothly" over
 * playback that then presented 60 of 60 frames every second. The constants are
 * read as an 8-thread machine; the scale is bounded both ways so a misreported
 * count can't turn the screen off or bar everything.
 */
function softwareDecodeBudget(mobile: boolean): number {
  const base = mobile
    ? SOFTWARE_DECODE_BUDGET_MOBILE
    : SOFTWARE_DECODE_BUDGET_DESKTOP;
  const cores =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 0 : 0;
  if (!(cores > 0)) return base;
  return base * Math.min(2, Math.max(0.5, cores / 8));
}

/**
 * The most a HARDWARE decoder is built to carry, in pixels per second: 8K at
 * 60fps. That is the top of AV1 level 6.1 and HEVC level 6.1, which is where
 * the decoders in laptops, phones and consumer GPUs stop — a device advertising
 * "8K AV1" means 8K60, and nothing past it.
 *
 * It exists because nothing else here will say no. Asked about 8K at 120fps,
 * WebCodecs configured a hardware decoder and MediaCapabilities answered
 * smooth and power-efficient — its "smooth" comes from past playback of that
 * configuration, and with no history it is optimistic by default. Only a speed
 * setting reaches this in practice (8K60 at 2x is 8K120), which is exactly the
 * question canPlaySmoothly is asked with a rate for.
 */
const HARDWARE_DECODE_CEILING = 7680 * 4320 * 60;
/**
 * How far past realtime a decoder that already carries a stream is assumed to
 * go. Speed does not scale hardware decoding the way it scales the software
 * budget: a decoder has headroom above realtime — that is what makes fast
 * playback possible at all — and above 1x the player stops asking it for every
 * frame anyway (the adaptive frame cap, and the skip-ahead path). Two is what
 * an 8K60 file demonstrates: it plays at 2x while the old rule, which simply
 * multiplied the pixel rate by the speed, called it beyond hardware at 1.5x.
 */
const HARDWARE_RATE_HEADROOM = 2;

async function screenLadderForDecode(
  rungs: {
    height?: number;
    width?: number;
    fps?: number;
    codec?: string;
    bandwidth?: number;
  }[],
  fps: number,
  activeCodec: string,
  activeHeight: number,
  screened: Set<string>,
  mobile: boolean,
): Promise<void> {
  const caps = (
    navigator as unknown as {
      mediaCapabilities?: {
        decodingInfo?: (c: unknown) => Promise<{
          supported?: boolean;
          smooth?: boolean;
          powerEfficient?: boolean;
        }>;
      };
    }
  ).mediaCapabilities;
  if (!caps?.decodingInfo) return;

  for (const r of rungs) {
    const h = r.height ?? 0;
    if (h <= 0) continue;
    // Skip only a rung ALREADY judged for this codec — a different codec at
    // the same height is a different question.
    if (MoviPlayer.isDecodeBound(r.codec, h)) continue;
    // The rung's real frame. Only fall back to a 16:9 guess when the ladder
    // didn't declare a width — asking decodingInfo about dimensions the
    // content doesn't have gets an answer about a video nobody is playing.
    const w = r.width && r.width > 0 ? r.width : Math.round((h * 16) / 9);
    const rungFps = r.fps && r.fps > 0 ? r.fps : fps;
    // Judge a rung by ITS OWN codec. A ladder is often mixed — H.264 low,
    // AV1 high, which is what YouTube-style extractors produce — so asking
    // about the codec that happens to be PLAYING answers the wrong question.
    // Caught in throttled testing: from a 480p H.264 rung the screen asked
    // "8K H.264?", got "software" (true almost everywhere) and barred 8K on
    // devices whose 8K rung is AV1 and whose GPU handles it.
    //
    // Without a declared codec, fall back to the active one only while we
    // are already in the same size regime (above 4K), where a ladder does
    // not usually change codec. Otherwise leave it to the reactive path.
    const declared = r.codec || (activeHeight > 2160 ? activeCodec : "");
    if (!declared) continue;
    // A full WebCodecs string ("av01.0.13M.10") can be asked about directly.
    // A bare family ("av01"), which is all a host usually knows per rung, is
    // NOT a valid contentType codec — decodingInfo answers `unsupported` to
    // it, which would bar the rung for the wrong reason. Fill in a real
    // string: the playing one when the family matches, else a representative.
    const family = declared.split(".")[0].toLowerCase();
    const activeFamily = activeCodec.split(".")[0].toLowerCase();
    const exact = declared.includes(".");
    const codec = exact
      ? declared
      : family === activeFamily && activeCodec
        ? activeCodec
        : REPRESENTATIVE_CODECS[family] || "";
    if (!codec) continue;
    // Containers the codec strings map to. Getting this wrong makes
    // decodingInfo reject the query outright, which we treat as "no answer".
    const container = /^(vp0?[89]|vp8)/i.test(codec)
      ? "video/webm"
      : "video/mp4";
    // What this rung would cost the CPU, and whether that is more than this
    // class of machine can carry. Only rungs OVER the budget can be barred
    // for lacking a hardware path — under it, software decode is ordinary and
    // barring would cost quality for nothing. A hard `unsupported` still
    // counts at any size; that one isn't a judgement call.
    const cost = softwareDecodeCost(w, h, rungFps, codec);
    const overBudget = cost > softwareDecodeBudget(mobile);
    const key = `${codec}@${w}x${h}@${Math.round(rungFps)}`;
    if (screened.has(key)) continue;
    screened.add(key);
    try {
      const info = await caps.decodingInfo({
        type: "file",
        video: {
          contentType: `${container}; codecs="${codec}"`,
          width: w,
          height: h,
          bitrate: r.bandwidth || 0,
          framerate: rungFps,
        },
      });
      let verdict =
        // "unsupported" is only trusted for a codec string the host actually
        // declared. For one we filled in, it more likely means the guess was
        // wrong than that the device can't play the rung.
        info?.supported === false && exact
          ? "unsupported"
          : // The two soft verdicts are judgements about cost, so they only
            // count for a rung that IS costly. `smooth: false` and
            // `powerEfficient: false` are both routine on cheap rungs — a
            // 480p H.264 that plays anywhere can answer either way — and
            // acting on them there would bar quality for nothing.
            !overBudget
            ? ""
            : info?.smooth === false
              ? "not smooth"
              : info?.powerEfficient === false
                ? "software-decoded"
                : "";

      // …and "unsupported" is decodingInfo's word too, so the decoder gets
      // the last say on it. WebKit's decodingInfo ties AV1 level to frame
      // rate more tightly than its decoder does: it answers supported:false
      // for 2560x1440@60 at av01.0.12M.08 and for 1920x1080@60 at
      // av01.0.08M.08, while VideoDecoder.isConfigSupported answers true for
      // both with prefer-hardware — and YouTube labels its 1440p60 rung
      // exactly 12M. That false "unsupported" is a fact that gets written
      // down, so every 1440p AV1 rung on Safari was barred the moment the
      // ladder was screened.
      if (verdict === "unsupported" && typeof VideoDecoder !== "undefined") {
        try {
          const any = await VideoDecoder.isConfigSupported({
            codec,
            codedWidth: w,
            codedHeight: h,
          });
          if (any?.supported) {
            Logger.debug(
              TAG,
              `decodingInfo calls ${w}x${h}@${Math.round(rungFps)} ${codec} unsupported, VideoDecoder does not — not barring it`,
            );
            verdict = "";
          }
        } catch {
          /* the query itself is unsupported here — decodingInfo's answer stands */
        }
      }

      // Ask the API that actually DECIDES. decodingInfo is an advisory
      // second opinion, and Safari disagrees with itself: it answered
      // "supported" for 3840x2026 AV1 that VideoDecoder.isConfigSupported
      // then refused outright. The rung opened, fell to the WASM decoder at
      // 4K — hopeless — and the reactive correction dropped it to 450p, when
      // the ladder had a 1080p H.264 rung with a hardware path all along.
      //
      // Only for a rung already OVER budget: below it, "no hardware path"
      // is not a problem, software carries those every day.
      if (
        !verdict &&
        overBudget &&
        exact &&
        typeof VideoDecoder !== "undefined"
      ) {
        try {
          const hw = await VideoDecoder.isConfigSupported({
            codec,
            codedWidth: w,
            codedHeight: h,
            hardwareAcceleration: "prefer-hardware",
          });
          if (hw?.supported === false) verdict = "no hardware path";
        } catch {
          /* the query itself is unsupported here — decodingInfo's answer stands */
        }
      }
      if (verdict) {
        // A verdict that gets WRITTEN DOWN is keyed by the exact rung shape,
        // so it retires that rung and not the whole family at that height —
        // see decodeBoundExactKey. A session-scoped one keeps the broad key:
        // it expires with the tab anyway, and while it lasts "this machine is
        // not comfortable at this size" is the useful reading of it.
        const isFact =
          verdict === "unsupported" || verdict === "no hardware path";
        const key =
          (isFact && decodeBoundExactKey(codec, h)) || decodeBoundKey(codec, h);
        deviceDecodeBoundHeights.add(key);
        // Facts are written down; judgements are not.
        //
        // "unsupported" and "no hardware path" come from
        // VideoDecoder.isConfigSupported — the API that decides, answering
        // about this codec on this machine. Those hold, so they persist.
        //
        // "not smooth" and "software-decoded" are decodingInfo's OPINION,
        // and it is a conservative one: it called 8K AV1 unsmooth on a
        // machine whose 4K AV1 runs on hardware without complaint. Persisted,
        // one cautious answer retired that rung for good — the rung would
        // never be tried again to find out whether the opinion was right.
        // Session-scoped, the next load gets to ask again, and if it really
        // can't hold it the reactive path pulls it down in a few seconds.
        if (isFact) {
          persistDecodeCeiling();
        } else {
          sessionOnlyDecodeBoundHeights.add(key);
        }
        Logger.info(
          TAG,
          `ABR: this device reports ${w}x${h}@${Math.round(rungFps)} ${codec} as ${verdict} (${Math.round(cost / 1e6)}M) — barring it ${isFact ? "for good" : "for this session"}`,
        );
      }
    } catch {
      /* query rejected (bad contentType, unimplemented) — leave it to the
           reactive path, which is what used to carry this alone. */
    }
  }
}

export class MoviPlayer extends EventEmitter<PlayerEventMap> {
  // One-shot UA classification: mobile devices get the same conservative
  // decode/render budgets as 4K+ desktop, since mobile GPUs and Chrome's
  // AV1 hardware whitelist make the heavy path unaffordable at any res.
  // Memoized at class level so we don't re-parse navigator.userAgent in
  // every demux loop tick.
  private static readonly _isMobileDevice: boolean = (() => {
    if (typeof navigator === "undefined") return false;
    const uaData = (navigator as any)?.userAgentData;
    if (uaData?.mobile === true) return true;
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPod|Mobile|Opera Mini|IEMobile|BlackBerry/i.test(ua))
      return true;
    // iPadOS 13+ reports as Mac — disambiguate via touch points
    if (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)
      return true;
    return false;
  })();

  private config: PlayerConfig;
  private source: SourceAdapter | null = null;
  private cache: LRUCache;
  private demuxer: Demuxer | null = null;

  private _audioTracks: AudioSourceEntry[] = [];
  private _activeAudioLang: string = "";
  // Quality-independent HLS subtitle blobs, cached by stream URL so a quality
  // switch (which rebuilds the player) reuses them instead of re-fetching every
  // WebVTT segment — the dominant switch-latency cost.
  private static _hlsSubtitleCache = new Map<string, SubtitleSourceEntry[]>();

  // Split (separate-URL) audio, WASM-decoded. A separate audio track (e.g. a
  // YouTube itag-140 fMP4 that Safari's native <audio> can't play) is demuxed by
  // its OWN isolated-WASM Demuxer and decoded through the shared audioDecoder →
  // audioRenderer, exactly like muxed in-file audio. The AudioRenderer is already
  // the clock master, so A/V sync, volume, mute and playbackRate come for free.
  private audioDemuxer: Demuxer | null = null;
  private audioSource: SourceAdapter | null = null;
  private audioAnimationFrameId: number | null = null;
  private audioDemuxInFlight: boolean = false;
  private _splitAudioTrackId: number = -1;
  /** How long a split-audio track may fail every read before the player says
   *  so. Long enough to step over a bad patch, short enough that nobody sits
   *  through a silent film wondering. */
  private static readonly SPLIT_AUDIO_GIVE_UP_MS = 4000;

  private _splitAudioEof: boolean = false;
  // A split-audio track that has stopped answering. See pumpSplitAudio.
  private _splitAudioDead: boolean = false;
  private _splitAudioErrorSince: number = 0;
  // Bounded automatic recovery from a decoder that started rejecting every
  // packet (see recoverBrokenAudio). Counted per source, so a genuinely
  // undecodable stream ends in silence instead of a seek loop.
  /** Resolves once the video demuxer has produced mediaInfo — the only thing
   *  the parallel split-audio open has to wait for. */
  private _videoInfoReady: Promise<void> | null = null;
  private _resolveVideoInfoReady: (() => void) | null = null;
  private _audioRecoveryInFlight = false;
  private _audioRecoveries = 0;
  private static readonly MAX_AUDIO_RECOVERIES = 3;
  // How long the unmute re-read waits for AudioContext.resume() to settle.
  // A gesture-driven resume lands in a few ms; this only bounds the pathological
  // case where it never resolves, so the corrective seek still happens.
  private static readonly UNMUTE_RESUME_WAIT_MS = 400;
  // A separate audio source can be timed on its own PTS baseline (e.g. an HLS
  // audio rendition starting at PTS 0 while the video TS starts at ~10s).
  // `_splitAudioStartTime` is that source's own start; `_splitAudioPtsDelta`
  // (videoStart − audioStart) is added to each audio packet's PTS so it lands
  // on the video's timeline. Both are 0 when the two share a baseline (DASH).
  private _splitAudioStartTime: number = 0;
  // Media time below which split-audio packets are dropped after a seek
  // completes, so the audio demuxer's own (earlier) landing point can't drag
  // the clock back behind the first video frame. -1 = no filter armed.
  private _splitAudioSkipBefore: number = -1;
  private _splitAudioPtsDelta: number = 0;
  // True while an audio-track switch tears the audio demuxer down and re-stands
  // it up. hasAudibleSource() honors it so the volume control doesn't blink out
  // during the swap (audioDemuxer is briefly null).
  private _audioSwitchInProgress: boolean = false;
  // Set once destroy() runs. load() awaits (WASM loads, the split-audio second
  // demuxer) can outlive a rapid source switch that destroys this instance; the
  // continuation must bail instead of configuring/rendering onto the now-shared
  // canvas of the successor player (which showed as a black frame).
  private _destroyed: boolean = false;
  /**
   * Aborted by destroy(), and the signal every request this player makes is
   * expected to carry.
   *
   * The sources already cancelled their own work; nothing else did, because
   * nothing else had a handle to cancel WITH. A probe built its AbortController
   * as a local and only ever aborted it on its own timer; the subtitle loaders
   * passed no signal at all. So a player torn down mid-startup kept pulling
   * megabytes for a video that was already gone — off the link the replacement
   * player was trying to start on.
   */
  private _lifetimeAbort = new AbortController();

  /** The signal for anything fetched on this player's behalf. */
  get lifetimeSignal(): AbortSignal {
    return this._lifetimeAbort.signal;
  }
  // PTS (media time) of the last split-audio packet handed to the decoder. The
  // audio loop bounds its lead against the CLOCK using this — not the
  // AudioRenderer buffer, which mis-reports while the AudioContext is suspended
  // (Safari muted-autoplay), which otherwise let audio race far ahead of the
  // wall-clock-rolling video and land seconds/minutes out of sync on unmute.
  private _lastSplitAudioPts: number = 0;

  // External subtitle tracks (VTT/SRT)
  private _subtitleTracks: SubtitleSourceEntry[] = [];
  // DASH-fallback video Representations (best-first) + the one currently playing,
  // for the demuxer-mode quality menu. Populated only in the force-demux path.
  /**
   * The demuxer-path source came from a manifest that declares encryption. It
   * plays for as long as the packager's clear lead lasts, then stops for good;
   * this is what turns that stop into "needs a licence" rather than a decoder
   * fault. Set when the fallback plan is taken, cleared on every load.
   */
  private _sourceIsEncrypted: boolean = false;

  /**
   * Halt further reading without tearing the source down — the buffered part is
   * still good to seek around in, and only what comes next is unusable.
   */
  private stopSourceStreaming(): void {
    try {
      (
        this.source as unknown as { haltStreaming?: () => void }
      )?.haltStreaming?.();
    } catch {
      /* best-effort */
    }
  }

  /** Reported once; either decoder may be the one that hits the wall first. */
  private _encryptedGaveUp: boolean = false;
  /** Audio already given up on for this source — say it once, not per packet. */
  private _encryptedAudioSilenced: boolean = false;

  /**
   * The clear lead of an encrypted source has run out. Whichever decoder
   * noticed, the answer is the same and there is no recovery to attempt.
   *
   * Stopping matters as much as reporting. Left running, the pipeline keeps
   * asking for frames it can never get, and the machinery built to rescue a
   * struggling stream turns on itself: audio empties, video is bound to it, the
   * stall detector fires, the element nudges a seek, and that repeats for as
   * long as anyone watches. Pausing ends that; halting the source stops pulling
   * bytes that cannot be used; the error names the cause.
   */
  private encryptedSourceGaveUp(): void {
    if (this._encryptedGaveUp) return;
    this._encryptedGaveUp = true;
    Logger.warn(
      TAG,
      "Encrypted source: the clear lead has ended — no licence, so playback stops here",
    );
    this.stopSourceStreaming();
    try {
      this.pause();
    } catch {
      /* already stopped */
    }
    this.stateManager.setState("error");
    this.emit(
      "error",
      new Error("This video is protected and needs a licence to play here."),
    );
  }

  private _dashRenditions: {
    url: string;
    label: string;
    id: string;
    bandwidth?: number;
    height?: number;
    /** This rung's own codec, when the host declared one — see the capability
     *  screen, which cannot judge a rung by the codec currently playing. */
    codec?: string;
  }[] = [];
  private _activeDashRendition: string = "";
  // Stamps each rendition-switch indicator, so an end that arrives after the
  // next switch has started can't clear the newer one's indicator.
  private _switchIndicatorGen = 0;
  // codec@height already put to MediaCapabilities — see
  // screenRungsForDecodeCapability. Instance-level: the answers it produces go
  // into the module-level ceiling, so re-asking costs nothing but time.
  private _decodeScreened = new Set<string>();
  // True while THIS player holds the shared thumbnail WASM module.
  private _usingSharedThumbModule = false;

  /**
   * Resolutions this device has been shown not to sustain — learned from a
   * decode-bound stall or from MediaCapabilities, and kept for this tab's
   * session (see deviceDecodeBoundHeights).
   * Public because the pick happens BEFORE any player exists: the element's
   * pre-play speed test chooses the opening rung off a bandwidth measurement
   * alone, so without this a machine that cannot decode 8K still opened on it
   * and stepped down a moment later, in full view.
   */
  static decodeBoundHeights(): string[] {
    return [...deviceDecodeBoundHeights];
  }

  /** Has THIS codec at THIS height been shown not to decode here? */
  static isDecodeBound(codec: string | undefined, height: number): boolean {
    if (!(height > 0)) return false;
    const exact = decodeBoundExactKey(codec || "", height);
    if (exact && deviceDecodeBoundHeights.has(exact)) return true;
    return deviceDecodeBoundHeights.has(decodeBoundKey(codec || "", height));
  }

  /**
   * Will this play smoothly HERE — on this device, in this browser, at this
   * speed — before committing to playing it?
   *
   * Answered with the same judgement the player itself acts on when it picks a
   * rendition (screenLadderForDecode), not a second opinion that could
   * disagree with it:
   *
   *  1. Is there a HARDWARE decoder for this exact configuration? Asked of
   *     WebCodecs with `prefer-hardware`, because that is the API that decides
   *     — MediaCapabilities is advisory, and Safari has been caught answering
   *     "supported" for 4K AV1 that isConfigSupported then refused.
   *  2. Failing that, is there a browser SOFTWARE decoder? Failing that, the
   *     player's own FFmpeg (WASM) takes it — which is why `playable` is true
   *     for nearly anything with a video track.
   *  3. Without hardware, it comes down to cost: width × height × fps × the
   *     codec's work factor × playback rate, against the budget for this class
   *     of device — the same two constants the player's ABR uses, calibrated on
   *     a phone that could not produce a frame of 1440p AV1 and the 1080p H.264
   *     it plays without complaint.
   *  4. MediaCapabilities gets a veto over "smooth": when the browser says a
   *     configuration will not be smooth, that is believed.
   *
   * Audio is reported but never decides it. Every audio track goes through the
   * software decoder already, and audio decode is a rounding error next to
   * video's.
   *
   * @param input A URL or File to open and read (an isolated WASM instance, so
   *   a player already playing is not disturbed), the tracks of something
   *   already open, or a {@link PlaybackQuery} when there is nothing to open.
   */
  static async assessPlayback(
    input: string | File | Blob | Track[] | PlaybackQuery,
    options: PlaybackAssessmentOptions = {},
  ): Promise<PlaybackAssessment> {
    const rate =
      typeof options.rate === "number" && options.rate > 0 ? options.rate : 1;
    const reasons: string[] = [];

    // ── What are we looking at ────────────────────────────────────────────
    let tracks: Track[];
    let fromQuery: PlaybackQuery | null = null;
    if (Array.isArray(input)) {
      tracks = input;
    } else if (typeof input === "string" || input instanceof Blob) {
      try {
        tracks = await MoviPlayer.probeTracks(input);
      } catch (e) {
        // A source that cannot be opened is a verdict, not an exception: the
        // caller asked "will this play", and "it could not be read" answers it.
        // Adaptive manifests land here too — open one with the player instead,
        // and ask the element once it has loaded.
        return {
          playable: false,
          smooth: false,
          powerEfficient: false,
          rate,
          video: null,
          audio: null,
          reasons: [
            `The source could not be read: ${e instanceof Error ? e.message : String(e)}`,
          ],
        };
      }
    } else {
      fromQuery = input;
      tracks = [
        {
          id: 0,
          type: "video",
          codec: input.codec,
          width: input.width,
          height: input.height,
          frameRate: input.fps && input.fps > 0 ? input.fps : 30,
          bitRate: input.bitrate,
        } as VideoTrack,
      ];
    }

    const video = tracks.find(
      (t): t is VideoTrack =>
        t.type === "video" && !(t as VideoTrack).isAttachedPic,
    );
    const audioTrack = tracks.find((t): t is AudioTrack => t.type === "audio");

    const audio: PlaybackAssessment["audio"] = audioTrack
      ? {
          codec: audioTrack.codec,
          channels: audioTrack.channels,
          sampleRate: audioTrack.sampleRate,
          decoder: MoviAudioDecoder.needsSoftwareDecoding(audioTrack.codec)
            ? "wasm"
            : "webcodecs",
        }
      : null;

    if (!video) {
      // Sound only: nothing here is expensive enough to stutter.
      return {
        playable: !!audioTrack,
        smooth: !!audioTrack,
        powerEfficient: !!audioTrack,
        rate,
        video: null,
        audio,
        reasons: audioTrack ? [] : ["No video or audio track was found."],
      };
    }

    // ── The codec string to ask with ──────────────────────────────────────
    // A full WebCodecs string when the stream's own extradata can build one;
    // otherwise the representative profile for its family, the same fill-in
    // the ladder screen uses. A query that already names a full string is
    // taken at its word.
    const family = (video.codec || "").split(".")[0].toLowerCase();
    const parsedCodec =
      (fromQuery && fromQuery.codec.includes(".") ? fromQuery.codec : null) ||
      (!fromQuery ? MoviPlayer.codecStringFor(video) : null) ||
      REPRESENTATIVE_CODECS[family] ||
      "";
    let codec = parsedCodec;

    const width = video.width || 0;
    const height = video.height || 0;
    const fps = video.frameRate && video.frameRate > 0 ? video.frameRate : 30;
    const budget = softwareDecodeBudget(MoviPlayer._isMobileDevice);
    const load =
      softwareDecodeCost(width, height, fps * rate, codec || family) / budget;

    // ── Which decoder would carry it ──────────────────────────────────────
    //
    // Asked the way the decoder will actually be configured, or the answer is
    // about a decoder nobody builds. Two things the playback path does and this
    // did not, both on every MPEG-TS file:
    //  - Its extradata is Annex B (start codes, not an avcC/hvcC record). The
    //    decoder drops it and reads the inline parameter sets; handed over as
    //    `description` it makes the browser refuse the config outright.
    //  - The parser reads that Annex B as if it were a record and builds a
    //    string like "avc1.000001". The decoder falls back to a mapped string
    //    when its first one is refused, so this falls back too.
    // Without both, a 4K HEVC .ts that plays in hardware was judged WASM-only,
    // 3.7× over the software budget, and warned about as not smooth.
    const extradata = video.extradata;
    const annexB =
      !!extradata &&
      extradata.length > 4 &&
      extradata[0] === 0 &&
      extradata[1] === 0 &&
      (extradata[2] === 1 || (extradata[2] === 0 && extradata[3] === 1));
    const ask = async (
      codecString: string,
      hardwareAcceleration?: "prefer-hardware",
    ): Promise<boolean> => {
      if (!codecString || typeof VideoDecoder === "undefined") return false;
      try {
        const config: VideoDecoderConfig = {
          codec: codecString,
          codedWidth: width,
          codedHeight: height,
        };
        if (hardwareAcceleration)
          config.hardwareAcceleration = hardwareAcceleration;
        if (extradata && extradata.length > 0 && !annexB) {
          config.description = extradata;
        }
        const r = await VideoDecoder.isConfigSupported(config);
        return r?.supported === true;
      } catch {
        return false;
      }
    };
    const candidates = [
      parsedCodec,
      REPRESENTATIVE_CODECS[family] || "",
    ].filter((c, i, all) => !!c && all.indexOf(c) === i);
    let hardware = false;
    let software = false;
    for (const candidate of candidates) {
      hardware = await ask(candidate, "prefer-hardware");
      software = hardware ? true : await ask(candidate);
      if (software) {
        codec = candidate;
        break;
      }
    }
    const decoder: "hardware" | "software" | "wasm" = hardware
      ? "hardware"
      : software
        ? "software"
        : "wasm";

    // ── The browser's own estimate ────────────────────────────────────────
    let browserSmooth: boolean | undefined;
    let browserEfficient: boolean | undefined;
    const caps = (
      navigator as unknown as {
        mediaCapabilities?: {
          decodingInfo?: (c: unknown) => Promise<{
            supported?: boolean;
            smooth?: boolean;
            powerEfficient?: boolean;
          }>;
        };
      }
    ).mediaCapabilities;
    if (codec && caps?.decodingInfo && width > 0 && height > 0) {
      try {
        const container = /^(vp0?[89]|vp8)/i.test(codec)
          ? "video/webm"
          : "video/mp4";
        const info = await caps.decodingInfo({
          type: "file",
          video: {
            contentType: `${container}; codecs="${codec}"`,
            width,
            height,
            bitrate: video.bitRate || 0,
            framerate: fps * rate,
          },
        });
        // Only an answer about a configuration the browser recognised counts.
        if (info?.supported) {
          browserSmooth = info.smooth;
          browserEfficient = info.powerEfficient;
        }
      } catch {
        /* the query itself was rejected — no opinion */
      }
    }

    // ── Verdict ───────────────────────────────────────────────────────────
    const dims = `${width}×${height} @ ${Math.round(fps)}fps${rate !== 1 ? ` × ${rate}x` : ""}`;
    let smooth: boolean;
    if (decoder === "hardware") {
      // Hardware is not bound by the software budget — but it is bound by what
      // hardware decoders are built for, and the browser saying otherwise.
      //
      // Two questions, not one: can a decoder of this class carry the STREAM,
      // and can it carry it at this SPEED. The second gets the headroom above
      // realtime that hardware has — see HARDWARE_RATE_HEADROOM — because the
      // old rule folded the speed into the pixel rate and so declared an 8K60
      // file beyond hardware the moment the viewer pressed 1.5x, while it went
      // on playing. If the headroom turns out not to be there, the stutter
      // hint says so from what actually happened.
      const pixelRate = width * height * fps;
      const beyondStream = pixelRate > HARDWARE_DECODE_CEILING;
      const beyondSpeed =
        pixelRate * rate > HARDWARE_DECODE_CEILING * HARDWARE_RATE_HEADROOM;
      const beyondHardware = beyondStream || beyondSpeed;
      smooth = !beyondHardware && browserSmooth !== false;
      if (beyondStream) {
        reasons.push(
          `${dims} is beyond what hardware video decoders are built for (8K at 60fps).`,
        );
      } else if (beyondSpeed) {
        reasons.push(
          `${dims} is more than a hardware decoder for ${width}×${height} @ ${Math.round(fps)}fps can be expected to keep up with.`,
        );
      }
    } else {
      const overBudget = load > 1;
      smooth = !overBudget && browserSmooth !== false;
      reasons.push(
        decoder === "software"
          ? `No hardware decoder for ${codec || family} at ${width}×${height} — the browser decodes it in software.`
          : `The browser cannot decode ${codec || family} — the player's built-in decoder (WASM) takes it.`,
      );
      if (overBudget) {
        reasons.push(
          `Software decoding ${dims} needs about ${load.toFixed(1)}× what this ${MoviPlayer._isMobileDevice ? "mobile" : "desktop"} device can sustain.`,
        );
      }
    }
    if (browserSmooth === false) {
      reasons.push(`The browser reports ${dims} as not smooth on this device.`);
    }
    const powerEfficient = decoder === "hardware" && browserEfficient !== false;

    return {
      playable: true,
      smooth,
      powerEfficient,
      rate,
      video: {
        codec: codec || video.codec,
        width,
        height,
        fps,
        decoder,
        smooth,
        powerEfficient,
        load: Math.round(load * 100) / 100,
      },
      audio,
      // "Smooth" with a note about software decode is still smooth — the note
      // is information, not a problem, so a smooth verdict carries no reasons.
      reasons: smooth ? [] : reasons,
    };
  }

  /**
   * The audio track of a URL or File, decoded to mono PCM and handed back in
   * chunks — without playing it, and alongside anything that IS playing.
   *
   *   for await (const chunk of MoviPlayer.decodeAudio(file, { from: 60 })) {
   *     // chunk.samples: Float32Array @ 16 kHz, chunk.start / chunk.end in seconds
   *   }
   *
   * Built for work that needs the sound ahead of the playhead — speech
   * recognition for captions is the case it was written for. It decodes with
   * this player's own demuxer and audio decoder, so anything the player can
   * play it can read: MKV, Opus, TrueHD, DTS — not just what the browser's
   * decodeAudioData happens to understand, and never the whole file into
   * memory at once.
   *
   * Runs on its own WASM instance, like assessPlayback, so a player that is
   * playing is not disturbed, and yields to the event loop as it goes. Resampled
   * with an OfflineAudioContext, which band-limits properly — a speech model
   * fed aliased audio hears noise that is not in the file.
   *
   * Uses the first audio track. Stops, and releases everything, when the
   * signal aborts or the loop is broken out of.
   */
  static async *decodeAudio(
    input: string | File | Blob,
    options: DecodeAudioOptions = {},
  ): AsyncGenerator<DecodedAudioChunk> {
    const outRate =
      options.sampleRate && options.sampleRate > 0 ? options.sampleRate : 16000;
    const chunkSeconds =
      options.chunkSeconds && options.chunkSeconds > 0
        ? options.chunkSeconds
        : 30;
    const from = Math.max(0, options.from ?? 0);
    const signal = options.signal;

    const source: SourceAdapter =
      typeof input === "string"
        ? new HttpSource(input)
        : new FileSource(
            input instanceof File ? input : new File([input], "media"),
          );
    const demuxer = new Demuxer(source, undefined, true);
    const decoder = new MoviAudioDecoder();

    // Decoded blocks, already mixed to mono, waiting to be gathered.
    const pending: { time: number; samples: Float32Array; rate: number }[] = [];
    const toMono = (planes: Float32Array[], frames: number): Float32Array => {
      if (planes.length === 1) return planes[0].slice(0, frames);
      const out = new Float32Array(frames);
      for (const plane of planes) {
        for (let i = 0; i < frames; i++) out[i] += plane[i];
      }
      const k = 1 / planes.length;
      for (let i = 0; i < frames; i++) out[i] *= k;
      return out;
    };

    try {
      const info = await demuxer.open();
      const track = info.tracks.find(
        (t): t is AudioTrack => t.type === "audio",
      );
      if (!track) return;

      const bindings = demuxer.getBindings();
      if (bindings) decoder.setBindings(bindings);
      // Stereo out of the software decoder, whatever the source layout; the mix
      // to one channel happens here, where it is a plain average.
      decoder.setDownmix(true);
      decoder.setOnPCM((frame) => {
        pending.push({
          time: frame.timestamp / 1e6,
          samples: toMono(frame.planes, frame.numberOfFrames),
          rate: frame.sampleRate,
        });
      });
      decoder.setOnData((data) => {
        try {
          const planes: Float32Array[] = [];
          for (let c = 0; c < data.numberOfChannels; c++) {
            const plane = new Float32Array(data.numberOfFrames);
            data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
            planes.push(plane);
          }
          pending.push({
            time: data.timestamp / 1e6,
            samples: toMono(planes, data.numberOfFrames),
            rate: data.sampleRate,
          });
        } finally {
          data.close();
        }
      });
      const configured = await decoder.configure(
        track,
        demuxer.getExtradata(track.id) ?? undefined,
      );
      if (!configured) {
        throw new Error(`Cannot decode the ${track.codec} audio track`);
      }
      if (from > 0) await demuxer.seek(from);

      // Gathered mono samples at the source rate, not yet handed back.
      let parts: Float32Array[] = [];
      let length = 0;
      let startTime = -1;
      let rate = track.sampleRate || 48000;

      const resample = async (mono: Float32Array): Promise<Float32Array> => {
        if (rate === outRate) return mono;
        if (typeof OfflineAudioContext === "undefined") {
          // No audio graph (a worker): nearest-lower sample. Crude, but only
          // reached where the good path cannot run at all.
          const n = Math.floor((mono.length * outRate) / rate);
          const out = new Float32Array(n);
          const step = rate / outRate;
          for (let i = 0; i < n; i++) out[i] = mono[Math.floor(i * step)];
          return out;
        }
        const n = Math.max(1, Math.round((mono.length * outRate) / rate));
        const ctx = new OfflineAudioContext(1, n, outRate);
        const buffer = ctx.createBuffer(1, mono.length, rate);
        buffer.copyToChannel(mono as Float32Array<ArrayBuffer>, 0);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        node.start();
        const rendered = await ctx.startRendering();
        return rendered.getChannelData(0).slice();
      };

      const takeChunk = async (
        samplesWanted: number,
      ): Promise<DecodedAudioChunk> => {
        const joined = new Float32Array(length);
        let o = 0;
        for (const p of parts) {
          joined.set(p, o);
          o += p.length;
        }
        const head = joined.subarray(0, samplesWanted);
        const rest = joined.slice(samplesWanted);
        const chunkStart = startTime;
        parts = rest.length ? [rest] : [];
        length = rest.length;
        startTime = chunkStart + samplesWanted / rate;
        return {
          start: chunkStart,
          end: chunkStart + samplesWanted / rate,
          sampleRate: outRate,
          samples: await resample(head.slice()),
        };
      };

      const gather = () => {
        while (pending.length) {
          const block = pending.shift()!;
          // Pre-roll decoded ahead of a seek target is not part of the answer.
          let samples = block.samples;
          let time = block.time;
          if (time < from) {
            const skip = Math.floor((from - time) * block.rate);
            if (skip >= samples.length) continue;
            samples = samples.subarray(skip);
            time = from;
          }
          if (startTime < 0) startTime = time;
          rate = block.rate;
          parts.push(samples);
          length += samples.length;
        }
      };

      let packets = 0;
      for (;;) {
        if (signal?.aborted) return;
        const packet = await demuxer.readPacket();
        if (!packet) break;
        if (packet.streamIndex !== track.id) continue;
        decoder.decode(packet.data, packet.timestamp, packet.keyframe);
        gather();
        const chunkSamples = Math.round(chunkSeconds * rate);
        while (length >= chunkSamples && startTime >= 0) {
          yield await takeChunk(chunkSamples);
          if (signal?.aborted) return;
        }
        // Keep the page responsive: this can be minutes of audio.
        if (++packets % 48 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      await decoder.flush().catch(() => {});
      gather();
      if (length > 0 && startTime >= 0 && !signal?.aborted) {
        yield await takeChunk(length);
      }
    } finally {
      try {
        decoder.close();
      } catch {
        /* already gone */
      }
      try {
        demuxer.close();
      } catch {
        /* already gone */
      }
      try {
        source.close();
      } catch {
        /* already gone */
      }
    }
  }

  /** The stream's own codec string, or null — never a throw on odd extradata. */
  private static codecStringFor(video: VideoTrack): string | null {
    try {
      return CodecParser.getCodecString(
        video.codec,
        video.extradata,
        video.width,
        video.height,
      );
    } catch {
      return null;
    }
  }

  /** Open a URL or File just long enough to read its tracks. */
  private static async probeTracks(input: string | Blob): Promise<Track[]> {
    const source: SourceAdapter =
      typeof input === "string"
        ? new HttpSource(input)
        : new FileSource(
            input instanceof File ? input : new File([input], "media"),
          );
    // An isolated WASM instance: the shared one belongs to whatever is playing.
    const demuxer = new Demuxer(source, undefined, true);
    try {
      const info = await demuxer.open();
      return info.tracks;
    } finally {
      try {
        demuxer.close();
      } catch {
        /* already gone */
      }
      try {
        source.close();
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Ask the device about a ladder before there is a player to ask through.
   *
   * The opening rung is picked in the element, off a bandwidth probe, before
   * any of this class exists — so on a fresh device the FIRST rung it lands on
   * has never been screened, and a machine that cannot decode it finds out by
   * playing it badly. That one visible attempt is the whole complaint; every
   * load after it is covered by the persisted ceiling.
   *
   * Callable statically because the ceiling it fills is module-level too.
   * Rungs need their own codec (a `codec` on <MoviSource> → `data-codec`);
   * without one there is nothing to ask, and the reactive path still covers it.
   */
  static async screenLadder(
    rungs: { height?: number; codec?: string; bandwidth?: number }[],
    fps = 30,
  ): Promise<void> {
    await screenLadderForDecode(
      rungs,
      fps,
      "",
      0,
      new Set<string>(),
      MoviPlayer._isMobileDevice,
    );
  }
  // Adaptive-quality (ABR) state for the demuxer/premuxed in-place switch.
  private _autoQuality: boolean = false;
  private _abrTimer: ReturnType<typeof setInterval> | null = null;
  private _abrSwitchInProgress: boolean = false;
  // Guards the active pre-upshift speed test (probeRungThroughput) so ticks
  // don't stack probes while one is in flight.
  private _abrProbeInFlight: boolean = false;
  // One startup speed test per player (see runStartupSpeedTest).
  private _startupSpeedTestRan: boolean = false;
  // Bounded retries for a split-audio open that stalled on a contended link.
  private _splitAudioRetries: number = 0;
  private static readonly MAX_SPLIT_AUDIO_RETRIES = 3;
  // Last non-zero throughput estimate (bytes/s), carried across source swaps and
  // stale reads. A fully-downloaded single file (premuxed) reports 0 once idle,
  // so without this the ABR would lose its estimate and freeze at the start rung.
  private _lastThroughputBps: number = 0;
  // Anti-thrash state for the ABR. Each in-place switch resets the video
  // pipeline (new file download, brief keyframe wait) which perturbs both the
  // throughput estimate and the buffer, so without hysteresis the controller
  // oscillates between rungs every tick. _lastAbrSwitchAt gates how soon the
  // next switch may fire; the up-candidate counter requires an upshift target
  // to persist across ticks before committing (a lone throughput spike — e.g. a
  // cache-served burst — shouldn't upshift).
  private _lastAbrSwitchAt: number = Number.NEGATIVE_INFINITY;
  // When playback first started for the current source. The buffer is
  // legitimately near-empty while that FIRST fill is still in flight, and no
  // switch has happened yet (`sinceSwitch` is Infinity), so the post-switch
  // settle can't protect it — without this the absolute-low check reads the
  // normal startup dip as "this rung can't be sustained" and drops 4K to 1080p
  // in the first seconds on a link that carries it fine.
  private _playbackStartedAt: number = Number.NEGATIVE_INFINITY;
  private _abrUpCandidate: string = "";
  private _abrUpConfirms: number = 0;
  // False until the ABR has made its first switch after Auto was enabled. The
  // first upshift commits without the usual 2-tick confirmation so a fresh (or
  // host-defaulted-low) start jumps straight to the network-appropriate rung
  // instead of sitting at a low quality for two ticks.
  private _abrPrimed: boolean = false;
  // Previous tick's buffered-ahead seconds, to detect a draining buffer (the
  // ground-truth "network can't sustain the current rung" signal). Reset on a
  // switch since the buffer restarts from the resume point.
  private _lastBufferAhead: number = 0;
  // Asymmetric hysteresis: when a buffer-trend downshift leaves a rung because it
  // couldn't be sustained, that rung's bandwidth is "penalized" for a hold
  // window. The upshift path won't climb back to it (or higher) until the window
  // expires — otherwise a bursty link that momentarily reads fast re-upshifts
  // into the very rung that just drained, and the two ping-pong (the 240⇄360 /
  // 4K⇄1440 flapping). 0 = no active penalty.
  private _abrPenalizedBandwidth: number = 0;
  private _abrPenaltyUntil: number = 0;
  private static readonly ABR_PENALTY_MS = 30000;
  // Decode-bound is a DEVICE limit, not a transient network dip — back off much
  // harder than a throughput drain so ABR doesn't re-climb into a rung the GPU
  // can't decode and re-stutter every ~40s. Base, doubled per repeat.
  private static readonly ABR_DECODE_PENALTY_MS = 120000; // 2 min
  private static readonly ABR_PENALTY_MAX_MS = 300000; // escalation ceiling (5 min)
  private static readonly ABR_STRIKE_DECAY_MS = 180000; // forget strikes after 3 min clean
  // How deep the buffer must be — and steady — before Auto will climb a rung.
  // The switch throws the current cushion away (new file, new buffer), so this
  // is not a safety margin for the swap: it is the evidence that the link
  // carries the CURRENT rung with room to spare. Set just above the 6s/4s marks
  // the downshift path treats as trouble.
  private static readonly ABR_UPSHIFT_MIN_BUFFER_S = 8;
  // How far BEHIND the playhead an in-place rendition swap aims its seek.
  //
  // The seek lands where it is asked to, which on these streams is usually
  // mid-GOP — and a decoder that has just been flushed cannot start there. It
  // discards packets until the next keyframe, which for a 60fps YouTube
  // rendition is several seconds away: the logs show 193 and 234 frames
  // skipped, with the first decodable frame landing 4.5s AHEAD of the audio
  // clock. The picture then holds on its last frame for those 4.5 seconds,
  // which is the "it went black and never came back" this was chasing — and
  // the freeze watchdog reads it as a stall and drops another rung, and the
  // one after that, all the way down the ladder.
  //
  // Aiming behind the playhead puts the landing at or before a keyframe, so
  // the new rendition starts with a frame the clock has already passed. Those
  // frames are downloaded and decode far faster than real time; the renderer
  // drops the ones older than the clock and the picture resumes at once.
  private static readonly RENDITION_SWAP_LOOKBACK_S = 4;
  /** How far past the playhead the incoming rendition must decode before a
   *  seamless switch will commit. A quarter second is several frames of
   *  runway — enough that the new decoder is never the thing being waited on
   *  at the seam. */
  private static readonly SEAMLESS_PRIME_LEAD_S = 0.25;
  // A rung switch's opening read — see switchVideoRenditionInPlace.
  private static readonly SWITCH_FIRST_RANGE_BYTES = 512 * 1024;
  // No ABR decision this soon after a seek — see abrDecide.
  private static readonly ABR_POST_SEEK_HOLD_MS = 3000;
  /** …and the most it may prime, however much the outgoing queue holds. Whole
   *  decoded frames are expensive at 4K and outrageous at 8K. */
  private static readonly SEAMLESS_PRIME_MAX_AHEAD_S = 0.6;
  private static readonly SEAMLESS_PRIME_MIN_FRAMES = 3;
  /** Long enough to cross a GOP on a slow link, short enough that a switch
   *  which cannot be made seamless falls back before the reason for switching
   *  gets worse. */
  private static readonly SEAMLESS_PRIME_BUDGET_MS = 5000;
  /**
   * Whole-prep bound for an in-place switch — open, seek and prime together.
   *
   * Every await in the prep was unbounded, and the one that hurts is the rung
   * that cannot be fed: an 8K AV1 rung is a 1.2GB file at 38.7Mbps, and on a
   * link that measures about the same the open alone can hang for as long as
   * it likes. Nothing rescues that, because `_abrSwitchInProgress` is held for
   * the whole call and it gates abrDecide, the decode downshift AND
   * abrEmergencyDownshift — so the ladder cannot step back down while the
   * stream it is stuck on saturates the link the player is starving for.
   *
   * Generous on purpose. A DOWNSHIFT comes through here too, and that is the
   * one switch a struggling player must always be able to finish; its target
   * is a smaller rung, so it is nowhere near this. What this cuts off is a
   * climb into a rung the link cannot carry, which is the only case that ever
   * runs this long.
   */
  private static readonly SWITCH_PREP_BUDGET_MS = 12_000;
  /**
   * The same bound for a step DOWN, which the note above assumed would never
   * come near 12s. It does, on exactly the link that asks for one: at 0.2 MB/s
   * the 480p rung's header, index and the GOP behind the swap point are ~2MB,
   * ten seconds before anything else waits. The downshift was abandoned at the
   * budget, decided again, abandoned again — four times, until the element
   * gave up on a video the lower rung would have carried. Abandoning a
   * downshift buys nothing: the rung being left has already run dry, and the
   * outgoing source is held for the prep (suspendNetwork), so there is no
   * picture to go back to. What still needs an end is a rung the link cannot
   * feed at all, and this is that end.
   */
  private static readonly SWITCH_DOWN_PREP_BUDGET_MS = 30_000;
  // bandwidth → consecutive "couldn't sustain this rung" strikes + when the last
  // one hit. Each strike doubles the re-climb penalty (30s → 1m → 2m … capped),
  // so a rung the link keeps failing to hold is backed off harder and harder
  // instead of ping-ponging back into it every ~40s. Decays after a clean spell
  // so a genuinely improved link gets a fresh shot at the higher rung.
  private _abrDrainStrikes: Map<number, { count: number; at: number }> =
    new Map();
  // True while the video decoder is holding on the last frame mid-playback,
  // waiting for the next keyframe (clock/audio keep running). The video buffer
  // drains during this hold even though the network is fine, so ABR must NOT
  // read it as the rung failing and downshift.
  private _videoHoldingForKeyframe: boolean = false;
  // performance.now() of the last seek. The buffering right after a seek is a
  // normal re-fill, not a network stall — switching rendition into that (racing
  // the seek's own re-prime/re-read) is what crashed the demuxer, so the
  // emergency downshift stands down briefly after a seek.
  private _lastSeekAt: number = Number.NEGATIVE_INFINITY;
  // Black-frame recovery: a seek can force-complete with no decodable video frame
  // (the demuxer runs a GOP to EOF without a keyframe the decoder accepts —
  // open-GOP / a bad seek point), then the audio-driven buffering→resume flips to
  // "playing" over a BLACK screen while audio plays. A manual seek elsewhere fixes
  // it, so we automate that: a watchdog nudges the playhead to the next GOP when
  // no frame lands. Bounded so a genuinely undecodable stream can't seek forever.
  private _blackFrameWatchdog: ReturnType<typeof setTimeout> | null = null;
  private _blackRecoverySeeks: number = 0;
  private static readonly MAX_BLACK_RECOVERY_SEEKS = 3;

  private _activeSubtitleLang: string = "";
  private _externalSubCues: SubtitleCue[] = [];
  /**
   * Subtitle tracks whose cues were handed to us rather than fetched — see
   * appendSubtitleCues. Keyed by lang, each list kept sorted by start. The
   * array IS what the external renderer reads when that lang is active, so an
   * append shows up on the next tick without a reload.
   */
  private _generatedSubCues = new Map<string, SubtitleCue[]>();
  /** Generated tracks still waiting for their first cue — listed with a
   *  working indicator rather than as an empty track that does nothing. */
  private _pendingSubLangs = new Set<string>();
  private _externalSubTimer: number | null = null;
  public trackManager: TrackManager;
  private clock: Clock;
  private stateManager: PlayerStateManager;
  private mediaInfo: MediaInfo | null = null;
  private fileSize: number = -1; // Cached file size for buffer calculations
  private lastBufferedTime: number = 0;
  // Media-time anchor of the current network buffering run. It is zero on
  // load/poster reset and the requested time after a real seek, allowing the
  // UI to draw the actual buffered interval instead of inventing [0, end].
  private bufferedRangeStart: number = 0;

  /**
   * Enable/disable seek-bar scrub previews on an already-constructed player.
   * Lets the `thumb` attribute be toggled at runtime (or applied after `src`,
   * whose callback creates the player first) without recreating the player.
   * The thumbnail pipeline stays lazy — it only spins up on the first hover.
   */
  setPreviewsEnabled(enabled: boolean): void {
    this.config.enablePreviews = enabled;
    // Turning previews back on clears the "gave up" latch so a prior failed
    // init (or a never-attempted one) can retry on the next hover.
    if (enabled) this.previewInitGaveUp = false;
  }

  /**
   * The longest edge a preview JPEG is worth encoding at.
   *
   * The card is about 160px wide. Encoding the frame at its own size — 1920,
   * or 3840 on a 4K source — spends the time on pixels the browser then throws
   * away scaling it down: measured at 519KB and ~45ms a frame on 4K60, per
   * hovered position, on a fast desktop. Downscaling first costs one draw.
   */
  private static readonly PREVIEW_MAX_EDGE = 480;

  /**
   * How big a frame the SOFTWARE preview decoder may be asked for.
   *
   * Only reached when WebCodecs refuses the source outright — 8K H.264 is
   * refused by every browser tested. The cost is the decode, which is the
   * source's own size whatever the scaler is then asked for: measured in WASM
   * on this machine, ~250-330ms of blocked main thread per 8K frame, and over
   * a second for the first. 4K UHD (8.3MP) sits just under the line and stays.
   */
  private static readonly PREVIEW_SOFTWARE_MAX_PIXELS = 9_000_000;

  /**
   * Is the source too big to preview in software?
   *
   * Asked in two places, because a browser can refuse the source at
   * configure() — Chrome does, for 8K H.264 — or accept it and then fail to
   * produce a frame, which is what a decoder that cannot really do this size
   * looks like from here. Both end at the same software decoder, and at that
   * size it stalls the page either way.
   */
  private previewSoftwareTooBig(): boolean {
    const track = this.trackManager.getActiveVideoTrack();
    if (!track?.width || !track?.height) return false;
    return track.width * track.height > MoviPlayer.PREVIEW_SOFTWARE_MAX_PIXELS;
  }

  /**
   * The source's shape, shrunk to the size a preview is actually shown at.
   *
   * Everything on the preview path used to work at the source's own
   * resolution and shrink at the very end, one step before the JPEG. On an 8K
   * source that means a 7680x4320 RGBA buffer — 132MB — scaled by the decoder,
   * copied out of WASM, uploaded as a texture and drawn, per hover, for a
   * picture that is then thrown away and redrawn at 480px. Measured on 8K
   * H.264: 1.7-2.4s per preview with the main thread stalled for up to 2.1s of
   * it, which is the seek bar hanging the player while the keyboard seeks fine.
   *
   * The scaler has to resize the frame either way, so asking it for the size
   * the picture is wanted at costs nothing and saves all of the above.
   */
  private static previewShape(
    width: number,
    height: number,
  ): { width: number; height: number } {
    const longest = Math.max(width, height);
    if (
      !(longest > MoviPlayer.PREVIEW_MAX_EDGE) ||
      !(width > 0) ||
      !(height > 0)
    ) {
      return { width, height };
    }
    const scale = MoviPlayer.PREVIEW_MAX_EDGE / longest;
    return {
      width: Math.max(2, Math.round(width * scale)),
      height: Math.max(2, Math.round(height * scale)),
    };
  }
  private previewScaleCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;

  /**
   * Frames already made, kept by the second they belong to.
   *
   * Scrubbing asks for a new time every few pixels of pointer travel, and the
   * pipeline is one decoder: each request seeks, decodes and encodes from
   * scratch, so a viewer moving back and forth over the same stretch paid for
   * the same frames again and again — and the card sat on its loading state
   * every time. A second is finer than the strip can show, so quantising to it
   * costs nothing and makes the second pass over any stretch instant.
   *
   * Bounded and insertion-ordered: the oldest entry goes when it is full, which
   * for scrubbing is the part of the timeline the pointer has left behind.
   */
  // Counted in cache steps, not seconds — see PREVIEW_CACHE_STEP_S. Raised
  // with the step so the window of scrubbing a viewer can go back over
  // without re-decoding stays about the same length of film.
  private static readonly PREVIEW_CACHE_MAX = 200;
  private previewCache = new Map<number, Blob>();

  /**
   * The same frames again, filed under the keyframe they actually came from.
   *
   * Outside precise mode a preview IS the keyframe at or before the hovered
   * time, so every position inside one GOP is the same picture — and on a
   * long-GOP source that is seconds of timeline. The time-keyed cache above
   * cannot know that: it files by where the pointer was, so a scrub across a
   * single GOP missed on every step of it and paid a full decode and JPEG
   * encode (~11ms of the ~16ms a preview costs) to arrive at pixels it already
   * had.
   *
   * This map is consulted AFTER the seek, because the seek is what says which
   * keyframe the time belongs to — 4ms rather than 16, with no guess about
   * where the GOP boundaries are and so no risk of showing the wrong frame.
   */
  private previewByKeyframe = new Map<number, Blob>();

  /**
   * How finely the preview cache tells one moment from another.
   *
   * It was a whole second — Math.round(time) — and a whole second is also how
   * often the picture could then change. Every hover inside it was answered
   * with the same remembered frame, so a scrub across ten seconds of a film
   * showed ten pictures however carefully the frame under the pointer had been
   * decoded. The precision the decode paid for never reached the screen.
   *
   * A fifth of a second is fine enough to read as continuous while dragging,
   * and still coarse enough that a pointer trembling on one spot is answered
   * from memory rather than re-decoded.
   */
  private static readonly PREVIEW_CACHE_STEP_S = 0.2;

  /** The cache key for a time, or null when the frame can't be reused. */
  private previewKey(time: number, view?: VRView | null): number | null {
    // A 360 preview is reprojected to wherever the viewer is looking, so the
    // same second is a different picture from one moment to the next.
    if (view) return null;
    if (!Number.isFinite(time)) return null;
    return Math.round(time / MoviPlayer.PREVIEW_CACHE_STEP_S);
  }

  /**
   * Is this position's picture already in hand?
   *
   * Asked BEFORE a preview is dispatched, by the pacer that otherwise waits
   * for the pointer to settle. That wait exists to stop a scrub spending a
   * 2MB range fetch at every position it crosses — but a frame that is
   * already remembered costs nothing to produce, so waiting for it buys
   * nothing and is simply 180ms of delay. Synchronous on purpose: a pacer
   * that had to await this could not decide in the same tick as the move.
   */
  hasPreviewFor(time: number, view?: VRView | null): boolean {
    const key = this.previewKey(time, view);
    return key !== null && this.previewCache.has(key);
  }

  private rememberPreview(key: number, blob: Blob): void {
    this.previewCache.set(key, blob);
    while (this.previewCache.size > MoviPlayer.PREVIEW_CACHE_MAX) {
      const oldest = this.previewCache.keys().next();
      if (oldest.done) break;
      this.previewCache.delete(oldest.value);
    }
  }

  /** The keyframe map's key for a decoded packet's pts, or null if unusable. */
  /**
   * The thumbnail demuxer's current packet, in the same time base as everything
   * that asks it questions.
   *
   * It reports the packet's RAW pts — `pkt->pts * time_base`, with no
   * `start_time` taken off — while every hover, target and duration on this
   * side of the WASM boundary is media time from zero. On a source whose
   * stream starts at zero those are the same number and nothing shows; on one
   * that does not, they are apart by exactly that offset, and three separate
   * things quietly read the wrong answer.
   *
   * Measured on a 47.7s 4K HEVC MPEG-TS whose stream starts at 1.050044s
   * (LG-Daylight-4K): a hover at 12.5s took the keyframe at raw 11.878 —
   * 10.827 in media time, and the file's own keyframe list confirms 11.877522
   * is a real raw pts, so the value is raw beyond doubt. The walk then stopped
   * at raw 12.545 because it breaks on `pts >= time`, which is media 11.495:
   * a preview one full second before the pointer, every time, sixty frames out
   * at this file's 59.94fps. Where the keyframe happened to land within the
   * offset of the hover, `timestamp < time` was false and the walk did not run
   * at all — precise mode falling back to the plain keyframe with nothing said.
   * And the renderer picks the frame nearest `targetSec`, which is media time,
   * against chunk timestamps that were raw — the same offset a third time.
   *
   * The C seek does normalise (it adds `start_time` to its target), so the
   * frame fetched was always the right one; only the arithmetic about it was
   * wrong. Correcting it here rather than in the WASM keeps the fix on the
   * side that owns the media-time convention, and needs no rebuild.
   */
  private previewPacketPts(): number {
    const raw = this.thumbnailBindings?.getPacketPts() ?? 0;
    if (!Number.isFinite(raw)) return raw;
    return raw - this.startTime;
  }

  private keyframeKey(pts: number): number | null {
    if (!Number.isFinite(pts)) return null;
    // Milliseconds: fine enough that two different keyframes never collide,
    // coarse enough that the same one always hashes the same way.
    return Math.round(pts * 1000);
  }

  private rememberKeyframePreview(pts: number, blob: Blob): void {
    const kfKey = this.keyframeKey(pts);
    if (kfKey === null) return;
    this.previewByKeyframe.set(kfKey, blob);
    while (this.previewByKeyframe.size > MoviPlayer.PREVIEW_CACHE_MAX) {
      const oldest = this.previewByKeyframe.keys().next();
      if (oldest.done) break;
      this.previewByKeyframe.delete(oldest.value);
    }
  }

  /** Drop remembered frames — the pictures behind them are no longer the file. */
  private clearPreviewCache(): void {
    this.previewCache.clear();
    this.previewByKeyframe.clear();
  }

  /**
   * Pictures the source brought with it (see utils/Storyboard).
   *
   * When a source has a storyboard, a preview costs a crop out of an image the
   * browser already has, instead of a seek, a decode and an encode — and the
   * second WASM module the decode path needs is never opened at all. Set from
   * the element's `storyboard` attribute or property; a URL is a WebVTT
   * thumbnail track, an object is a tile spec.
   */
  private storyboardSource: string | StoryboardSpec | null = null;
  private storyboard: Storyboard | null = null;
  private storyboardLoad: Promise<Storyboard | null> | null = null;
  /** Mosaics already fetched, by URL — one image serves dozens of previews. */
  private storyboardImages = new Map<string, Promise<ImageBitmap | null>>();
  private storyboardCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;

  setStoryboard(source: string | StoryboardSpec | null): void {
    if (source === this.storyboardSource) return;
    this.storyboardSource = source;
    this.storyboard = null;
    this.storyboardLoad = null;
    this.storyboardImages.clear();
    this.clearPreviewCache();
    // Load the BOARD now rather than on the first hover. It is a few KB of
    // text (or nothing at all, for a spec), and waiting until the pointer
    // arrives means the one hover that matters most — the first — is the one
    // that has to wait for it.
    //
    // The mosaics it names are a different matter: those are real pictures,
    // and pulling one here put a fetch of hundreds of KB alongside the opening
    // buffer, which is bandwidth the video needs more than a hover nobody has
    // made yet. They are warmed once playback is running instead — by the
    // element, which paints them and knows when that moment arrives (see
    // MoviElement.flushStoryboardWarm). Nothing is lost if there is no element:
    // cropStoryboardTile fetches the sheet it needs on demand, as it always
    // did.
    if (source) void this.ensureStoryboard();
  }

  /** The board's mosaics in order, for a caller that paints them itself. */
  getStoryboardSheets(): string[] {
    return this.storyboard?.sheets() ?? [];
  }

  /**
   * The same list, but once the board has actually been parsed — for a caller
   * that wants to pull the pictures in before anybody hovers.
   *
   * getStoryboardSheets answers from what is in hand, so at load time (the one
   * moment worth warming at) it answers with nothing: a VTT track is still in
   * flight. Resolves to an empty list when there is no board, or when it turns
   * out not to have one — never rejects, because a storyboard is an
   * optimisation and its absence is not an error.
   */
  whenStoryboardReady(): Promise<string[]> {
    if (!this.storyboardSource) return Promise.resolve([]);
    return this.ensureStoryboard().then((board) => board?.sheets() ?? []);
  }

  /** True while a storyboard is standing in for the decode path. */
  hasStoryboard(): boolean {
    return this.storyboardSource !== null;
  }

  /**
   * The tile for a moment, RIGHT NOW — no promise, no crop, no encode.
   *
   * Cropping a tile into a blob costs a canvas draw, a JPEG encode and an
   * image decode on the other side, and the caller has to await all of it. A
   * caller that can paint the mosaic itself (the seek card, with a background
   * offset) needs none of that: it needs the rectangle, and it needs it in the
   * same frame the pointer moved. Returns null until the board is parsed —
   * asking starts that, so the next move is answered.
   */
  getStoryboardTileSync(time: number): StoryboardTile | null {
    if (!this.storyboardSource) return null;
    if (!this.storyboard) {
      void this.ensureStoryboard();
      return null;
    }
    return this.storyboard.tileAt(time);
  }

  private ensureStoryboard(): Promise<Storyboard | null> {
    if (this.storyboard) return Promise.resolve(this.storyboard);
    if (this.storyboardLoad) return this.storyboardLoad;
    const source = this.storyboardSource;
    if (!source) return Promise.resolve(null);

    // A spec needs no fetch — and, in the sprite form, needs the video's length,
    // which may not be known yet. Answer it here rather than inside the cached
    // promise below: caching a "not yet" would make it the answer forever.
    if (typeof source !== "string") {
      const board = Storyboard.fromSpec(source, this.getDuration());
      if (!board) return Promise.resolve(null);
      this.storyboard = board;
      Logger.info(
        TAG,
        `Storyboard ready: ${board.coverage.toFixed(0)}s covered`,
      );
      return Promise.resolve(board);
    }

    this.storyboardLoad = (async () => {
      try {
        if (typeof source === "string") {
          const res = await fetch(source, {
            signal: this.lifetimeSignal,
            ...(this.config.headers ? { headers: this.config.headers } : {}),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const url = res.url || source;
          this.storyboard = Storyboard.parseVtt(await res.text(), url);
        }
        if (!this.storyboard) {
          Logger.warn(
            TAG,
            "Storyboard had no usable cues — falling back to decoding previews",
          );
        } else {
          Logger.info(
            TAG,
            `Storyboard ready: ${this.storyboard.coverage.toFixed(0)}s covered`,
          );
        }
      } catch (e) {
        // A storyboard is an optimisation, never a requirement: losing it costs
        // speed, and the decode path answers exactly as it did before.
        Logger.warn(
          TAG,
          `Storyboard load failed: ${(e as Error)?.message ?? e}`,
        );
        this.storyboard = null;
        this.storyboardSource = null;
      }
      return this.storyboard;
    })();
    return this.storyboardLoad;
  }

  private loadStoryboardImage(url: string): Promise<ImageBitmap | null> {
    const existing = this.storyboardImages.get(url);
    if (existing) return existing;
    const pending = (async () => {
      try {
        const res = await fetch(url, {
          signal: this.lifetimeSignal,
          ...(this.config.headers ? { headers: this.config.headers } : {}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await createImageBitmap(await res.blob());
      } catch (e) {
        Logger.warn(
          TAG,
          `Storyboard mosaic failed: ${(e as Error)?.message ?? e}`,
        );
        return null;
      }
    })();
    this.storyboardImages.set(url, pending);
    return pending;
  }

  /** Cut one tile out of its mosaic and hand it over as a preview. */
  private async cropStoryboardTile(tile: StoryboardTile): Promise<Blob | null> {
    const image = await this.loadStoryboardImage(tile.url);
    if (!image) return null;
    const w = tile.width > 0 ? tile.width : image.width;
    const h = tile.height > 0 ? tile.height : image.height;
    if (
      !this.storyboardCanvas ||
      this.storyboardCanvas.width !== w ||
      this.storyboardCanvas.height !== h
    ) {
      if (typeof OffscreenCanvas !== "undefined") {
        this.storyboardCanvas = new OffscreenCanvas(w, h);
      } else {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        this.storyboardCanvas = c;
      }
    }
    const ctx = (this.storyboardCanvas as HTMLCanvasElement).getContext(
      "2d",
    ) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(image, tile.x, tile.y, w, h, 0, 0, w, h);
    return this.encodePreviewBlob(this.storyboardCanvas);
  }

  /**
   * Encode what has been rendered into `src` as a preview JPEG, shrinking it
   * first when it is bigger than a preview needs to be.
   */
  private encodePreviewBlob(
    src: OffscreenCanvas | HTMLCanvasElement,
  ): Promise<Blob | null> {
    const w = src.width;
    const h = src.height;
    const longest = Math.max(w, h);
    let out: OffscreenCanvas | HTMLCanvasElement = src;
    if (longest > MoviPlayer.PREVIEW_MAX_EDGE && w > 0 && h > 0) {
      const scale = MoviPlayer.PREVIEW_MAX_EDGE / longest;
      const dw = Math.max(1, Math.round(w * scale));
      const dh = Math.max(1, Math.round(h * scale));
      if (
        !this.previewScaleCanvas ||
        this.previewScaleCanvas.width !== dw ||
        this.previewScaleCanvas.height !== dh
      ) {
        if (typeof OffscreenCanvas !== "undefined") {
          this.previewScaleCanvas = new OffscreenCanvas(dw, dh);
        } else {
          const c = document.createElement("canvas");
          c.width = dw;
          c.height = dh;
          this.previewScaleCanvas = c;
        }
      }
      const ctx = (this.previewScaleCanvas as HTMLCanvasElement).getContext(
        "2d",
      ) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (ctx) {
        ctx.drawImage(src as CanvasImageSource, 0, 0, dw, dh);
        out = this.previewScaleCanvas;
      }
    }
    if (
      typeof OffscreenCanvas !== "undefined" &&
      out instanceof OffscreenCanvas
    ) {
      return out.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    }
    return new Promise<Blob | null>((resolve) => {
      (out as HTMLCanvasElement).toBlob(
        (blob) => resolve(blob),
        "image/jpeg",
        0.7,
      );
    });
  }

  /**
   * Walk forward from the keyframe to the frame the pointer is actually on.
   *
   * A preview is normally the keyframe at or before the hovered time, because
   * that is the one frame a seek can hand over for free. On a long-GOP source
   * — a WEB-DL with 5-10s between keyframes — that is a picture from seconds
   * away from where the viewer is pointing. Precise mode decodes the frames in
   * between and shows the one that belongs to the hovered second instead.
   *
   * Off by default: it is the same decode the player does for playback, on the
   * hover path, so it costs a run of frames per preview rather than one — and
   * the run is as long as the source's GOP, since a walk that gives up part
   * way is a keyframe preview wearing this mode's name.
   */
  private precisePreviews = false;

  setPrecisePreviews(enabled: boolean): void {
    this.precisePreviews = enabled;
  }

  /**
   * Can a preview still cost a network read, or is every frame it will be
   * asked for already in hand?
   *
   * The seek bar asks before it decides how hard to push: a preview made from
   * bytes the machine already holds can be asked for as fast as the pointer
   * moves, but one that has to fetch cannot. The thumbnail reader pulls a 2MB
   * window per position, and a scrub is a run of positions — so asking for
   * every one of them puts the fetch for the frame the viewer actually stopped
   * on at the BACK of a queue of fetches for frames they only passed over. The
   * bar answers that by waiting for the pointer to settle first; this is how it
   * knows to.
   *
   * False for a local file (nothing to fetch, ever) and for an HTTP source
   * whose bytes are all in memory — a small file that has finished downloading
   * scrubs like a local one and must not be slowed down to match a link it is
   * no longer using. True for an adaptive stream, whose thumbnail tiles are
   * fetched per position by the wrapper.
   *
   * A source adapter from outside this file answers neither test and so counts
   * as fetching, which is the right way round to be wrong: a custom adapter is
   * a remote one until shown otherwise, and the cost of pacing one that turns
   * out to be local is a fraction of a second of settle, against a queue of
   * whole fetches the other way.
   */
  previewsMayFetch(): boolean {
    if (this.streamWrapper) return true;
    if (!this.source) return false;
    if (this.source instanceof FileSource) return false;
    return !(
      this.source as { isFullyCached?: () => boolean }
    ).isFullyCached?.();
  }

  private previewsAllowed(): boolean {
    if (!this.config.enablePreviews) return false;
    // Non-range sources keep previews ON: the thumbnail source borrows frames
    // straight from the main source's RAM window (no network), so previews work
    // for any position inside the buffered/seekable range.
    // NOTE: a file-size cap used to live here — the seek-bar thumbnail
    // pipeline opens a SECOND isolated WASM module + FFmpeg context, and on
    // large 1 GB+ sources the two heaps can exhaust the tab's memory budget,
    // making a later memory.grow() fail and trapping FFmpeg with "memory
    // access out of bounds" mid-playback. The cap was removed deliberately to
    // allow previews on big files; if OOM crashes resurface on large 4K
    // sources, reinstating a size gate here is the first thing to try.
    // No real video stream → nothing to scrub. Skipping here keeps
    // audio-only sources from opening a useless second WASM context
    // (the cover-art extractor already spins up its own short-lived one).
    if (this.trackManager.getVideoTracks().length === 0) return false;
    return true;
  }

  /** Proxy a stream wrapper's events + mirror its TrackManager onto the player. */
  private wireStreamWrapper(wrapper: StreamWrapper): void {
    const events = [
      "loadStart",
      "loadEnd",
      "play",
      "pause",
      "ended",
      "timeUpdate",
      "durationChange",
      "stateChange",
      "error",
      "buffering",
      "seeking",
      "seeked",
    ] as const;
    events.forEach((evt) => {
      // @ts-ignore — event names line up across the wrapper and player maps
      wrapper.on(evt, (arg) => this.emit(evt, arg));
    });
    wrapper.trackManager.on("tracksChange", (tracks) => {
      this.trackManager.setTracks(tracks);
    });
  }

  // Decoders and Renderers
  private videoDecoder: MoviVideoDecoder;
  private audioDecoder: MoviAudioDecoder;
  private subtitleDecoder: SubtitleDecoder | null = null;
  // Host-supplied subtitle renderer (e.g. jassub/libass for ASS). When set, the
  // active subtitle stream is routed to it instead of the internal decoder.
  private _customSubtitleRenderer: SubtitleRenderer | null = null;
  private _subtitleRenderRAF: number | null = null;
  private _subtitleDelaySec = 0;
  private videoRenderer: CanvasRenderer | null = null;

  // Stream id of the subtitle track whose entire cue list has already been
  // prefetched into the renderer cache. Used to avoid scanning twice when
  // the user nudges the delay value while the same track is active.
  private prefetchedSubtitleStream: number | null = null;
  private prefetchInFlight: boolean = false;

  // Embedded cover art (ID3v2 APIC, FLAC PICTURE, MP4 covr, MKV attachment).
  // Extracted once at load time when the demuxer reports an attached_pic
  // pseudo-stream; null for plain video files or audio without artwork.
  private coverArt: ImageBitmap | null = null;

  // Active adaptive-streaming wrapper (Shaka primary, hls.js/dash.js fallback).
  // Non-null only while a stream source is active; delegation throughout the
  // player stays format-agnostic.
  private streamWrapper: StreamWrapper | null = null;

  // Preview pipeline (C-based FFmpeg software decoding)
  private thumbnailBindings: ThumbnailBindings | null = null;
  /** The half-built pipeline, while it is still being built. It holds an
   *  FFmpeg context from the moment it exists, so teardown has to be able to
   *  find it even though callers must not — see initPreviewPipeline. */
  private thumbnailBindingsPending: ThumbnailBindings | null = null;
  private thumbnailSource: SourceAdapter | null = null;
  private thumbnailRenderer: ThumbnailRenderer | null = null;
  private thumbnailHDREnabled: boolean = true; // HDR enabled by default
  private isPreviewGenerating: boolean = false;
  /** The generation currently in flight, for callers that must WAIT rather
   *  than be turned away — see getPreviewFrame's `queue` argument. */
  private previewInFlight: Promise<Blob | null> | null = null;
  private audioRenderer: AudioRenderer;
  // Bumped every time the preview pipeline is torn down, so an init still
  // suspended in one of its awaits can tell that the pipeline it is building
  // belongs to a source (or a player) that is already gone.
  private _previewGeneration = 0;
  private previewInitPromise: Promise<void> | null = null; // Guard for preview initialization
  private previewInitAttempts: number = 0; // Bounded retries for preview pipeline init
  // Deferred eager preview warm-up (see load()): keeps the thumbnail decoder
  // from competing with the main decode during the startup grace.
  private _previewWarmTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PREVIEW_WARM_DELAY_MS = 12000;
  // How long to wait before re-asking when the warm-up came due while playback
  // was still young, or while the pipeline was busy seeking/rebuffering.
  private static readonly PREVIEW_WARM_RETRY_MS = 2000;
  // Idle wait before the preview reader's 2MB fetch window is released.
  private _thumbBufferIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly THUMB_BUFFER_IDLE_MS = 8000;
  // Background recovery of a duration the container never stored. One attempt
  // per source; see rescanDurationInBackground.
  private _durationRescanTimer: ReturnType<typeof setTimeout> | null = null;
  private _durationRescanDone: boolean = false;
  private static readonly DURATION_RESCAN_DELAY_MS = 3000;
  private previewInitGaveUp: boolean = false; // Stop retrying once init has failed too often

  // Debug flag to disable audio processing
  private disableAudio: boolean = false; // Set to true to disable audio for debugging
  // Audio-only mode (data-saver): skip video decoding to save CPU (the
  // demuxer still reads the interleaved bytes, but decode is the expensive
  // part); for adaptive streams the wrapper also drops the video renditions to
  // save bandwidth. The UI switches to the album-art / strip surface.
  private _audioOnly: boolean = false;
  private muted: boolean = false; // Mute state
  /**
   * Bind the two streams: either one running out stops both.
   *
   * Off (the default) each side is allowed to carry on while the other is
   * short. That is asymmetric in practice, because the two run out for
   * different reasons. Video runs out on the WIRE — it is an order of
   * magnitude the bigger stream, so on a slow link it is always the one
   * refilling, and the sound sails on over a frozen frame until the picture
   * comes back seconds behind what you have already heard. Audio runs out on
   * the CPU — an expensive codec decoding slower than realtime — and there the
   * picture carries on over sound full of holes.
   *
   * Bound — the default — neither happens: whichever side empties, playback
   * buffers, both are suspended, and they start again together when both are
   * ready. The cost is that a shortfall you would previously have watched or
   * listened through becomes a full stop, which is the honest thing to show:
   * a picture running seconds behind the sound is not playback anyone asked
   * for. `bindav="false"` unbinds them for a caller who would rather have the
   * stutter.
   *
   * The one case that would suffer from this is a picture that is merely slow
   * to DECODE, and that is not this: the frames-presented check below restarts
   * the stall window whenever frames are still reaching the screen, so a source
   * decoding at half rate keeps stuttering along rather than turning into a
   * spinner.
   */
  private _bindAV: boolean = true;

  /**
   * Does this source actually have a picture to wait for?
   *
   * Canvas mode builds a CanvasRenderer for EVERY source, audio-only included —
   * the strip a music file plays behind is that same renderer. So
   * `!!this.videoRenderer` says "we could draw", never "there is anything to
   * draw", and every place that read it as the latter was asking a video-less
   * file to produce a frame. Its queue is empty forever, which is
   * indistinguishable from a video source whose queue has just run dry.
   *
   * Measured on a FLAC-only .mka: the stall detector's `videoEmpty` was
   * permanently true and `_bindAV` defaults to true, so `videoStalled` held
   * from the first tick — and `bufferingForVideo`, also gated on the renderer
   * merely existing, lifted the audio ceiling for the whole of the buffering
   * that followed. The file played 0.51s, stalled, swallowed 141 SECONDS of
   * audio in one uninterrupted read, sat in buffering for 5.5s, resumed, and
   * did it again: five cycles in 5.6s of media.
   *
   * The honest question is whether the SOURCE carries video, so ask that.
   */
  private get hasPicture(): boolean {
    return !!this.videoRenderer && !!this.trackManager?.getActiveVideoTrack();
  }
  private wasPlayingBeforeRebuffer: boolean = false; // Track if we were playing before entering rebuffering state
  /**
   * Buffering is over and play() has been called, but the state is not
   * "playing" yet (upstream 8d9e25c).
   *
   * Leaving buffering sets "paused" and then calls play(), which is async: it
   * resumes the AudioContext and re-anchors before it flips the state. The
   * decoder does not wait, and the frame callback closes every frame that
   * arrives outside playing/buffering — upstream measured 33 frames closed in
   * that window and a picture frozen for 1.1s on the hole they left.
   */
  private _resumeToPlayPending: boolean = false;
  // Starting playback crosses async browser boundaries (AudioContext/media
  // element resume). A user play request can race the automatic
  // buffering->play recovery during that await. Keep the operation
  // single-flight so a late duplicate cannot observe the first caller's
  // `playing` state as an invalid transition and pause the shared clock.
  private playInFlight: Promise<void> | null = null;
  private _stallStartTime: number = 0; // When stall was first detected
  /** performance.now() of the last frame decoded while a seek waited for sync —
   *  the signal that the seek is still working. See the seek deadline. */
  private _seekFrameProgressAt: number = 0;
  /** How long the video decoder may go silent mid-seek before the seek is
   *  declared stuck. One 4K AV1 frame is a few tens of ms even on a slow
   *  machine, so a gap this long means it has stopped, not slowed. */
  private static readonly SEEK_PROGRESS_IDLE_MS = 400;
  /** …and the ceiling on extending, because a decoder emitting frames that
   *  never reach the target is itself a failure to give up on. */
  private static readonly SEEK_PROGRESS_CAP_MS = 10000;
  /** framesPresented when the current stall window opened — the baseline the
   *  "is the picture still moving?" test measures against. */
  private _stallStartFrames: number = 0;
  /** Presented-frames-per-second at or above which an empty video queue is a
   *  slow decoder, not a stall. Deliberately low: this is the line between
   *  "watchable, if choppy" and "frozen", not a quality bar. A 60fps source
   *  running at 30, or a 24fps one dropping half its frames, is comfortably
   *  over it; a picture that has actually stopped presents nothing at all. */
  private static readonly STALL_MOVING_FPS = 5;
  // True when the current buffering state was entered because of something WE
  // just did — a rate change's audio re-anchor, or a seek resuming on the thin
  // buffer it left behind — rather than a real data/decode stall. Those resume
  // the moment the pipeline is ready instead of serving the stall floor.
  private _bufferingSelfInflicted: boolean = false;
  /**
   * True from a video underflow until the stall it caused resumes: the picture
   * is being caught up to a clock held where it stopped (see processLoop).
   */
  private _catchingUpVideo: boolean = false;
  /** Non-reference skipping was switched on for a catch-up (and must go off with it). */
  private _catchUpSkipEngaged: boolean = false;
  /** The performance detector asked for non-reference skipping for good. */
  private _perfSkipLatched: boolean = false;
  private _lastRateChangeAt: number = 0;
  private _lastSeekResumeAt: number = 0;

  /**
   * How little must be buffered ahead for a stall to be about the LINK. A link
   * that cannot carry the rung starves the buffer to nothing; anything above
   * this and the bytes were already there.
   */
  private static readonly ABR_STALL_STARVED_S = 5;
  /** How long after a rate change or a seek's resume an audio stall is still
   *  attributable to the flush/re-anchor that operation performed itself. */
  private static readonly SELF_INFLICTED_STALL_WINDOW_MS = 1500;
  /**
   * A speed change held back until the audio can carry it (upstream 181ee7a,
   * 8e77c8a). The rate the viewer asked for, or 0.
   *
   * AudioRenderer re-anchors a rate change in place when it holds a cushion
   * (canCarryRateChange); without one the only way to keep the clock honest is
   * the corrective seek, which flushes both decoders and throws the frame
   * queue away — the dead stop on a machine that plays the file perfectly well
   * at 1x. The cushion is usually a few hundred milliseconds away (right after a
   * seek, a start or an underrun), so wait for it instead of paying for the stop.
   */
  private _pendingRate = 0;
  private _pendingRateSince = 0;
  private _applyingPendingRate = false;
  /** How long a held speed change waits before it takes the seek anyway. */
  private static readonly RATE_PREPARE_MAX_MS = 1500;
  /**
   * The picture running behind the sound, and staying there.
   *
   * Frame selection normally makes this self-healing: the presentation loop
   * takes the LATEST due frame, so a hitch is absorbed the moment fresh frames
   * arrive. What it cannot absorb is a decoder that lost ground and only ever
   * decodes forward at ~1x — after a GC pause or a few starved seconds on a
   * small-memory device, every frame that arrives is already late by the same
   * amount, each one is dutifully presented, and the offset becomes permanent.
   *
   * Nothing else catches it. The frozen-picture watchdog reads advancing
   * frames as healthy, and the desync check further down only looks the other
   * way (audio behind video), so the only fix was the viewer seeking by hand.
   */
  /** Set per seek() call: true while a seek nobody asked for is in flight. */
  private _seekIsInternal = false;
  /**
   * How much media every active stream must hold ahead of the playhead before
   * a stall lets go — mpv's `cache_pause_wait` (playloop.c), one second. It
   * has to stay under the read loop's readahead (2s at the least), or the
   * wait could not be satisfied by the reads it is waiting on.
   */
  private static readonly RESUME_SECS = 1.0;
  /** The stall-detection grace given to a resume that came out of a stall
   *  rather than out of a cold start. Long enough for the queue we just waited
   *  for to start playing, short enough that the sound cannot walk. */
  private static readonly BOUND_RESUME_GRACE_MS = 500;
  /** How long the decoder may sit waiting for a keyframe, picture frozen, with
   *  the stall detector suppressed, before a binding calls it a stall. Ends the
   *  wait that never ends when the packets stop arriving. */
  private static readonly BOUND_KEYFRAME_HOLD_MS = 1500;
  /** How long a superseded seek waits for whoever took its session to resolve
   *  the "seeking" state before doing it itself. */
  private static readonly ORPHANED_SEEK_BACKSTOP_MS = 750;
  /** How long the picture gets to rejoin the sound in a video-only catch-up
   *  before a binding stops the sound and waits for it. Long enough that the
   *  ordinary case — a few hundred ms of already-buffered decode — passes
   *  unnoticed; short enough that a catch-up going nowhere cannot run away. */
  private static readonly RESYNC_HOLD_MS = 1200;
  private _playStartTime: number = 0; // When play() was called — grace period for stall detection

  /**
   * Can the picture simply carry on from where the clock is, with what has
   * already been decoded?
   *
   * The flag above says the demuxer's cursor is past the clock. That is true
   * the moment ANY seek settles paused — including the one a click on the seek
   * bar issues, because the bar pauses for the drag. But a click is followed by
   * play() within a few tens of milliseconds, while the frames that seek just
   * decoded are still queued: playback runs straight out of them and the cursor
   * being ahead never costs anything. Rewinding there is pure harm — it throws
   * away those frames, leaves the PREVIOUS position's picture on screen while
   * it re-seeks and re-decodes, and restarts the audio a second time. Measured:
   * a click seeking to 162.45s showed the old frame at 286.28s for ~240ms
   * before snapping, against a clean -0.04s landing without the rewind.
   *
   * What made the paused-scrub-then-play case different is that by the time
   * play arrived those frames were gone — the queue measured empty — so
   * decoding resumed from the cursor and skipped everything between. So the
   * question is not whether the cursor is ahead; it is whether the frames that
   * cover the gap still exist. This asks that directly.
   */
  /** performance.now() of the last buffering→playing resume (0 = never). */
  private _stallResumeAt: number = 0;
  private _primingAudio = false; // true while the first-play buffer is filling its startup cushion
  private _decoderStuckSince: number = 0; // When video decoder was first detected stuck
  private _lastDesyncSeekTime: number = 0; // performance.now() of last desync-triggered resync

  // An audio track switch is a refresh seek (see refreshDemuxerForAudioSwitch):
  // the demuxer re-reads from just before the playhead, and the streams that
  // were already playing must not take a second copy of what they have.
  //
  // `_refreshingVideo`/`_refreshingSubtitle` are up from the switch until the
  // first packet past what that stream had already taken (the video queue
  // remembers it as lastDts; subtitles have no queue, hence their own field).
  // `_refreshEpoch` tells a packet that was read BEFORE the seek landed — so it
  // comes from the position being abandoned — from one the re-read produced:
  // the loops stamp it before awaiting the read.
  private _refreshingVideo = false;
  private _refreshingSubtitle = false;
  private _lastSubtitleDts = Number.NaN;
  private _refreshEpoch = 0;
  // Up from an audio track switch until its new audio first reaches the
  // renderer: the sound is being rebuilt, and an empty audio buffer then says
  // nothing about the link. Stall detection and the resume gate leave it out.
  private _audioSwitching = false;
  // The new decoder is still being configured: its packets wait in the queue.
  private _audioDecoderConfiguring = false;
  // Which switch the two flags above belong to, so that a superseded one
  // finishing late cannot clear the flags of the one that replaced it.
  private _audioSwitchId = 0;
  // Audio decoded before the clock is dropped until the first frame at it —
  // mpv's audio SYNCING. Raised for a track switch, whose re-read starts a
  // second before the playhead.
  private _audioStartAlign = false;
  /** How far before the playhead an audio track switch re-reads from (mpv's
   *  `start_ts -= 1.0`, "small offset to get correct overlap"). */
  private static readonly AUDIO_SWITCH_REFRESH_BACK_S = 1.0;

  /**
   * Debug-only event ring around an audio track switch, off unless the host
   * sets it (the black-box harness does with MOVI_BLACKBOX_TRACE_TRANSITIONS).
   * From the switch it records the clock, the refresh seek, the first packets
   * and decoded buffers of the new track, and a 250 ms sample of clock, audio
   * anchor and picture, for audioSwitchTraceWindowMs. Read it back through
   * audioSwitchTrace.
   */
  audioSwitchTraceEnabled = false;
  private static readonly AUDIO_SWITCH_TRACE_WINDOW_MS = 8000;
  private static readonly AUDIO_SWITCH_TRACE_SAMPLE_MS = 250;
  private _switchTrace: Record<string, number | string | boolean>[] = [];
  private _switchTraceT0 = 0;
  private _switchTraceTimer: ReturnType<typeof setInterval> | null = null;
  private _switchTraceSeen = new Set<string>();
  private _switchTraceAlignDrops = 0;

  get audioSwitchTrace(): Record<string, number | string | boolean>[] {
    return this._switchTrace.slice();
  }

  private get switchTraceActive(): boolean {
    return (
      this.audioSwitchTraceEnabled &&
      this._switchTraceT0 > 0 &&
      performance.now() - this._switchTraceT0 <=
        MoviPlayer.AUDIO_SWITCH_TRACE_WINDOW_MS
    );
  }

  private beginAudioSwitchTrace(): void {
    if (!this.audioSwitchTraceEnabled) return;
    if (this._switchTraceTimer !== null) clearInterval(this._switchTraceTimer);
    this._switchTrace = [];
    this._switchTraceSeen.clear();
    this._switchTraceAlignDrops = 0;
    this._switchTraceT0 = performance.now();
    this._switchTraceTimer = setInterval(() => {
      if (!this.switchTraceActive) {
        if (this._switchTraceTimer !== null)
          clearInterval(this._switchTraceTimer);
        this._switchTraceTimer = null;
        return;
      }
      const video = this.videoRenderer?.getFrameStats();
      this.traceAudioSwitch("sample", {
        clock: this.clock.getTime(),
        anchor: this.audioRenderer.getAnchorMediaTime(),
        audioClock: this.audioRenderer.getAudioClock(),
        lastPts: video?.lastPts ?? -1,
        frameQueue: video?.queued ?? -1,
        videoPackets: this.videoQueue.length,
        audioPackets: this.audioQueue.length,
        presented: video?.presented ?? -1,
        skipped: video?.skipped ?? -1,
        dropped: video?.dropped ?? -1,
        alignDrops: this._switchTraceAlignDrops,
        state: this.stateManager.getState(),
      });
    }, MoviPlayer.AUDIO_SWITCH_TRACE_SAMPLE_MS);
  }

  /** once: record only the first event of this name since the switch. */
  private traceAudioSwitch(
    event: string,
    detail: Record<string, number | string | boolean>,
    once = false,
  ): void {
    if (!this.switchTraceActive) return;
    if (once) {
      if (this._switchTraceSeen.has(event)) return;
      this._switchTraceSeen.add(event);
    }
    const entry = {
      t: Number((performance.now() - this._switchTraceT0).toFixed(1)),
      event,
      ...detail,
    };
    this._switchTrace.push(entry);
    Logger.debug(TAG, `audio-switch trace ${JSON.stringify(entry)}`);
  }

  // Playback Loop
  private animationFrameId: number | null = null;
  private backgroundIntervalId: number | null = null;
  private backgroundWorker: Worker | null = null; // Worker-based timer for Safari
  /**
   * True when the tab is hidden.
   *
   * Seeded from the document rather than starting false, because a player is
   * not always born in a visible tab: an auto-advance while the viewer is away
   * destroys one player and builds the next one, and that new instance never
   * saw the visibilitychange that put the old one in the background. It came up
   * believing it was on screen, waited for a video frame that nothing was
   * decoding, and sat in buffering — silent — until the viewer came back. Every
   * background-aware branch in this file depends on this flag being right from
   * the first tick.
   */
  private isBackgrounded: boolean =
    typeof document !== "undefined" && document.visibilityState === "hidden";
  /**
   * The page has said hidden does not mean unwatched — see MoviElement's
   * `backgroundplay`. Two things follow from it: an autoplay may START while
   * hidden (handled in the element), and hiding the tab does not pause on a
   * phone (below).
   */
  private _backgroundPlay: boolean = false;
  // performance.now() of the last background→foreground recovery. For a short
  // window after, the audio-underrun stall detector is suppressed: returning
  // from background the decode loop was throttled, so a transient underrun is
  // expected and refills on its own. Without this the detector would suspend
  // audio the instant the user returns — stopping e.g. background music that
  // was playing fine — which it never did before the underrun-stall was added.
  private _foregroundRecoveryAt: number = 0;

  // WakeLock to prevent screen sleep during playback
  private wakeLock: WakeLockSentinel | null = null;

  // Seek state - track if we need to skip to keyframe after seek
  private seekingToKeyframe: boolean = false;
  private seekingToKeyframeStartTime: number = 0;
  private static readonly KEYFRAME_SEEK_TIMEOUT = 5000; // 5 seconds timeout
  /**
   * Video packets that must have been scanned before the wall-clock timeout is
   * allowed to give up and accept a non-keyframe. The timeout exists for long-GOP
   * content where a keyframe is genuinely far away — a condition measured in
   * PACKETS, not seconds. On a slow link only a handful of packets arrive in 5s,
   * so the pure wall-clock check fired while the demuxer was merely starved,
   * handing the decoder a non-keyframe and painting black video. Below this
   * count the seek is waiting on bytes, not on a keyframe, so keep waiting.
   */
  private static readonly SEEK_KEYFRAME_MIN_SCAN = 120;
  /** Absolute ceiling so a permanently starved seek can still bail out. */
  private static readonly KEYFRAME_SEEK_HARD_TIMEOUT = 20000;
  private seekKeyframeScanned: number = 0;
  // After a seek we prefer a true IDR to restart cleanly (avoids the open-GOP
  // CRA-as-key HW rejection on mixed-keyframe HEVC). But some streams only have
  // CRA keyframes for long stretches (e.g. seeking deep into a DoVi P8 .ts whose
  // sole IDR is at the file start), so if no IDR shows up within this short
  // window we fall back to resuming on a CRA rather than staying black.
  private seekCraSeen: number = 0;
  private static readonly SEEK_IDR_WAIT_MS = 400; // wait this long for an IDR before accepting a CRA

  // Demuxed packets waiting for their decoder, one queue per stream — see
  // PacketQueue for why the read loop no longer pushes straight into the
  // decoders. Subtitles are not queued: they are cheap to decode, sparse, and
  // must never be the reason the demuxer reads ahead.
  private videoQueue = new PacketQueue();
  private audioQueue = new PacketQueue();
  // The split-audio demuxer's own queue, read and fed by pumpSplitAudio.
  private splitAudioQueue = new PacketQueue();
  /**
   * Ceiling on what the two queues may hold together, whatever the readahead
   * says. Readahead is measured in seconds, and seconds are cheap on a 1080p
   * AAC file and expensive on 8K AV1; this is what stops a stream that can
   * never fill its readahead (a decoder that drops everything waiting for a
   * keyframe, an audio side that is never fed) from reading the rest of the
   * file into memory. 64MB is a few seconds of the heaviest sources this
   * player handles and well inside the 100MB default byte cache the source
   * reads through, so hitting it never evicts what the queues are about to
   * consume.
   */
  private static readonly MAX_QUEUE_BYTES = 64 * 1024 * 1024;
  /**
   * How long the read loop may hold the main thread before yielding to it.
   * Half a 60Hz frame: the presentation loop and the decoders' output
   * callbacks get every other slice, and the reads still keep pace with a
   * dense audio codec (TrueHD's ~1200 packets/s) because the loop resumes
   * as soon as they have run instead of waiting for the next rAF.
   */
  private static readonly READ_SLICE_MS = 8;

  // Prebuffer targets — accumulate this much before reporting "ready" so
  // play() doesn't immediately stall on short videos where the demux burst
  // outruns the HTTP stream.
  private static readonly PREBUFFER_AUDIO_SECONDS = 0.5;
  private static readonly PREBUFFER_VIDEO_FRAMES = 2;
  // How many further packets to read looking for the video frames once audio is
  // already satisfied — see the note in the prebuffer loop.
  private static readonly PREBUFFER_VIDEO_SEARCH_PACKETS = 120;
  private static readonly PREBUFFER_MAX_WALL_MS = 5000;
  private static readonly PREBUFFER_MAX_PACKETS = 400;

  // Seek target time - skip packets before this time to ensure accurate seeking
  // When seeking, FFmpeg seeks to the nearest keyframe BEFORE the target time
  // We need to decode but not display/play packets before the target time
  private seekTargetTime: number = -1;
  /**
   * The position a completed seek still owes the screen a picture for, or -1.
   *
   * A seek that finishes WITHOUT a frame — the forced completion, when the
   * demuxer ran out or the deadline fired before the walk reached the target —
   * leaves the player paused (or ended) with nothing new on the canvas. The
   * frames it was waiting for usually arrive a moment later, out of a decoder
   * that was still working, and the state gate below drops every one of them
   * because by then the state is "paused" and waitingForVideoSync is false.
   * Nothing else ever puts them up: the presentation loop is stopped while
   * paused, so the picture that was asked for is simply lost.
   *
   * Reported on a 1.33s single-GOP transport-stream segment (seg.ts, 40 frames,
   * one keyframe at 0). Every paused seek there decoded all 40 frames and
   * presented none: the file is short enough that EOF arrives before the
   * decoder has emitted the frames past the target, so the forced completion
   * always won the race. Playing the same file works, because "playing" holds
   * the gate open.
   */
  private _pictureOwedFrom: number = -1;
  /**
   * A video-only resume point, for when the picture has to catch up to sound
   * that never stopped (see resyncVideoToAudio).
   *
   * seekTargetTime serves both streams, and there it has to sit at the END of
   * the audio the renderer has already scheduled, or the re-demuxed packets
   * behind it get decoded a second time and the sound fast-forwards. That end
   * is seconds ahead of what anyone is hearing — measured at six — and holding
   * the PICTURE to it meant the frame the viewer asked for waited for a moment
   * that had not been reached yet. Video has no such history to protect: it
   * resumes where the sound actually IS.
   *
   * -1 means no video-only resume is in flight and the shared target applies.
   * Otherwise this owns the video gate for the rest of the catch-up, dropping
   * to -Infinity once the first frame lands — the frames AFTER that one are
   * still behind the audio schedule's end, and handing the gate back to the
   * shared target would drop every one of them until the sound caught up to a
   * point it had only buffered, not played.
   */
  private _videoResumeTarget: number = -1;
  /** When the catch-up above began, so the UI can tell a hitch nobody notices
   *  from a wait worth putting a spinner on. */
  private _videoCatchUpStartedAt = 0;

  // While a seek waits for its first video frame, audio is not fed: it stays in
  // audioQueue until notifySeekCompletion has decided where the clock starts.
  private waitingForVideoSync: boolean = false;
  // Safety bounds for a seek whose first video frame never arrives (decode
  // stuck, unseekable/indexless stream, WASM decode error, etc).
  // SEEK_MAX_DEMUX_AHEAD caps how far past the target we demux before pausing
  // reads (media seconds); SEEK_SYNC_HARD_TIMEOUT_MS is the terminal backstop
  // that force-completes the seek so playback can't hang forever. Neither
  // triggers on a healthy seek — the first frame normally arrives within ~1
  // GOP.
  private static readonly SEEK_MAX_DEMUX_AHEAD_SECONDS = 8;
  private static readonly SEEK_SYNC_HARD_TIMEOUT_MS = 12000;
  // performance.now() when the current seek armed waitingForVideoSync (0 = not
  // waiting). Drives the hard-timeout watchdog so a frame-starved seek can't
  // hang or download forever.
  private seekSyncArmedAt: number = 0;
  // Newest packet timestamp (media seconds) demuxed since the seek armed; used
  // to cap read-ahead while waiting for the first post-seek video frame.
  private seekDemuxAheadTime: number = -1;

  // Post-seek throttling to prevent stuttering on low-end devices
  private justSeeked: boolean = false;
  private seekTime: number = 0;
  private startTime: number = 0; // Media start time (PTS offset)
  // Per-seek "keyframe jump" offset. FFmpeg lands on the nearest keyframe
  // at-or-after the seek target, which on long-GOP containers (.ts mainly)
  // can be seconds beyond what the user asked for. Reporting the raw time
  // then makes the timeline jump from 0:00 → 0:02 right after a seek to 0.
  // Track the gap and subtract it from getCurrentTime() so the UI stays
  // pinned to what the user requested. Reset on every new seek.
  private seekKeyframeOffset: number = 0;
  private static readonly POST_SEEK_THROTTLE_MS = 1000; // Throttle aggressive buffering for 1000ms after seek to stabilize playback

  // Pause-time buffering: continue demuxing while paused so seek within buffered
  // area is instant and playback resumes without stall (like YouTube).
  // YouTube buffers ~2-5 minutes ahead while paused, then stops.
  private pauseBufferTimerId: number | null = null;
  private static readonly PAUSE_BUFFER_INTERVAL_MS = 100; // Demux every 100ms while paused
  private static readonly PAUSE_BUFFER_SECONDS = 180; // ~3 minutes ahead (YouTube-like), within MAX_QUEUE_BYTES

  constructor(config: PlayerConfig) {
    super();

    this.config = config;
    this._audioOnly = !!config.audioOnly;
    this.cache = new LRUCache(config.cache?.maxSizeMB ?? 100);
    this.trackManager = new TrackManager();
    this.clock = new Clock();
    this.stateManager = new PlayerStateManager();

    // Disable FFmpeg logs by default
    updateAllBindingsLogLevel(LogLevel.SILENT);

    // Initialize components
    this.audioDecoder = new MoviAudioDecoder();
    this.audioRenderer = new AudioRenderer();
    this.audioRenderer.setOnContextRecovered(() =>
      this.onAudioContextRecovered(),
    );
    this.subtitleDecoder = new SubtitleDecoder();

    // Initialize video renderer with canvas (WebCodecs)
    // Note: MSE mode is handled by MSEPlayerWrapper
    // Check if software decoding is forced via config
    const forceSoftware = config.decoder === "software";

    if (config.canvas || config.renderer === "canvas") {
      if (config.canvas) {
        // Use canvas with WebCodecs (or WASM software if forced)
        this.videoDecoder = new MoviVideoDecoder(forceSoftware);
        this.videoRenderer = new CanvasRenderer(config.canvas);
        // A source that OPENS in data-saver (the adaptive path reloads into
        // exactly that) has a configured video track and no picture. Say so
        // now, or the renderer spends the track believing one is coming.
        this.videoRenderer.setPictureSuspended(this._audioOnly);

        // The picture is shown against the same time source the clock reads
        // (see core/TimeSource.ts): the sound while there is some, a wall clock
        // continuing from it otherwise. With audio disabled the clock simply
        // never has an audio side, and the picture runs on the wall clock alone.
        this.videoRenderer.setTimeSource(
          this.clock.timeSource,
          this.disableAudio
            ? null
            : () => this.audioRenderer.hasHealthyBuffer(),
        );
        if (this.disableAudio) {
          Logger.info(
            TAG,
            "Video renderer running on the wall clock (audio disabled)",
          );
        }

        // When the renderer decides the device can't hold the source frame
        // rate and caps presentation, shed load two ways:
        //   1) Software decode: skip non-reference frames to cut CPU (no-op on
        //      hardware — the present-side cap is the only lever there).
        //   2) Under Auto quality: drop a resolution rung. This is the real
        //      relief for a device that simply can't decode the current
        //      resolution (network fine, buffer full, frames dropping) — the
        //      plain ABR is network-only and never reacts to a decode bottleneck.
        this.videoRenderer.setOnPerformanceDegrade(() => {
          this._perfSkipLatched = true;
          this.videoDecoder?.setPerformanceSkip(true);
          this.abrDeviceDownshift();
        });
        // Don't let the perf/decode-bound detector run while backgrounded — a
        // throttled rAF stalls framesPresented and would false-fire a downshift
        // (and, worse, a session resolution cap) on a capable device. PiP still
        // measures: there the video is actually visible and rendering.
        this.videoRenderer.setShouldMeasurePerf(
          () => !(this.isBackgrounded && !this.isPiPActive),
        );
        // Lets the perf detectors tell a slow decoder from a starved one — see
        // setVideoBacklogProvider. Read live rather than cached: the queue
        // drains and refills between windows.
        // …and "the decoder has work" is not true of a decoder waiting for a
        // keyframe, or of one whose next bytes are still on the wire. Counted
        // as backlog, a picture frozen by a window that had lost its keyframe
        // (a catch-up seek, then the wait for the GOP to arrive) read as
        // "0/60fps with healthy audio" and capped 8K for the session on a
        // machine that had been decoding it at full rate.
        this.videoRenderer.setVideoBacklogProvider(() =>
          this._videoHoldingForKeyframe || this.deliveryStarved()
            ? 0
            : (this.videoDecoder?.queueSize ?? 0),
        );

        Logger.info(
          TAG,
          `Video renderer initialized with canvas (forceSoftware: ${forceSoftware})`,
        );
      } else {
        Logger.warn(
          TAG,
          "Canvas renderer requested but no canvas element provided",
        );
        this.videoDecoder = new MoviVideoDecoder(forceSoftware);
      }
    } else {
      // Default to software decoding with WebCodecs (no target element)
      this.videoDecoder = new MoviVideoDecoder(forceSoftware);
      Logger.info(
        TAG,
        "Video renderer initialized with default (WebCodecs decoder only)",
      );
    }

    // Connect audio as the master clock provider (skip if audio disabled)
    if (!this.disableAudio) {
      this.clock.setAudioProvider(this.audioRenderer);
    } else {
      // When audio is disabled, clock runs independently without audio sync overhead
      this.clock.setAudioProvider(null);
      Logger.info(TAG, "Clock running independently (audio disabled)");
    }

    // Setup decoder outputs
    if (this.videoDecoder) {
      this.wireVideoDecoder(this.videoDecoder);
    }

    this.audioDecoder.setOnData((data) => this.renderDecodedAudio(data));

    this.audioDecoder.setOnPCM((frame) => this.renderDecodedPCM(frame));

    this.audioDecoder.setOnError((error) => {
      Logger.error(TAG, "Audio decoder error", error);
      // Audio errors are less fatal - video can continue, just emit the error
      this.emit("error", error);
    });
    this.audioDecoder.setOnBroken(() => void this.recoverBrokenAudio());

    // Forward state changes
    this.stateManager.on("change", (state) => {
      this.emit("stateChange", state);
    });

    // Forward track changes
    // Listen for audio track changes and immediately reconfigure decoder
    this.trackManager.on("audioTrackChange", async (track) => {
      if (!track) {
        Logger.warn(TAG, "Audio track change event received but track is null");
        return;
      }

      Logger.info(
        TAG,
        `Audio track changed to track ${track.id}, reconfiguring decoder`,
      );

      // Drop what the old track left in the decoder. The decoder object (and
      // the software worker inside it) is kept: it is reconfigured below, not
      // rebuilt, so the switch does not pay the worker start-up again.
      this.audioDecoder.reset();

      // Re-anchor AudioRenderer/Clock at the current position BEFORE the new
      // decoder starts producing output — see realignAudioTimelineForTrackSwitch's
      // doc comment. Must happen here (old decoder reset, new track not yet
      // configured) so the old track's already-scheduled audio is dropped
      // cleanly and the new track's first buffer lands on a fresh anchor.
      this.realignAudioTimelineForTrackSwitch();

      const rebuildAudio = !!this.demuxer && !this.disableAudio;
      const switchId = ++this._audioSwitchId;
      if (rebuildAudio) {
        this._audioSwitching = true;
        this._audioDecoderConfiguring = true;
        this._audioStartAlign = true;
      }

      this.traceAudioSwitch("decoder-reset", {});

      // Re-apply demuxer discard: re-enable the newly-selected audio track and
      // discard the previously-active one (issue #11) — and in the same breath
      // put the demuxer back to just before the playhead. Flipping discard is
      // not enough on its own: the track being re-enabled was, until this
      // moment, skipped inside av_read_frame (for Matroska, an avio_skip over
      // the cluster body), so there is no packet of it to be had at the current
      // file position, and the read loop would scan FORWARD looking for one
      // (measured: 60-100s of real media, 8.9-21.4 MB over the network; the
      // first packet the new decoder was then handed carried that far-ahead
      // PTS and Clock hard-synced onto it). This is issued BEFORE the new
      // decoder is awaited, not after: the old order left the loop scanning
      // for the whole configure (4.5s for a worker AAC decoder on loopback,
      // while the scan hit EOF in 70ms).
      this.applyStreamDiscard();
      const refreshed = rebuildAudio
        ? this.refreshDemuxerForAudioSwitch()
        : Promise.resolve();

      // Configure decoder for new track
      let configured = false;
      try {
        if (this.demuxer && !this.disableAudio) {
          const extradata = this.demuxer.getExtradata(track.id) ?? undefined;
          this.traceAudioSwitch("decoder-configure-start", {});
          configured = await this.audioDecoder.configure(track, extradata);
          if (this.switchTraceActive) {
            const worker = this.audioDecoder.getStats().worker;
            this.traceAudioSwitch("decoder-configured", {
              ok: configured,
              workerConfigureMs: worker?.configureMs ?? -1,
              wasmLoadMs: worker?.wasmLoadMs ?? -1,
              workerAgeMs: worker?.workerAgeMs ?? -1,
              queuedAudioPackets: this.audioQueue.length,
            });
          }
          if (configured) {
            Logger.info(
              TAG,
              `Audio decoder reconfigured for track ${track.id}: ${track.codec} ${track.sampleRate}Hz ${track.channels}ch`,
            );
            // Re-evaluate the multichannel passthrough policy on every
            // track change — switching from 7.1 TrueHD to stereo AAC
            // (or vice versa) needs the destination channelCount and
            // the WASM downmix flag to follow the new track. The
            // AudioRenderer was already initialised before the first
            // track configure landed, so reading max channels here is
            // cheap and sync.
            const sourceCh = track.channels ?? 2;
            const maxCh = this.audioRenderer.getMaxChannelCount();
            if (sourceCh > 2 && maxCh >= sourceCh) {
              this.audioDecoder.setDownmix(false);
              this.audioRenderer.setOutputChannelCount(sourceCh);
            } else {
              this.audioDecoder.setDownmix(true);
              this.audioRenderer.setOutputChannelCount(2);
            }
          } else {
            Logger.warn(
              TAG,
              `Failed to reconfigure audio decoder for track ${track.id}`,
            );
          }
        }
      } finally {
        if (switchId === this._audioSwitchId) {
          this._audioDecoderConfiguring = false;
          // A decoder that never came up will never deliver the sound being
          // waited for; the ordinary stall handling takes over from here.
          if (!configured) {
            this._audioSwitching = false;
            this._audioStartAlign = false;
          }
        }
      }

      await refreshed;
    });

    this.trackManager.on("tracksChange", (tracks) => {
      this.emit("tracksChange", tracks);
    });

    Logger.info(TAG, "Player created");

    // Handle visibility changes to re-acquire WakeLock if lost
    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    // Handle network recovery: re-seek to current position to restart cleanly
    window.addEventListener("online", this.handleNetworkOnline);
  }

  /**
   * Load the media file
   */
  async load(sourceConfig?: SourceConfig): Promise<void> {
    if (!this.stateManager.is("idle") && !sourceConfig) {
      throw new Error("Player must be idle to load");
    }

    // …and its own previews: the frames remembered for the last one are not
    // this one's picture at those times.
    this.clearPreviewCache();

    // A verdict about the previous source's encryption says nothing about this
    // one; the fallback sets it again if this source earns it.
    this._sourceIsEncrypted = false;
    this._encryptedGaveUp = false;
    this._encryptedAudioSilenced = false;

    if (sourceConfig) {
      this.config.source = sourceConfig;
      // New source on a reused instance: re-arm the startup grace so its first
      // buffer fill gets the same protection a fresh instance would get.
      this._playbackStartedAt = performance.now();
      // If we were not idle, we should essentially reset/destroy previous state if reusing instance
      // But for now, let's assume usage pattern respects idle check or we force reset
      if (this.stateManager.getState() !== "idle") {
        // Reset internal state if reloading on same instance
        // Ideally calls destroy() -> new MoviPlayer() is better, but here we can try to soft-reset
      }
    }

    this.stateManager.setState("loading");
    this.emit("loadStart", undefined);
    this.lastBufferedTime = 0;
    this.bufferedRangeStart = 0;
    this._loopCount = 0;

    // Drop the previous source's cover art so a soft-reload on the same
    // instance (no destroy) doesn't keep showing stale artwork when the
    // new source has none.
    this.coverArt?.close?.();
    this.coverArt = null;

    // Clean up any existing preview pipeline
    this.destroyPreviewPipeline();

    // The new source gets its own shot at a missing duration.
    if (this._durationRescanTimer) {
      clearTimeout(this._durationRescanTimer);
      this._durationRescanTimer = null;
    }
    this._durationRescanDone = false;

    // Adaptive streaming — only when the caller used SourceConfig (a custom
    // SourceAdapter bypasses URL detection entirely). HLS (.m3u8) and DASH
    // (.mpd) both go through Shaka Player (one engine, MSE under the hood). This
    // covers multiplexed DASH too — Shaka plays it natively, so there's no
    // FFmpeg fallback to fork on here.
    const src = this.config.source;
    const streamUrl =
      // A registered custom scheme (s3://…) is read via its SourceAdapter, which
      // the HLS/DASH (MSE) engines can't use — they fetch the URL directly. Keep
      // such URLs off the stream path so they reach the demuxer + adapter below.
      !this.config.sourceAdapter &&
      src &&
      src.type === "url" &&
      src.url &&
      !getSourceAdapterFactory(src.url)
        ? src.url
        : null;
    const lowerUrl = streamUrl?.toLowerCase() ?? "";
    // HLS (.m3u8), DASH (.mpd), and Smooth Streaming (.ism/.isml) all go
    // through Shaka. `.ism` also matches `.isml/manifest`.
    // `forceStream` is the same question answered by the server rather than by
    // the URL — a manifest whose path says nothing (see the option's note).
    const forced = this.config.forceStream;
    const isStream =
      !!streamUrl &&
      (lowerUrl.includes(".m3u8") ||
        lowerUrl.includes(".mpd") ||
        lowerUrl.includes(".ism") ||
        !!forced);

    if (isStream) {
      // Declared subtitle files belong to the video, not to the engine that
      // plays it. Only the demuxer path used to register them, so on a stream
      // engine getSubtitleLangs() was empty and the files could not be picked.
      if (this.config.subtitleTracks && this.config.subtitleTracks.length > 0) {
        this._subtitleTracks = [...this.config.subtitleTracks];
      }
      const isHls = lowerUrl.includes(".m3u8") || forced === "hls";
      const isDash = lowerUrl.includes(".mpd") || forced === "dash";
      const kind = isHls
        ? "HLS"
        : lowerUrl.includes(".ism")
          ? "Smooth Streaming"
          : "DASH";

      // Forward track selections from the main TrackManager to whichever stream
      // wrapper is currently active (added once; resolves the live field).
      this.trackManager.on("videoTrackChange", (track) => {
        this.streamWrapper?.selectVideoTrack(track ? track.id : -1);
      });
      this.trackManager.on("audioTrackChange", (track) => {
        if (track) this.streamWrapper?.selectAudioTrack(track.id);
      });
      this.trackManager.on("subtitleTrackChange", (track) => {
        this.streamWrapper?.selectSubtitleTrack(track ? track.id : null);
      });

      // Force-demux: a prior MSE attempt failed at RUNTIME on a codec the
      // browser can't decode (e.g. Safari rejecting a HE-AAC track → Shaka
      // error 3014). Skip the MSE stream engines entirely and play the
      // single-file DASH Representation through the FFmpeg-WASM demuxer, which
      // decodes every codec. Only single-file DASH (BaseURL + optional
      // SegmentBase) works — analyzeDashFallback returns null for multi-segment,
      // in which case we fall back to the normal stream path below.
      if (this.config.forceStreamDemux && isDash) {
        try {
          const plan = await analyzeDashFallback(
            streamUrl!,
            src?.headers,
            this.lifetimeSignal,
          );
          if (plan) {
            this._sourceIsEncrypted = !!plan.encrypted;
            // Nothing here can recover, so don't spend fifty failed packets
            // discovering it — see AudioDecoder.setFailFast.
            if (plan.encrypted) this.audioDecoder.setFailFast(true);
            Logger.info(
              TAG,
              "forceStreamDemux: MSE failed at runtime — routing this DASH source through the FFmpeg demuxer",
            );
            // Remember the renditions for the demuxer-mode quality menu, and
            // honor a user-picked one (forceVideoRendition) over the best.
            this._dashRenditions = plan.videoTracks ?? [];
            const videoUrl =
              (this.config.forceVideoRendition &&
                this._dashRenditions.some(
                  (r) => r.url === this.config.forceVideoRendition,
                ) &&
                this.config.forceVideoRendition) ||
              plan.videoUrl;
            this._activeDashRendition = videoUrl;
            this.source = await this.createSource({
              type: "url",
              url: videoUrl,
              headers: src?.headers,
            });
            // Prefer the full audio menu (languages / bitrate variants) when the
            // manifest has more than one; else the single best audio file.
            if (plan.audioTracks?.length) {
              this.config.audioTracks = plan.audioTracks.map((t) => ({
                url: t.url,
                lang: t.lang,
                label: t.label,
              }));
            } else if (plan.audioUrl) {
              this.config.audioSource = {
                type: "url",
                url: plan.audioUrl,
                headers: src?.headers,
              };
            }
            // Carry the manifest's caption files across as external subtitle
            // tracks so the demuxer path keeps the CC the stream engine had.
            if (plan.subtitles?.length) {
              this.config.subtitleTracks = plan.subtitles.map((s) => ({
                url: s.url,
                lang: s.lang,
                label: s.label,
                format: s.format,
              }));
            }
          } else {
            Logger.warn(
              TAG,
              "forceStreamDemux: manifest is multi-segment — demuxer can't play it, retrying the stream path",
            );
          }
        } catch (eDemux) {
          Logger.warn(
            TAG,
            "forceStreamDemux: DASH fallback probe failed",
            eDemux,
          );
        }
      }

      // Force-demux (HLS): both MSE engines failed a codec the browser can't
      // decode. HLS has no single demuxable file, so parse the playlist and
      // present its segments to the FFmpeg-WASM demuxer as one concatenated,
      // seekable stream (SegmentStreamSource). Alternate audio languages become
      // split-audio tracks (each its own segment stream); segmented WebVTT
      // subtitle renditions are concatenated into external subtitle tracks.
      if (this.config.forceStreamDemux && isHls && !this.source) {
        try {
          const plan = await analyzeHlsFallback(
            streamUrl!,
            src?.headers,
            this.config.forceVideoRendition,
            this.lifetimeSignal,
          );
          if (plan) {
            this._sourceIsEncrypted = !!plan.encrypted;
            // Nothing here can recover, so don't spend fifty failed packets
            // discovering it — see AudioDecoder.setFailFast.
            if (plan.encrypted) this.audioDecoder.setFailFast(true);
            Logger.info(
              TAG,
              `forceStreamDemux: routing HLS through the FFmpeg demuxer (${plan.segments.length} video segments)`,
            );
            // Quality menu: reuse the demuxer-mode rendition machinery (shared
            // with DASH) — the variant playlists are the selectable qualities.
            this._dashRenditions = plan.videoTracks ?? [];
            this._activeDashRendition = plan.selectedVariant ?? "";
            // Video (or muxed) stream.
            this.source = new SegmentStreamSource(
              plan.segments,
              plan.initSegment,
              streamUrl!,
              src?.headers,
            );

            // Separate audio languages → split-audio tracks, each backed by its
            // own segment stream (default language first). SegmentStreamSource
            // is lazy, so building them all costs nothing until one is selected.
            if (plan.audioRenditions?.length) {
              const ordered = [...plan.audioRenditions].sort(
                (a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0),
              );
              this.config.audioTracks = ordered.map((r, i) => {
                const key = `${streamUrl}#audio-${r.lang}-${i}`;
                return {
                  url: key,
                  lang: r.lang,
                  label: r.label,
                  adapter: new SegmentStreamSource(
                    r.segments,
                    r.initSegment,
                    key,
                    src?.headers,
                  ),
                };
              });
            }

            // Segmented WebVTT subtitle renditions → one concatenated VTT blob
            // per language, carried as external subtitle tracks. Cache by stream
            // URL: the subtitles are quality-independent, so a quality switch
            // reuses the blobs instead of re-fetching every VTT segment (the
            // main switch-latency cost).
            if (plan.subtitleRenditions?.length) {
              let subs = MoviPlayer._hlsSubtitleCache.get(streamUrl!);
              if (!subs) {
                subs = await this.buildHlsSubtitleTracks(
                  plan.subtitleRenditions,
                  src?.headers,
                );
                if (subs.length)
                  MoviPlayer._hlsSubtitleCache.set(streamUrl!, subs);
              }
              if (subs.length) this.config.subtitleTracks = subs;
            }
          } else {
            Logger.warn(
              TAG,
              "forceStreamDemux: HLS playlist not demuxable, retrying the stream path",
            );
          }
        } catch (eDemux) {
          Logger.warn(
            TAG,
            "forceStreamDemux: HLS fallback probe failed",
            eDemux,
          );
        }
      }

      // --- Force a specific MSE engine (hls.js / dash.js), skipping Shaka. Set
      // when Shaka failed at RUNTIME but the other engine is more lenient with
      // the stream — e.g. a manifest-vs-actual codec mismatch Shaka rejects but
      // dash.js plays (hardware, lightweight). Preferred over the WASM demuxer,
      // which is the last resort. If this engine also can't LOAD, fall through
      // to Shaka/demuxer below; if it loads but fails at runtime, the element
      // escalates to force-demux (WASM). ---
      if (!this.source && this.config.forceStreamEngine && (isHls || isDash)) {
        try {
          const engine = this.config.forceStreamEngine;
          const fb =
            engine === "hlsjs"
              ? new HLSPlayerWrapper(this.config)
              : new DASHPlayerWrapper(this.config);
          this.streamWrapper = fb;
          this.wireStreamWrapper(fb);
          Logger.info(TAG, `forceStreamEngine: playing ${kind} via ${engine}`);
          await fb.load();
          this.stateManager.setState("ready");
          return;
        } catch (eEngine) {
          Logger.warn(
            TAG,
            `forceStreamEngine (${this.config.forceStreamEngine}) failed to load; falling through`,
            eEngine,
          );
          try {
            this.streamWrapper?.destroy();
          } catch {}
          this.streamWrapper = null;
        }
      }

      // --- Tier 1: Shaka (HLS + DASH + MSS + muxed). Skipped when force-demux
      // above already resolved a demuxable single-file source. ---
      if (!this.source)
        try {
          const shaka = new ShakaPlayerWrapper(this.config);
          this.streamWrapper = shaka;
          this.wireStreamWrapper(shaka);
          Logger.info(TAG, `Detected ${kind} stream, using ShakaPlayerWrapper`);
          await shaka.load();
          this.stateManager.setState("ready");
          return;
        } catch (eShaka) {
          Logger.warn(TAG, `Shaka failed on ${kind} stream`, eShaka);
          try {
            this.streamWrapper?.destroy();
          } catch {}
          this.streamWrapper = null;

          // Did the engines turn this down for want of a LICENCE, as opposed to
          // any of the other reasons they turn a stream down? It decides what the
          // demuxer tier below is allowed to do with encrypted media — see the
          // note where it is read.
          let drmRefused = looksLikeDrmFailure(eShaka);

          // --- Tier 2: hls.js / dash.js. Their MSE engines play streams Shaka
          // rejects (e.g. under-specified single-file DASH the browser demuxer
          // handles but Shaka/FFmpeg won't). ---
          if (isHls || isDash) {
            try {
              const fb = isHls
                ? new HLSPlayerWrapper(this.config)
                : new DASHPlayerWrapper(this.config);
              this.streamWrapper = fb;
              this.wireStreamWrapper(fb);
              Logger.info(
                TAG,
                `Shaka failed; retrying with ${isHls ? "hls.js" : "dash.js"}`,
              );
              await fb.load();
              this.stateManager.setState("ready");
              Logger.info(TAG, `Recovered via ${isHls ? "hls.js" : "dash.js"}`);
              return;
            } catch (eFallback) {
              Logger.warn(
                TAG,
                `${isHls ? "hls.js" : "dash.js"} fallback also failed`,
                eFallback,
              );
              drmRefused = drmRefused || looksLikeDrmFailure(eFallback);
              try {
                this.streamWrapper?.destroy();
              } catch {}
              this.streamWrapper = null;
            }
          }

          // --- Tier 3: FFmpeg demuxer for bare-<BaseURL> single-file DASH that
          // even the MSE engines refuse (e.g. muxed single-file). Falls through
          // to the demuxer path below with the video file as the source (+ the
          // separate audio file as a native-audio source for demuxed content). ---
          let fellBack = false;
          if (isDash) {
            try {
              const plan = await analyzeDashFallback(
                streamUrl!,
                src?.headers,
                this.lifetimeSignal,
              );
              // Encrypted, and we are only here because a licence was refused: the
              // answer is already known, so don't spend the viewer's attention
              // discovering it. A packager's clear lead exists to cover the wait
              // for a licence, not to be watched on its own — playing it would put
              // a few seconds of video up and then stop, which reads as the player
              // breaking rather than as content that was never going to play.
              //
              // Only when the licence is the reason. Arriving here for any other
              // reason (a forced engine, an MSE runtime failure) leaves the
              // encrypted flag to the decode-time path, which still plays whatever
              // is clear — the escape hatch for a manifest that declares
              // ContentProtection over media that turns out not to need it.
              if (plan?.encrypted && drmRefused) {
                Logger.info(
                  TAG,
                  "Encrypted manifest and the licence was refused — not opening it in the demuxer",
                );
                throw new Error(
                  "This video is protected and needs a licence to play here.",
                );
              }
              if (plan) {
                this._sourceIsEncrypted = !!plan.encrypted;
                // Nothing here can recover, so don't spend fifty failed packets
                // discovering it — see AudioDecoder.setFailFast.
                if (plan.encrypted) this.audioDecoder.setFailFast(true);
                Logger.info(TAG, "Falling back to the FFmpeg demuxer");
                this.source = await this.createSource({
                  type: "url",
                  url: plan.videoUrl,
                  headers: src?.headers,
                });
                if (plan.audioTracks?.length) {
                  this.config.audioTracks = plan.audioTracks.map((t) => ({
                    url: t.url,
                    lang: t.lang,
                    label: t.label,
                  }));
                } else if (plan.audioUrl) {
                  this.config.audioSource = {
                    type: "url",
                    url: plan.audioUrl,
                    headers: src?.headers,
                  };
                }
                if (plan.subtitles?.length) {
                  this.config.subtitleTracks = plan.subtitles.map((s) => ({
                    url: s.url,
                    lang: s.lang,
                    label: s.label,
                    format: s.format,
                  }));
                }
                fellBack = true; // fall through to the demuxer path below
              }
            } catch (eDemux) {
              Logger.warn(TAG, "FFmpeg DASH fallback failed", eDemux);
            }
          }
          if (!fellBack) {
            this.stateManager.setState("error");
            throw eShaka; // surface the original Shaka error
          }
        }
    }

    try {
      // Silence whatever is still queued from the LAST source before opening
      // this one. Every other transition already does this — seek, replay, an
      // audio-language switch — but loading a new source did not, and the
      // renderer happily played out its remaining buffer while the new file
      // was still opening. What that sounds like is a second of the previous
      // song after you have chosen a different one; it is loudest on a phone,
      // where the open takes longer and there is no video swap to cover it.
      this.audioRenderer.reset();
      if (this.videoRenderer) this.videoRenderer.clearQueue();

      // Create source — honor a pre-built adapter if the caller supplied
      // one (custom protocol, encrypted blob, IndexedDB-backed source, etc.)
      // so the demuxer can read through it without going through SourceConfig.
      if (this.source) {
        // Already resolved (defensive — a prior load may have set it).
      } else if (this.config.sourceAdapter) {
        this.source = this.config.sourceAdapter;
      } else if (this.config.source) {
        this.source = await this.createSource(this.config.source);
      } else {
        throw new Error(
          "Either config.source or config.sourceAdapter is required",
        );
      }

      // Which separate audio source to open, decided from config alone so the
      // decision can be made BEFORE the video demuxer opens — see below.
      let audioUrl: string | null = null;
      let audioAdapter: SourceAdapter | undefined;
      if (this.config.audioTracks && this.config.audioTracks.length > 0) {
        this._audioTracks = [...this.config.audioTracks];
        this._activeAudioLang = this._audioTracks[0].lang;
        audioUrl = this._audioTracks[0].url;
        audioAdapter = this._audioTracks[0].adapter;
        Logger.info(
          TAG,
          `Multi-language audio: ${this._audioTracks.length} tracks, default=${this._activeAudioLang}`,
        );
      } else if (
        this.config.audioSource?.type === "url" &&
        this.config.audioSource.url
      ) {
        audioUrl = this.config.audioSource.url;
      }
      this._splitAudioRetries = 0; // fresh source → fresh retry budget

      // Create demuxer (getSize will be called lazily in bindings.open())
      this.demuxer = new Demuxer(this.source, this.config.wasmBinary);

      // The split-audio demuxer is a separate WASM instance reading a separate
      // file — none of it needs the video to be open first. Run it alongside:
      // measured, audio started 5.6s in and took another 2.8s, all of it after
      // the video demux had finished waiting on its own network. The one thing
      // it genuinely needs is the video's PTS baseline, and it waits for just
      // that (see _videoInfoReady in setupSplitAudio).
      this._videoInfoReady = new Promise<void>((resolve) => {
        this._resolveVideoInfoReady = resolve;
      });
      const splitAudioJob = audioAdapter
        ? this.setupSplitAudio(audioAdapter)
        : audioUrl
          ? this.setupSplitAudio(audioUrl)
          : null;

      // Open and get media info. Released in `finally` so a FAILED open still
      // frees the parallel audio job — otherwise it waits on a baseline that
      // is never coming and the promise never settles.
      try {
        this.mediaInfo = await this.demuxer.open();
      } finally {
        this._resolveVideoInfoReady?.();
      }
      // Destroyed by a rapid source switch during the (WASM + network) open —
      // bail before standing up the split-audio demuxer and decoders.
      if (this._destroyed) return;

      // Cache file size for buffer calculations (getSize was called in bindings.open())
      this.fileSize = await this.source.getSize();

      const bindings = this.demuxer.getBindings();
      if (bindings) {
        this.videoDecoder.setBindings(bindings);
        this.audioDecoder.setBindings(bindings);
        if (this.subtitleDecoder) {
          this.subtitleDecoder.setBindings(bindings);
        }
      }

      // Started before the video open (see above) — collect it here, where the
      // old serial call used to be, so everything downstream is unchanged.
      if (splitAudioJob) await splitAudioJob;
      // A rapid source switch may have destroyed this instance while the second
      // (split-audio) WASM demuxer was loading — bail so we don't configure
      // decoders / render onto the successor's canvas (black-frame flash).
      if (this._destroyed) return;

      // Store external subtitle tracks
      if (this.config.subtitleTracks && this.config.subtitleTracks.length > 0) {
        this._subtitleTracks = [...this.config.subtitleTracks];
        Logger.info(
          TAG,
          `External subtitles: ${this._subtitleTracks.length} tracks`,
        );
      }

      // Set tracks
      this.trackManager.setTracks(this.mediaInfo.tracks);

      // Extract embedded cover art (if any) once the track list is settled.
      // Fire-and-forget: a missing/corrupt artwork stream shouldn't block
      // playback. The eventual emit is what wakes the element-side painter,
      // so callers don't need to await this.
      void this.extractCoverArt();

      // Configure decoders for active tracks
      await this.configureDecoders();

      // Set duration on clock for clamping (prevents timer exceeding duration)
      // Clock operates in media time (PTS), so it runs from startTime to startTime + duration
      this.startTime = this.mediaInfo.startTime || 0;
      this.seekKeyframeOffset = 0;
      this.clock.setDuration(this.mediaInfo.duration + this.startTime);
      this.clock.seek(this.startTime);
      this.declareStreamEnds();

      // Emit duration
      this.emit("durationChange", this.mediaInfo.duration);

      // Prebuffer a small amount of media so play() doesn't immediately
      // stall on short videos (see prebuffer() for details).
      await this.prebuffer();

      this.stateManager.setState("ready");
      this.emit("loadEnd", undefined);

      // Warm the preview pipeline in the background — but NOT right now. It
      // stands up a second isolated WASM + WebCodecs decoder that competes with
      // the main video decoder for the GPU, and doing that during the first
      // seconds of playback is enough to tip a heavy 4K/HDR rung into a
      // frame-rate deficit and get its resolution wrongly capped. Defer the
      // eager warm-up until playback has settled; if the user scrubs before
      // then, the seek path lazy-inits it on demand (initPreviewPipeline is
      // idempotent), so previews still work — they just don't steal decode
      // headroom from a struggling startup.
      this.schedulePreviewWarm(MoviPlayer.PREVIEW_WARM_DELAY_MS);

      // A container that never wrote its duration down gets one more chance,
      // off the load path this time — see rescanDurationInBackground.
      if (!(this.mediaInfo.duration > 0)) this.scheduleDurationRescan();

      Logger.info(
        TAG,
        `Loaded: duration=${this.mediaInfo.duration}s, tracks=${this.mediaInfo.tracks.length}`,
      );
    } catch (error) {
      this.stateManager.setState("error");
      this.emit("error", error as Error);
      throw error;
    }
  }

  /**
   * Create source adapter from config
   */
  private async createSource(config: SourceConfig): Promise<SourceAdapter> {
    if (config.type === "file" && config.file) {
      const fs = new FileSource(config.file, this.cache);
      if (MoviPlayer._isMobileDevice) fs.setFullFilePreload(false);
      fs.setOnRevoked((info) => {
        Logger.error(TAG, `File handle revoked: ${info.reason}`);
        this.emit("filerevoked", info);
      });
      fs.setOnPreloadComplete(() => {
        this.emit("preloadcomplete", undefined);
      });
      return fs;
    }

    if (config.type === "encrypted" && config.encrypted) {
      return new EncryptedHttpSource({
        ...config.encrypted,
        headers: config.headers,
      });
    }

    if (config.type === "url" && config.url) {
      // A custom scheme registered via registerSourceAdapter("s3", …) is built
      // through its factory instead of fetch(), letting the demuxer read bytes
      // from anything the app can supply (S3, IPFS, WebSocket, IndexedDB, …).
      const factory = getSourceAdapterFactory(config.url);
      if (factory) {
        return await factory({ url: config.url, headers: config.headers });
      }
      const maxBufferSizeMB = this.config.cache?.maxSizeMB;
      const source = new HttpSource(
        config.url,
        config.headers,
        maxBufferSizeMB,
      );
      // Server has no Range support + file too big to cache → forward-only
      // linear playback. Surface it so the UI can drop the timeline / seeking.
      source.setOnLinearMode(() => this.emit("linearmode", undefined));
      return source;
    }

    throw new Error("Invalid source configuration");
  }

  /**
   * Configure decoders for active tracks
   */
  /**
   * A+ verify-then-swap quality switch for the demuxer fallback (HLS/DASH).
   * Instead of tearing the player down and reloading, prepare the new
   * rendition's demuxer (open + seek to the current position) WHILE the old one
   * keeps playing, then atomically swap the video source/demuxer and reconfigure
   * the video decoder. Audio, subtitles, the clock and the AudioContext are
   * never touched — only the video briefly freezes on the last frame (no black
   * flash, no audio gap, no loading). Uses one decode pipeline at a time (the
   * new demuxer opens on an isolated WASM module so it doesn't clash with the
   * old during prep, but the video decoder only reconfigures at swap-time), so
   * memory stays flat. Returns false (staying on the current rendition) if the
   * new one can't be prepared, so a failed switch never breaks playback.
   */
  async switchVideoRenditionInPlace(newRenditionUrl: string): Promise<boolean> {
    if (this._destroyed) return false;
    if (!this.demuxer || !this.videoDecoder) return false;
    if (newRenditionUrl === this._activeDashRendition) return true;
    // Only safe when audio is a SEPARATE (split) source: the swap replaces just
    // the video demuxer/decoder and leaves audio running. If audio is muxed into
    // the main source, swapping it would drop the audio — let the caller fall
    // back to a full reload instead.
    if (!this.audioDemuxer) return false;

    const cfgSrc = this.config.source;
    const srcUrl = cfgSrc && "url" in cfgSrc && cfgSrc.url ? cfgSrc.url : "";
    // Tell the UI a swap is under way. It has to be paired with an end event on
    // EVERY exit below, including the early bails, or the indicator it drives
    // would be left running over a player that is doing nothing.
    const switchLabel = this._dashRenditions.find(
      (r) => r.url === newRenditionUrl,
    )?.label;
    // The start event is NOT emitted here. Everything up to the atomic swap is
    // prep — opening and seeking the new demuxer, off the current pipeline —
    // and the old rendition keeps playing throughout, untouched. Announcing a
    // switch during it put a loading indicator over a picture that was running
    // perfectly, for however long the network took, and then cleared it at the
    // return below — which is BEFORE the new frames reach the screen. So the
    // indicator covered the calm part and was gone by the time the picture
    // actually jumped. It goes up at the swap instead, and comes down when the
    // first new frame is painted.
    let indicatorOn = false;
    // The end can arrive late (it waits for the first painted frame) while a
    // NEXT switch has already raised its own indicator. Stamp each one so a
    // straggler can only ever clear the indicator it put up.
    let myIndicator = 0;
    const beginSwitchIndicator = () => {
      if (indicatorOn) return;
      indicatorOn = true;
      myIndicator = ++this._switchIndicatorGen;
      this.emit("renditionSwitch", { active: true, label: switchLabel });
      // Bound streams stop together, and this is the one place the picture
      // stops on purpose. The swap is seamless by design — only the video
      // pipeline is replaced, so the sound was never interrupted — but that
      // design is exactly what a binding says no to: on a slow link the new
      // rendition's first frame can be a second or more away, and what the
      // viewer gets is a frozen picture with a spinner over it while the sound
      // and the clock run on. Hold everything for the swap, and let the normal
      // resume gate start it again when frames are actually arriving.
      //
      // Marked self-inflicted: this is our own stall, not a starved pipeline,
      // so it resumes on readiness instead of serving the 1.5s cushion meant
      // for a decoder that fell behind. A switch that bails leaves the old
      // rendition's queue intact, so the gate finds video ready and lets go
      // immediately.
      if (this._bindAV && this.stateManager.is("playing")) {
        this.wasPlayingBeforeRebuffer = true;
        this._bufferingSelfInflicted = true;
        this.stateManager.setState("buffering");
        this.clock.pause();
        this.audioRenderer?.suspendForBuffering();
        this.videoRenderer?.stopPresentationLoop();
      }
    };
    // A step DOWN is a rescue on a link that is already short, and the rung
    // being left keeps downloading through the whole prep — measured at
    // 0.12 MB/s, the 2160p stream took a fresh 4MB range in the middle of a
    // switch to 240p, so the rung we were escaping to got half of a link that
    // could not feed either. Hold the outgoing source's download while the
    // lower rung opens; every exit lets it go (endSwitch), and on success the
    // old source is closed anyway.
    const targetBwEarly =
      this._dashRenditions.find((r) => r.url === newRenditionUrl)?.bandwidth ??
      0;
    const activeBwEarly =
      this._dashRenditions.find((r) => r.url === this._activeDashRendition)
        ?.bandwidth ?? 0;
    const stepDown =
      targetBwEarly > 0 && activeBwEarly > 0 && targetBwEarly < activeBwEarly;
    const heldSource = stepDown
      ? (this.source as {
          suspendNetwork?: () => void;
          resumeNetwork?: () => void;
        } | null)
      : null;
    heldSource?.suspendNetwork?.();
    const endSwitch = <T>(result: T): T => {
      heldSource?.resumeNetwork?.();
      if (indicatorOn && myIndicator === this._switchIndicatorGen) {
        indicatorOn = false;
        this.emit("renditionSwitch", { active: false, label: switchLabel });
      }
      return result;
    };
    const isHls = srcUrl.toLowerCase().includes(".m3u8");
    const headers = this.config.headers;

    // --- PREP (old keeps playing): build + open the new demuxer on an isolated
    // WASM module and seek it to the current position. Any failure here bails
    // out cleanly, leaving the old rendition untouched. ---
    // …and any HANG here bails out too. See SWITCH_PREP_BUDGET_MS: the prep is
    // several unbounded network waits held under a flag that disables every
    // path that could rescue playback, so it needs an end.
    const prepBudgetMs = stepDown
      ? MoviPlayer.SWITCH_DOWN_PREP_BUDGET_MS
      : MoviPlayer.SWITCH_PREP_BUDGET_MS;
    const prepDeadline = performance.now() + prepBudgetMs;
    // Which seek the prep was started against — see the last exit below.
    const seekAtPrep = this._lastSeekAt;
    const prepLeft = () => prepDeadline - performance.now();
    let newSource: SourceAdapter;
    try {
      if (isHls) {
        const variant = await loadHlsVariant(
          newRenditionUrl,
          headers,
          this.lifetimeSignal,
        );
        if (!variant) return endSwitch(false);
        newSource = new SegmentStreamSource(
          variant.segments,
          variant.initSegment,
          newRenditionUrl,
          headers,
        );
      } else {
        newSource = await this.createSource({
          type: "url",
          url: newRenditionUrl,
          headers,
        });
        // Open the rung on a small first read. The 4MB opening is sized for a
        // video's FIRST open — hosts prefetch against it — and a rung switch
        // is not that: all it needs is the header, and the seek that follows
        // starts its own stream at the landing point. At 0.12 MB/s a 4MB
        // opening is 33s against a 12s prep budget, so every downshift to
        // 240p (a 6.5MB file) timed out and left playback stuck on 2160p.
        (
          newSource as unknown as { setFirstRangeBytes?: (n: number) => void }
        ).setFirstRangeBytes?.(MoviPlayer.SWITCH_FIRST_RANGE_BYTES);
      }
    } catch (e) {
      Logger.warn(TAG, "in-place switch: new source build failed", e);
      return endSwitch(false);
    }

    const newDemuxer = new Demuxer(newSource, this.config.wasmBinary, true);
    // From here until the swap adopts them (or a bail closes them), these two
    // are the only pieces of this player that nothing else can reach: they are
    // locals of an async function, so destroy() — which closes `this.source`,
    // `this.audioSource` and the thumbnail source — had no idea they existed.
    // A switch that was still prepping when the player was destroyed therefore
    // kept its stream running: read off one session, the source went on
    // fetching 8MB ranges for another 60.5MB after "Player destroyed" and only
    // stopped when it hit its own download limit. Park them where the teardown
    // can find them.
    this._pendingSwitchSource = newSource;
    this._pendingSwitchDemuxer = newDemuxer;
    const abandonPrep = (reason?: string, e?: unknown): boolean => {
      if (reason) Logger.warn(TAG, `in-place switch: ${reason}`, e);
      try {
        newDemuxer.close();
      } catch {}
      try {
        newSource.close();
      } catch {}
      if (this._pendingSwitchSource === newSource) {
        this._pendingSwitchSource = null;
        this._pendingSwitchDemuxer = null;
      }
      return endSwitch(false);
    };
    let newInfo: MediaInfo;
    try {
      const opened = await withDeadline(newDemuxer.open(), prepLeft());
      if (opened === TIMED_OUT) {
        // The moov never arrived in the budget. On the rung that does this —
        // the one whose bitrate is at or above what the link can carry — the
        // read is not slow, it is losing a race with the stream that is still
        // playing. Abandon, which closes the source and hands the link back.
        return abandonPrep(
          `new demuxer open exceeded ${prepBudgetMs}ms — the link can't feed this rung`,
        );
      }
      newInfo = opened;
    } catch (e) {
      return abandonPrep("new demuxer open failed", e);
    }
    // The player went away while the open was in flight. Everything past this
    // point writes to a torn-down pipeline — one session ran the whole swap
    // against it and got as far as compiling a shader on a destroyed renderer.
    if (this._destroyed) return abandonPrep();
    const newVideoTrack = newInfo.tracks.find((t) => t.type === "video") as
      VideoTrack | undefined;
    if (!newVideoTrack) {
      return abandonPrep();
    }
    const newStartTime = newInfo.startTime || 0;
    // Read the clock HERE, after the open — not before it.
    // Building and opening the new source is a network round trip — on the link
    // that most needs a quality switch it takes seconds, and audio (a separate
    // source, still playing) carries the clock right on through it. Seeking to
    // the stale time starts the new rendition BEHIND the playhead, and the
    // keyframe alignment drags it back further still; the swap then has to
    // fetch and decode that whole deficit ON TOP of realtime, precisely when
    // bandwidth is already the problem. Measured on a 5Mbps link: a 720p50
    // upshift came up 7.2s behind, which ate a 55s buffer in 12 seconds and
    // left the video frozen under running audio.
    //
    // And aim BEHIND it — see RENDITION_SWAP_LOOKBACK_S. Landing ahead of the
    // clock freezes the picture until the clock catches up; landing behind it
    // costs a little decode of frames that are already in hand.
    const lookbackFromNow = () =>
      Math.max(
        0,
        Math.min(
          this.getCurrentTime() - MoviPlayer.RENDITION_SWAP_LOOKBACK_S,
          this.getDuration() || Number.POSITIVE_INFINITY,
        ),
      );
    let swapTime = lookbackFromNow();
    // Where the incoming source was actually positioned. The two paths seek to
    // different points, and the buffer bar is drawn from this.
    let seekedTo = swapTime;
    // --- PRIME (old STILL playing): decode the incoming rendition past the
    // playhead so the swap below costs no frames. Only attempted while the
    // picture is actually running — a paused or seeking player has no seam to
    // hide — and only when both renditions count time from the same origin,
    // since the splice compares their frames by raw timestamp.
    let primed: { decoder: MoviVideoDecoder; frames: VideoFrame[] } | null =
      null;
    // Set when the prime ran out of clock rather than bailing for a structural
    // reason (no shared origin, a paused player, a software-backed decoder).
    // That distinction is what the abandon below turns on.
    const primeStatus: { exhausted: boolean; readInFlight?: Promise<unknown> } =
      {
        exhausted: false,
      };
    const sameOrigin = Math.abs(newStartTime - this.startTime) < 0.001;
    if (
      sameOrigin &&
      this.videoRenderer &&
      this.stateManager.getState() === "playing"
    ) {
      try {
        // Aimed AT the playhead, not behind it. The lookback below exists
        // because the hard path resumes decoding from where it seeks and must
        // not land ahead of the clock; priming decodes forward past the clock
        // on purpose, so every second of lookback would be a second of frames
        // decoded only to be thrown away — at the resolution that most needs
        // the switch to be cheap.
        seekedTo = this.getCurrentTime();
        const sought = await withDeadline(
          newDemuxer.seek(seekedTo + newStartTime),
          prepLeft(),
        );
        if (sought === TIMED_OUT) {
          return abandonPrep(
            "seek for the seamless prime exceeded the prep budget",
          );
        }
        primed = await this.primeRendition(
          newDemuxer,
          newVideoTrack,
          newStartTime,
          prepDeadline,
          primeStatus,
        );
      } catch (e) {
        Logger.debug(TAG, `Seamless prime unavailable: ${e}`);
        primed = null;
      }
    }

    if (!primed) {
      // Re-read the clock for the same reason it was read after the open: a
      // prime that ran for seconds and then gave up would otherwise seek to a
      // point that far behind the playhead ON TOP of the lookback, and the swap
      // would have to decode the whole deficit before showing anything.
      // A prep that has already spent its whole budget has said what it needed
      // to: this rung is not being fed. Falling through would commit the swap
      // regardless — the unprimed path is a HARD switch, so the picture stops,
      // the indicator goes up, and the player then waits on the very stream
      // that could not prime. Abandon instead and let the next tick decide
      // again, with the old rendition still playing throughout.
      if (prepLeft() <= 0) {
        return abandonPrep(
          "prep budget spent before the swap — leaving the current rung in place",
        );
      }
      // A prime that ran out of clock has already measured the thing this path
      // is about to bet on, and the answer was no.
      //
      // The hard swap aims RENDITION_SWAP_LOOKBACK_S behind the playhead on
      // purpose, so the incoming rendition starts on a frame the clock has
      // passed — and that is only cheap because "those frames decode far
      // faster than real time". On the rungs that fail to prime, they do not.
      // Measured on an 8K60 AV1 rung: the prime spent its whole budget without
      // staging a usable frame, the swap then seeked 4s back, the keyframe
      // before that put the first frame 6.2s behind the audio, and the picture
      // never closed the gap — three catch-up seeks each landed on an earlier
      // keyframe and lost more ground (3.6s → 4.5s → 6.1s behind) until the
      // resync cap ran out and the picture simply stopped under running sound.
      //
      // The prime is the cheapest possible test of exactly that capability and
      // we have already paid for it. Failing it means this rung cannot chew a
      // swap backlog either, so don't create one: leave the current rendition
      // playing and let the next tick decide again.
      //
      // Only for an EXHAUSTED prime. The structural bails — no shared origin, a
      // paused player, a prime that came up software-backed — say nothing about
      // decode headroom, and those swaps go through as before.
      // …and only when CLIMBING. A downshift is the switch a struggling player
      // must always be allowed to finish — refusing it because the link was too
      // slow to prime would strand the picture on the very rung it is trying to
      // escape, which is the opposite of the rescue. Backlog is affordable
      // there anyway: the target is the cheaper rung.
      const targetBw =
        this._dashRenditions.find((r) => r.url === newRenditionUrl)
          ?.bandwidth ?? 0;
      const activeBw =
        this._dashRenditions.find((r) => r.url === this._activeDashRendition)
          ?.bandwidth ?? 0;
      if (primeStatus.exhausted && targetBw > activeBw) {
        // Remember it, so the ladder aims below it for a while — see the cap
        // in abrDecide. Escalates 30s, 60s, 120s for a rung that keeps failing.
        const nowRefused = performance.now();
        const prev = this._primeRefusals.get(newRenditionUrl);
        const count =
          (prev && nowRefused - prev.until < MoviPlayer.PRIME_REFUSAL_MAX_MS
            ? prev.count
            : 0) + 1;
        this._primeRefusals.set(newRenditionUrl, {
          count,
          until:
            nowRefused +
            Math.min(
              MoviPlayer.PRIME_REFUSAL_MS * 2 ** (count - 1),
              MoviPlayer.PRIME_REFUSAL_MAX_MS,
            ),
        });
        return abandonPrep(
          "the incoming rung could not be primed inside its budget — it will not chew the swap backlog either",
        );
      }
      // The prime can give up on a read that has not come back — it cannot be
      // cancelled, only outwaited. Seeking the same demuxer over it hands the
      // seek the read's pending slot: the read's bytes then land on "No pending
      // read to fulfill" and the demuxer the swap is about to play from is
      // wedged. That is why AUTO switches stuck on the heavy rungs and manual
      // ones did not: an ABR downshift fires on a low buffer over a saturated
      // link, where a 4K/8K read outlasts the prime's budget, while a manual
      // pick lands on a healthy one and primes to a seamless handover. Measured
      // on a 2160p → 1440p downshift: the warning 7ms after the swap, then the
      // picture held while the sound ran on.
      if (primeStatus.readInFlight) {
        const landed = await withDeadline(
          primeStatus.readInFlight,
          Math.max(prepLeft(), 0),
        );
        if (landed === TIMED_OUT) {
          return abandonPrep(
            "the prime's last read never landed — the new demuxer cannot be reused",
          );
        }
      }
      swapTime = lookbackFromNow();
      seekedTo = swapTime;
      try {
        const sought = await withDeadline(
          newDemuxer.seek(swapTime + newStartTime),
          prepLeft(),
        );
        if (sought === TIMED_OUT) {
          return abandonPrep("new demuxer seek exceeded the prep budget");
        }
      } catch (e) {
        return abandonPrep("new demuxer seek failed", e);
      }
    }

    // Last exit before the swap commits. The prime and the seek above are both
    // network-length waits, and a player destroyed inside either of them must
    // not come out the other side and swap itself into a pipeline that is gone.
    if (this._destroyed) {
      try {
        primed?.decoder.close();
      } catch {}
      for (const f of primed?.frames ?? []) {
        try {
          f.close();
        } catch {}
      }
      return abandonPrep();
    }
    // …nor one the viewer has seeked past. The prep opened the new rung at the
    // position it was started from, and the swap below takes the seek session:
    // committed over a seek in flight, it put the picture back where the prep
    // began (1476s, with the viewer at 1530s) and resolved the seek it had
    // superseded as PAUSED — holding the right-arrow key stopped playback, and
    // the rung it had climbed to then fell to 480p on the refill. An AUTO
    // switch is only an opinion about the link; the viewer's seek wins, and
    // the ladder decides again once they stop. A switch the viewer asked for
    // is theirs and goes ahead.
    if (this._abrSwitchInProgress && this._lastSeekAt !== seekAtPrep) {
      try {
        primed?.decoder.close();
      } catch {}
      for (const f of primed?.frames ?? []) {
        try {
          f.close();
        } catch {}
      }
      return abandonPrep(
        "the viewer seeked while the rung was being prepared — deciding again once they settle",
      );
    }

    // --- ATOMIC SWAP: stop the video loop (audio + clock keep running), swap
    // the video source/demuxer, hand the renderer its new frames, resume. ---
    // Primed, this is invisible and no indicator goes up. Unprimed, this is
    // where the picture stops, so this is where the indicator starts.
    if (!primed) beginSwitchIndicator();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    ++this.seekSessionId; // supersede any in-flight seek
    // A seek we just superseded may have left its video-sync flag set; this swap
    // owns the resume now, so release it or the pipeline waits for a completion
    // that can never arrive (see notifySeekCompletion's superseded-seek branch).
    this.waitingForVideoSync = false;
    // No wait for demuxInFlight here. It used to spin up to a second so a read
    // in flight could not be re-entered by the swap, but Demuxer now serializes
    // its own WASM entry points — the invariant holds whether this waits or not
    // — so all the wait could still do was stall the swap for up to a second
    // and push the prime below closer to going stale.
    //
    // The prime is a network-length wait and the clock kept running through it,
    // so frames staged for a playhead that has since passed them are no longer
    // a handover, they are a jump backwards. Drop them, and if that empties the
    // staging the switch is simply not seamless this time — nothing has been
    // swapped yet, so the hard path below is still open.
    if (primed) {
      const floor = this.getCurrentTime() - 0.05;
      while (
        primed.frames.length > 0 &&
        primed.frames[0].timestamp / 1_000_000 - newStartTime < floor
      ) {
        primed.frames.shift()!.close();
      }
      if (primed.frames.length === 0) {
        Logger.debug(
          TAG,
          "Seamless prime went stale during the swap — hard switch",
        );
        try {
          primed.decoder.close();
        } catch {}
        primed = null;
        beginSwitchIndicator();
        swapTime = lookbackFromNow();
        seekedTo = swapTime;
        // Put the read cursor back where the hard path expects it. The prime
        // drove it forward, and the reconfigured decoder would otherwise be fed
        // from mid-GOP and sit on its keyframe wait for as long as the GOP is
        // long. Failure here is not a reason to abandon the swap — the video
        // loop is already stopped, so there is nothing to return TO.
        try {
          await newDemuxer.seek(swapTime + newStartTime);
        } catch (e) {
          Logger.warn(
            TAG,
            "in-place switch: re-seek after a stale prime failed",
            e,
          );
        }
      }
    }

    const oldDemuxer = this.demuxer;
    const oldSource = this.source;
    const oldDecoder = this.videoDecoder;

    // Everything read against the outgoing pipeline is now history — see the
    // generation check in processLoop's catch.
    this._demuxerGeneration++;
    this.demuxer = newDemuxer;
    // Queued packets belong to the outgoing rendition's file.
    this.clearPacketQueues();
    this.source = newSource;
    // Adopted — the ordinary teardown owns them from here.
    this._pendingSwitchSource = null;
    this._pendingSwitchDemuxer = null;
    this.startTime = newStartTime;
    try {
      this.fileSize = await newSource.getSize();
    } catch {}

    // Reset the buffer-bar bookkeeping for the new source. getBufferedTime()
    // clamps the buffered-end monotonically (lastBufferedTime) and derives it
    // from the source's read cursor + fileSize — both of which just changed to a
    // fresh file that has only buffered from the resume point. Without this the
    // clamp holds the old rendition's higher, differently-scaled value and the
    // buffer bar freezes after a quality switch.
    this.lastBufferedTime = 0;
    this.bufferedRangeStart = seekedTo;
    // Whatever the loop decided about the end of the file was a verdict on the
    // OUTGOING demuxer's cursor, and the incoming one starts at seekedTo. A
    // rung left mid-read can call a failed read EOF on its way out (see the
    // held read in HttpSource), and carried across the swap that verdict
    // stopped the loop reading the new rung at all: fully downloaded, under a
    // spinner, until a seek happened to clear it.
    this.resetEof();

    // The video decoder's software path reads through the demuxer's WASM module.
    const bindings = newDemuxer.getBindings();
    if (bindings) (primed?.decoder ?? this.videoDecoder).setBindings(bindings);

    // Set the active rendition BEFORE setTracks: setTracks fires tracksChange,
    // which re-renders the quality menu + gear badge from getActiveDashRendition
    // — so this must already point at the new rendition or the UI shows stale.
    this._activeDashRendition = newRenditionUrl;

    // Reflect the new video track (the split-audio demuxer path keeps only the
    // video track in the TrackManager; audio + subtitles live elsewhere).
    this.trackManager.setTracks([newVideoTrack]);
    this.trackManager.selectVideoTrack(newVideoTrack.id);

    if (primed) {
      // Hand over: the outgoing frames already queued play out, the primed ones
      // take the timeline from there, and the decoder that made them becomes
      // the decoder. Nothing is flushed — a flush is a wait for a pipeline we
      // are about to discard, and on some builds it is a wait that times out.
      const spliceAt = primed.frames[0].timestamp;
      const adopted =
        this.videoRenderer?.spliceQueue(spliceAt, primed.frames) ?? 0;
      this.wireVideoDecoder(primed.decoder);
      this.videoDecoder = primed.decoder;
      try {
        oldDecoder.close();
      } catch {}
      Logger.debug(
        TAG,
        `Seamless handover at ${(spliceAt / 1_000_000).toFixed(3)}s with ${adopted} frames primed`,
      );
    } else {
      // Flush + reconfigure the video decoder/renderer for the new resolution.
      try {
        await this.videoDecoder.flush();
      } catch {}
      this.videoRenderer?.clearQueue();
      const extradata = newDemuxer.getExtradata(newVideoTrack.id) ?? undefined;
      await this.videoDecoder.configure(
        newVideoTrack,
        extradata,
        this.config.frameRate ?? 0,
      );
    }
    this.videoRenderer?.configure(
      newVideoTrack.width,
      newVideoTrack.height,
      newVideoTrack.colorPrimaries,
      newVideoTrack.colorTransfer,
      this.config.frameRate || newVideoTrack.frameRate,
      newVideoTrack.rotation ?? 0,
      newVideoTrack.isHDR,
      newVideoTrack.pixelFormat,
    );

    // NOTE: deliberately do NOT set seekTargetTime here — it's a shared field
    // the split-audio pump also honors, so setting it would make the untouched
    // audio drop packets and glitch. The video re-syncs to the running clock on
    // its own; the new demuxer is already seeked to the resume point.
    this.seekKeyframeOffset = 0;

    // Resume the video loop from the current position.
    this.processLoop();

    // The session bump above superseded whatever seek was in flight, and that
    // seek is not coming back to finish: it returns at its own superseded check
    // having already set "seeking" and paused the clock. If it notices in time
    // it resolves that itself; if the bump landed after its last check it
    // cannot, and the player is left frozen under a spinner that only a manual
    // seek clears (which is exactly how this was reported). The swap took the
    // session, so the swap finishes the seek.
    this.resumeAfterOrphanedSeek("an in-place rendition swap");

    // --- Tear down the old video pipeline (audio pipeline untouched). ---
    try {
      oldDemuxer.close();
    } catch {}
    try {
      oldSource?.close();
    } catch {}

    Logger.info(
      TAG,
      `in-place quality switch → ${newVideoTrack.width}x${newVideoTrack.height}${primed ? " (seamless)" : ""}`,
    );
    // Hold the indicator until the new rendition is actually on screen. The
    // swap is complete here, but the decoder has not produced a frame yet —
    // clearing now leaves the picture frozen with nothing explaining it, which
    // is the gap the viewer sees. Detached on purpose: the caller (ABR) is
    // waiting on this promise to release its own switch lock, and holding that
    // until the first frame lands would delay the next decision.
    // …and none of that applies to a seamless handover: no indicator went up,
    // because the picture never stopped to need one.
    if (!primed) void this.clearSwitchIndicatorOnResumedPlayback(endSwitch);
    // Re-stamp the anti-thrash clock at the LANDING, not the request. Every
    // settle in the ABR — the ordinary gate, the upshift hold, the emergency
    // downshift's "a fresh rung has nothing buffered yet BY DEFINITION" — is
    // measuring the new rung's first seconds, and the new rung does not exist
    // until here. Opening it costs a demuxer, a WASM instance and a byte range,
    // which on the link this was written for took the better part of a minute:
    // the settle expired while the OLD rung was still on screen, so the new one
    // landed with an empty buffer and no protection, froze during its own
    // refill, and was rescued off — 1080p → 720p → 480p → 360p, each step
    // "rescuing" the fill of the step before, on a link that then measured
    // 24Mbps and climbed straight back.
    this._lastAbrSwitchAt = performance.now();
    return true;
  }

  /**
   * Clear a rendition-switch indicator once the new pipeline is not just
   * painting but painting SMOOTHLY.
   *
   * The first frame is the wrong moment to let go of it. clearQueue() empties
   * the renderer at the swap, so that frame arrives with nothing behind it —
   * the decoder is still filling, and what the viewer gets for the next few
   * hundred milliseconds is a frame here, a frame there. Hiding the indicator
   * on it just moves the unexplained stutter to right after the indicator
   * disappears. Wait for about a third of a second of frames AND a queue with
   * something in reserve, which together are what "it's running again" means.
   *
   * Bounded: a decoder that never gets there (a rung the machine can't handle,
   * a stalled fetch) must not leave the indicator up forever. The stall then
   * shows as ordinary buffering, which is what it is.
   */
  private async clearSwitchIndicatorOnResumedPlayback(
    end: <T>(r: T) => T,
  ): Promise<void> {
    const deadline = performance.now() + 4000;
    const renderer = this.videoRenderer as unknown as {
      presentedSinceClear?: () => number;
      getQueueSize?: () => number;
    } | null;
    if (renderer?.presentedSinceClear) {
      const fps = this.trackManager?.getActiveVideoTrack()?.frameRate || 24;
      const settledFrames = Math.max(3, Math.round(fps * 0.3));
      while (performance.now() < deadline) {
        const painted = renderer.presentedSinceClear() || 0;
        // A queue with frames in it is the difference between "a frame landed"
        // and "frames keep landing". Renderers without the accessor fall back
        // to the frame count alone.
        const readyAhead = renderer.getQueueSize
          ? renderer.getQueueSize() >= 2
          : true;
        if (painted >= settledFrames && readyAhead) break;
        await new Promise((r) => setTimeout(r, 32));
      }
    }
    end(undefined);
  }

  /**
   * Enable/disable adaptive quality (ABR) on the in-place demuxer/premuxed
   * switch. When on, a timer estimates download throughput and switches to the
   * best rendition it can sustain — in-place, so it's smooth. Off pins the
   * current rendition.
   *
   * `snap` is for the viewer choosing Auto from a fixed quality: go to the rung
   * the link carries now, the way the opening pick does, instead of starting
   * the ordinary climb from wherever the fixed pick left it. See
   * abrSnapToLink. The per-video re-apply of a remembered Auto preference does
   * not snap — the opening pick has already made that decision.
   */
  setAutoQuality(enabled: boolean, opts?: { snap?: boolean }): void {
    if (this._autoQuality === enabled) return;
    this._autoQuality = enabled;
    if (enabled) {
      this._abrPrimed = false; // first upshift jumps without the 2-tick wait
      this._abrPenalizedBandwidth = 0; // fresh Auto session — no stale penalty
      this._abrPenaltyUntil = 0;
      if (opts?.snap) {
        void this.abrSnapToLink();
        if (!this._abrTimer) {
          this._abrTimer = setInterval(() => this.abrTick(), 4000);
        }
        return;
      }
      // Kick off a quick startup speed test so Auto can ramp to the right rung
      // in a couple of seconds instead of climbing rung-by-rung off passive
      // measurement — the "good link but started ugly-low" case. Non-blocking:
      // playback is already running on the small opening rung; when the probe
      // lands it seeds the estimate and re-evaluates. It measures PAST the proxy
      // burst (see probeLinkBandwidth), so it's honest on a caching proxy.
      void this.runStartupSpeedTest();
      this.abrTick(); // evaluate immediately (in case something already measured)
      if (!this._abrTimer) {
        this._abrTimer = setInterval(() => this.abrTick(), 4000);
      }
    } else if (this._abrTimer) {
      clearInterval(this._abrTimer);
      this._abrTimer = null;
    }
  }

  /**
   * Put Auto on the rung the link carries, now — the opening pick, re-run.
   *
   * Choosing Auto from a fixed quality used to hand the ladder to the ordinary
   * tick, which climbs one step and a cooldown at a time from wherever the
   * fixed pick left it: a viewer on 360p over a 40Mbps line picked Auto and
   * watched it walk up for a minute, when a fresh load of the same video opens
   * on the right rung before the first frame. So do what the fresh load does:
   * the same 55% of the best link reading we hold, the same device ceilings,
   * then read the chosen rung's own stream and re-pick from that — up or down,
   * twice at most — and switch once. A fixed pick above what the link carries
   * comes down the same way.
   *
   * Runs under the tick lock, so no ordinary decision races it.
   */
  private async abrSnapToLink(): Promise<void> {
    if (this._abrTickInFlight) return;
    this._abrTickInFlight = true;
    try {
      if (
        this._destroyed ||
        !this._autoQuality ||
        this._abrSwitchInProgress ||
        !this.source
      ) {
        return;
      }
      const rungs = this._dashRenditions
        .filter((r) => (r.bandwidth || 0) > 0)
        .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      if (rungs.length < 2) return;
      const onCpu = this.decodingOnCpu();
      const ceilingH = onCpu
        ? softwareDecodeCeiling(
            !!this.videoDecoder && !this.videoDecoder.isSoftware,
          )
        : Number.POSITIVE_INFINITY;
      const allowed = rungs.filter(
        (r) =>
          !(r.height != null && MoviPlayer.isDecodeBound(r.codec, r.height)) &&
          !((r.height ?? 0) > ceilingH && this.softwareCeilingApplies(r.codec)),
      );
      if (allowed.length === 0) return;
      const pickFor = (bits: number) =>
        allowed.find((r) => (r.bandwidth || 0) <= bits * 0.55) ??
        allowed[allowed.length - 1];

      const linkBits = Math.max(
        loadPersistedLinkBps(),
        this._lastThroughputBps * 8,
      );
      if (!(linkBits > 0)) {
        // Nothing measured at all: the ordinary tick and the startup speed
        // test are what find out, as they always did.
        void this.runStartupSpeedTest();
        return;
      }
      let pick = pickFor(linkBits);
      let basis = `${(linkBits / 1e6).toFixed(1)}Mbps known`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const bits = await this.probeRungThroughput(pick.url);
        if (this._destroyed || !this._autoQuality) return;
        if (bits <= 0) break; // unmeasurable says nothing — keep the pick
        this._rungProbeBits.set(pick.url, { bits, at: performance.now() });
        // A floor, not a verdict on the link: the playing stream shared the
        // line while this was read.
        raiseLinkBps(bits);
        const next = pickFor(bits);
        basis = `${(bits / 1e6).toFixed(1)}Mbps on ${pick.label || pick.height + "p"}'s own stream`;
        if (next.url === pick.url) break;
        pick = next;
      }
      if (pick.url === this._activeDashRendition) {
        Logger.info(
          TAG,
          `Auto: already on ${pick.label || pick.height + "p"} (${basis})`,
        );
        return;
      }
      Logger.info(
        TAG,
        `Auto selected — going straight to ${pick.label || pick.height + "p"} (${basis})`,
      );
      await this.abrCommit(pick.url, performance.now());
    } finally {
      this._abrTickInFlight = false;
    }
  }

  /**
   * One-shot startup speed test. Probes the SMALLEST rung's URL past the proxy
   * burst for a sustained reading, seeds the estimate, and re-evaluates so Auto
   * ramps straight to the affordable rung. Best-effort — a failure just leaves
   * Auto to measure passively from playback as before.
   */
  private async runStartupSpeedTest(): Promise<void> {
    if (this._startupSpeedTestRan) return;
    this._startupSpeedTestRan = true;
    // The host may have already run a pre-play probe and seeded the estimate
    // (the element does, to pick the opening rung). Don't probe again then.
    if (this._lastThroughputBps > 0) return;
    const rungs = this._dashRenditions
      .filter((r) => (r.bandwidth || 0) > 0)
      .sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
    if (rungs.length < 2) return;
    // Probe a MID rung: the smallest rung's whole file can be too small to skip
    // the proxy burst and still time a tail (it hit EOF and measured nothing).
    // The Range header caps the download; the link measured is the same.
    const probe =
      rungs[Math.min(rungs.length - 1, Math.floor(rungs.length / 2))];
    const bits = await probeLinkBandwidth(probe.url, {
      headers: this.config.headers,
      signal: this.lifetimeSignal,
    });
    if (this._destroyed || bits <= 0) return;
    // Seed only if playback hasn't already measured a HIGHER sustained rate
    // (a fully-cached/fast source can beat the probe) — never drag a good
    // reading down.
    const bps = bits / 8;
    if (bps > this._lastThroughputBps) this._lastThroughputBps = bps;
    Logger.info(
      TAG,
      `Startup speed test: ${(bits / 1e6).toFixed(1)}Mbps sustained (past the proxy burst)`,
    );
    // Keep it for the next open. Only the element's pre-play probe was writing
    // this store, so a session whose probe came up empty — a proxy that bursts
    // before it paces, which is exactly where the probe struggles — measured a
    // perfectly good link here and then threw the number away, and the next
    // open started from "no link measurement yet" on the smallest rung again.
    // raise, not persist: a reading taken mid-playback is a floor (the stream
    // is paced to its own bitrate), so it may lift a stored estimate but must
    // never drag a better one down. Same rule the Shaka and DASH wrappers use.
    // Bits: the store is bits/s (see persistLinkBps), and a bytes/s value
    // here was eight times too small ever to raise it.
    raiseLinkBps(bits);
    if (this._autoQuality) void this.abrTick();
  }

  isAutoQuality(): boolean {
    return this._autoQuality;
  }

  /**
   * One ABR decision: pick the best rendition the measured throughput can
   * sustain and switch to it in-place. Downshifts eagerly when the audio buffer
   * is starving. No-op while a switch is already running or bitrates are unknown.
   */
  private async abrTick(): Promise<void> {
    // One decision at a time. The upshift path AWAITS a probe of the target
    // rung before it commits, and a tick that arrived during that await sailed
    // past every guard below — including _abrSwitchInProgress, which is only
    // set once the commit actually starts. Two ticks then committed the same
    // climb 285ms apart, and the second swap tore down the source the first was
    // still priming: the picture froze and the rescue dropped the quality
    // straight back down. That whole cycle reads as "Auto can't sit still".
    if (this._abrTickInFlight) return;
    this._abrTickInFlight = true;
    try {
      await this.abrDecide();
    } finally {
      this._abrTickInFlight = false;
    }
  }

  private _abrTickInFlight = false;
  // The source and demuxer an in-place rendition switch is preparing, while it
  // is preparing them. They belong to no one else until the swap adopts them —
  // see switchVideoRenditionInPlace — so this is how destroy() reaches them.
  private _pendingSwitchSource: SourceAdapter | null = null;
  private _pendingSwitchDemuxer: Demuxer | null = null;
  // Bumped whenever the video demuxer is replaced, so a read still in flight
  // against the old one can be told apart from a genuine failure.
  private _demuxerGeneration = 0;

  /**
   * A rung the link just failed: stop the remembered rate claiming it, and
   * hold the ladder below it for an escalating while — see _abrDrainStrikes.
   */
  private penalizeLeavingRung(leavingBw: number, now: number): void {
    lowerLinkBps(leavingBw);
    const prevStrike = this._abrDrainStrikes.get(leavingBw);
    const strikes =
      (prevStrike && now - prevStrike.at < MoviPlayer.ABR_STRIKE_DECAY_MS
        ? prevStrike.count
        : 0) + 1;
    this._abrDrainStrikes.set(leavingBw, { count: strikes, at: now });
    this._abrPenalizedBandwidth = leavingBw;
    this._abrPenaltyUntil = Math.max(
      this._abrPenaltyUntil,
      now +
        Math.min(
          MoviPlayer.ABR_PENALTY_MS * 2 ** (strikes - 1),
          MoviPlayer.ABR_PENALTY_MAX_MS,
        ),
    );
  }

  /** Deepest the buffer has been since playback last settled on this rung —
   *  the reference the early downshift measures "half used" against. */
  private _abrBufferPeak = 0;
  /** When the early downshift last asked and chose to stay. */
  private _abrEarlyCheckAt = Number.NEGATIVE_INFINITY;
  /** Below this share of its peak, a buffer the link is not refilling is
   *  worth a question about the rung — see the early downshift. */
  private static readonly ABR_EARLY_DOWN_AT = 0.5;
  /** A peak shallower than this has no half worth protecting: the reactive
   *  downshift's own thresholds (4-6s) are already that close. */
  private static readonly ABR_EARLY_MIN_PEAK_S = 10;
  private static readonly ABR_EARLY_RECHECK_MS = 20_000;

  /** One ABR decision. Always through abrTick(), never called directly. */
  private async abrDecide(): Promise<void> {
    if (
      this._destroyed ||
      !this._autoQuality ||
      this._abrSwitchInProgress ||
      this._dashRenditions.length < 2 ||
      !this.source ||
      // Audio-only: the video source's prefetch is paused, so the video buffer
      // can only shrink as the playhead advances. The draining-buffer downshift
      // below reads that as an unsustainable rung and walks the quality down one
      // step every tick — a video that was on 8K comes back on 1080p after a
      // spell of audio-only, even though nothing about the link changed. There's
      // no video being fetched to adapt, so don't adapt: freeze the ABR here and
      // clear the buffer baseline so re-enabling video doesn't misfire on the
      // first post-resume tick.
      this._audioOnly ||
      // Never switch while a seek is resolving. The in-place swap replaces the
      // video demuxer/source and bumps seekSessionId; doing that concurrently
      // with a user seek races the seek's own demuxer reads and leaves the WASM
      // demuxer reading bytes at the wrong offset — surfacing as "corrupt data
      // stream" plus a large A/V desync. Wait for the seek to settle first.
      this.stateManager.is("seeking") ||
      this.waitingForVideoSync ||
      // …nor in the moments BETWEEN seeks. Holding an arrow key is a seek every
      // ~100ms with a brief "playing" in between, and a decision made in one of
      // those gaps prepares its rung while the next seeks arrive (see the last
      // exit in switchVideoRenditionInPlace). Nothing about the link is learned
      // from a playhead that is jumping; wait for it to settle.
      performance.now() - this._lastSeekAt < MoviPlayer.ABR_POST_SEEK_HOLD_MS
    ) {
      if (this._audioOnly) this._lastBufferAhead = 0;
      return;
    }
    // Hidden tab: make no decision at all, and forget the buffer reading.
    //
    // Video decode is skipped while hidden, so the video buffer drains as the
    // clock runs even on a link that is perfectly fine — and the comparison
    // against the pre-background reading then reads as a collapsing buffer the
    // moment the tab comes back, which is why returning to a tab dropped the
    // quality. Clearing the baseline means the first tick after the return
    // establishes a fresh one instead of measuring against history.
    //
    // PiP is exempt: the video is visible there and decoding normally.
    if (this.isBackgrounded && !this.isPiPActive) {
      this._lastBufferAhead = 0;
      this._abrUpCandidate = "";
      this._abrUpConfirms = 0;
      return;
    }
    // A source the server is refusing: no decision, and no verdict on the link.
    //
    // A 403 empties the buffer exactly the way a slow link does, and every
    // rung of a split stream shares the one audio URL, so no downshift can
    // answer it. Measured on a YouTube video whose URLs stop serving about a
    // minute in (every itag, fresh or re-resolved): the audio range past that
    // point was refused, the buffer read 0.4s, and the ABR walked 2160p to 480p
    // to 360p to 240p through switches that could never prime — and on the way
    // lowered the REMEMBERED link rate from 56.7 to 12 Mbps, so the next video,
    // on a link that was fine, opened low as well. The refusal is the element's
    // to surface; the quality stays where it is.
    const refusing = (s: unknown) =>
      !!(s as { isRefusing?: () => boolean } | null)?.isRefusing?.();
    if (refusing(this.source) || refusing(this.audioSource)) {
      this._lastBufferAhead = 0;
      return;
    }

    // Best-first: index 0 = highest bitrate.
    const rungs = this._dashRenditions
      .filter((r) => (r.bandwidth || 0) > 0)
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (rungs.length < 2) return; // no bitrate info → can't adapt

    const activeIdx = rungs.findIndex(
      (r) => r.url === this._activeDashRendition,
    );
    const now = performance.now();
    const sinceSwitch = now - this._lastAbrSwitchAt;

    // Capped-start correction: a new video (or a recreate) can start on the
    // source's default rung even though this device has already proven — this
    // session — it can't decode that height (e.g. it settled at 2160p last
    // video, so this one defaults to 2160p, which is session-capped). Drop
    // straight to the highest decodable rung instead of stuttering through the
    // whole decode-bound dance again.
    if (
      activeIdx >= 0 &&
      deviceDecodeBoundHeights.size > 0 &&
      now - this._lastAbrSwitchAt > 3000
    ) {
      const active = rungs[activeIdx];
      if (
        active.height != null &&
        MoviPlayer.isDecodeBound(active.codec, active.height)
      ) {
        const ok = rungs.find(
          (r) =>
            r.height == null || !MoviPlayer.isDecodeBound(r.codec, r.height),
        );
        if (ok && ok.url !== this._activeDashRendition) {
          Logger.info(
            TAG,
            `ABR: started on decode-capped ${active.height}p — correcting to ${ok.label || ok.bandwidth}`,
          );
          await this.abrCommit(ok.url, now);
          return;
        }
      }
    }

    // Same correction for SOFTWARE decode. The cap below stops Auto climbing
    // past what the CPU can hold, but a session that is already sitting above
    // it — the hardware path failed and the fallback reloaded at the rung that
    // was playing — would just stay there and stutter. Come down at once.
    if (activeIdx >= 0 && this.decodingOnCpu() && sinceSwitch > 3000) {
      const ceilingH = softwareDecodeCeiling(
        !!this.videoDecoder && !this.videoDecoder.isSoftware,
      );
      const active = rungs[activeIdx];
      if (
        (active.height ?? 0) > ceilingH &&
        this.softwareCeilingApplies(active.codec)
      ) {
        // The landing rung is chosen by the same per-codec rule, so a ladder
        // that changes codec on the way down lands on the highest rung this
        // machine can actually decode — not the highest one under a ceiling
        // that belongs to the codec being left behind.
        const ok = rungs.find(
          (r) =>
            (r.height ?? 0) <= ceilingH ||
            !this.softwareCeilingApplies(r.codec),
        );
        if (ok && ok.url !== this._activeDashRendition) {
          // Write down what just happened, or the correction can undo itself.
          // Landing on a hardware rung clears decodingOnCpu, and with nothing
          // recorded the throughput path is free to climb straight back into
          // the rung that had no hardware path — fall to the CPU, correct,
          // climb, forever. Session-only and for this rung alone: a codec
          // without a hardware path at one height may well have one lower
          // down, and that is the next rung's question to answer, not this
          // one's to prejudge.
          const leavingKey = decodeBoundKey(
            this.videoDecoder?.configuredCodec || active.codec || "",
            active.height ?? 0,
          );
          if (active.height) {
            deviceDecodeBoundHeights.add(leavingKey);
            sessionOnlyDecodeBoundHeights.add(leavingKey);
          }
          Logger.info(
            TAG,
            `ABR: software decode can't hold ${active.height}p ${codecFamily(active.codec) || "video"} — correcting to ${ok.label || ok.height + "p"}${codecFamily(ok.codec) !== codecFamily(active.codec) ? ` (${codecFamily(ok.codec)}, which has a hardware path)` : ""}`,
          );
          await this.abrCommit(ok.url, now);
          return;
        }
      }
    }

    // How many seconds of video are buffered ahead of the playhead, and whether
    // that number is shrinking — the GROUND TRUTH for whether the current rung is
    // sustainable, independent of the throughput estimate. That estimate LAGS on
    // the premuxed path: while we coast on a filling buffer the source isn't
    // downloading, so its last-measured speed stays stale-high and would wrongly
    // report the rung as affordable (that's exactly how a 4K buffer drained to
    // zero on a throttled link without ever downshifting).
    const bufferAhead = Math.max(
      0,
      this.getBufferedTime() - this.getCurrentTime(),
    );
    // …but only while there is still something to fetch. Once the whole file is
    // in hand the buffer shrinks by a second for every second played, forever,
    // and that is not the link failing to keep up — it is the download being
    // finished. Reading it as a drain left Auto pinned: on a fully buffered
    // 144p rung every tick looked like a buffer in trouble, so the upshift gate
    // refused, and quality only ever climbed if the viewer PAUSED (which stops
    // the playhead, so the buffer stops shrinking).
    const nothingLeftToFetch = this.nothingLeftToFetch();
    const draining =
      !nothingLeftToFetch &&
      this._lastBufferAhead > 0 &&
      bufferAhead < this._lastBufferAhead - 1.5;
    this._lastBufferAhead = bufferAhead;

    // DOWNSHIFT (responsive) — a hard buffering stall OR a draining/low buffer
    // means the current rung can't be sustained; act fast and WITHOUT a
    // throughput gate (the gate, fed a stale-high estimate, was what blocked the
    // downshift). Paced by a short 5s settle rather than the 12s voluntary
    // cooldown so it responds before the buffer empties, and stood down for a few
    // seconds after a seek — that buffering is a normal re-fill, and swapping
    // into it races the seek's own re-prime and crashed the demuxer.
    const postSeekSettling = now - this._lastSeekAt < 4000;
    // The first seconds back from a hidden tab are a refill, not a verdict: the
    // buffer drained because decode was skipped, and it fills again at whatever
    // rate the link always had. Long enough to cover the refill, short enough
    // that a link which genuinely degraded while we were away is still caught
    // on the tick after.
    const postBackgroundSettling =
      this._foregroundRecoveryAt > 0 && now - this._foregroundRecoveryAt < 8000;
    // Buffering is the ABR's ground truth for a rung the link cannot carry —
    // but only when the link is what stopped us. A buffering WE caused (a rate
    // change's audio re-anchor, a seek resuming on the cushion it just flushed,
    // a bound catch-up holding the sound for the picture) says nothing about
    // the rung, and reading it as a verdict costs a rung every few seconds for
    // as long as the hold lasts: one session walked 1440p → 1080p → 720p →
    // 480p → 360p → 240p on a link carrying 25.9s of buffer, each downshift
    // clearing the frame queue the hold was waiting to see fill — the ladder
    // collapse and the wait sustaining each other.
    // …and only when the link is what ran out. Playback can stall with seconds
    // of the rung already ON THE MACHINE — the frame queue empties while the
    // decoder re-primes, or the picture is catching up — and a downshift is a
    // bandwidth remedy for a problem that is not bandwidth. Measured on a 4K60
    // rung: three stalls with 7.1s, 9.5s and 67.2s buffered ahead, each read as
    // the rung failing, walking 2160p → 1440p → 1080p → 720p while the bytes
    // for 2160p sat in hand. A rung the DEVICE cannot decode still drops, via
    // the decode-bound branch that owns that case.
    const linkStarved = bufferAhead < MoviPlayer.ABR_STALL_STARVED_S;
    const stalling =
      this.stateManager.is("buffering") &&
      !this._bufferingSelfInflicted &&
      linkStarved;
    // An in-place quality switch resets the buffered range to ~0 at the current
    // playhead, so bufferAhead reads low for the first several seconds while the
    // new rendition re-primes — that's a REFILL, not the network failing to
    // sustain the rung. Gate the absolute-low check on a longer post-switch
    // settle (matching the upshift cooldown) so the refill dip can't be misread
    // as "can't cope" and fire a downshift — which resets the buffer again and
    // self-sustains a 240⇄360 oscillation on a perfectly fine link. A genuine
    // hard stall (buffering) or a sustained DRAIN — buffer actively shrinking,
    // which never happens while it's refilling — still downshifts responsively.
    // "Settled" = 12s clear of the last quality switch AND the last seek. Both
    // reset the buffered range to ~0 at the new playhead, so the absolute-low
    // clause below must not fire on that refill dip — a seek makes bufferAhead
    // low INSTANTLY, and downshifting then is wrong (it just needs to refill).
    // Same reasoning extended to the FIRST fill after playback starts: at
    // startup no switch has happened, so `sinceSwitch` is Infinity and the
    // clause below would fire on the normal 0–4s ramp-up dip. Give the buffer
    // the same 12s grace to build before its depth is treated as a verdict on
    // the rung — this is what let 4K survive startup instead of being dropped
    // to 1080p within the first second on a link that carries it.
    // Unset (still NEGATIVE_INFINITY) means playback hasn't begun — that is
    // the *least* settled state, so it must read false. Subtracting
    // NEGATIVE_INFINITY yields Infinity, which would wrongly read as "settled".
    const settledSinceStart =
      this._playbackStartedAt !== Number.NEGATIVE_INFINITY &&
      now - this._playbackStartedAt > 12000;
    const settledSinceSwitch =
      sinceSwitch > 12000 &&
      now - this._lastSeekAt > 12000 &&
      settledSinceStart;
    // While the video is holding for a keyframe (or just recovered), the video
    // buffer drains even though the network is fine — the clock advances but the
    // frozen frame doesn't. Don't let that phantom drain trigger a downshift; a
    // genuine network stall still fires via `stalling` (buffering state).
    const videoRecovering =
      this._videoHoldingForKeyframe ||
      !!this.videoDecoder?.isRecentlyRecovering?.();
    // Nothing left to fetch means nothing a downshift can fix. `draining`
    // already knows that; the absolute-low clause did not, and near the end of
    // a fully-downloaded file bufferAhead is small for the only reason it can
    // be — the video is ending. That read as a rung in trouble and dropped a
    // 2160p file to 360p three seconds before it finished, with the switch's
    // spinner over the last of the picture. The bytes were already on the
    // machine; there was no link to relieve.
    const bufferLow =
      !videoRecovering &&
      !nothingLeftToFetch &&
      ((draining && bufferAhead < 6) ||
        (bufferAhead < 4 && settledSinceSwitch));

    // EARLY DOWNSHIFT — decide at half the buffer, not at its last second.
    //
    // The reactive path below fires on a buffer that is nearly gone (4-6s, or
    // a stall), and a switch made there is a hard one: the new rung has to open,
    // seek and prime in whatever is left, and on 8K over a link that carries
    // neither 8K nor quite 4K that is not enough — the picture stops while the
    // lower rung loads, and sometimes stops again when it proves too heavy as
    // well. Asked at half the buffer, the same switch has seconds to prime
    // under a picture that is still playing, which is what makes it seamless.
    //
    // Asked only when the buffer is falling for the link's reasons: the stream
    // is downloading right now (not parked on a full window, which also lets
    // the buffer fall) and what it has delivered is short of the rung. Then one
    // short read of the rung's own stream, with the playing download held so
    // the reading is the link's and not a share of it, decides: carried, stay
    // and ask again later; not carried, go now to the highest rung it carries.
    const earlySettled =
      !postSeekSettling &&
      !postBackgroundSettling &&
      !videoRecovering &&
      !nothingLeftToFetch &&
      sinceSwitch > 5000 &&
      activeIdx >= 0;
    if (!earlySettled) {
      this._abrBufferPeak = 0;
    } else if (bufferAhead > this._abrBufferPeak) {
      this._abrBufferPeak = bufferAhead;
    }
    if (
      earlySettled &&
      !stalling &&
      !bufferLow &&
      activeIdx < rungs.length - 1 &&
      this._abrBufferPeak >= MoviPlayer.ABR_EARLY_MIN_PEAK_S &&
      bufferAhead <= this._abrBufferPeak * MoviPlayer.ABR_EARLY_DOWN_AT &&
      now - this._abrEarlyCheckAt > MoviPlayer.ABR_EARLY_RECHECK_MS &&
      !this._abrProbeInFlight
    ) {
      const active = rungs[activeIdx];
      const activeBits = active.bandwidth || 0;
      const ns = (
        this.source as {
          getNetworkStats?: () => { currentSpeed: number };
        } | null
      )?.getNetworkStats?.();
      const downloading = (ns?.currentSpeed || 0) > 0;
      const delivered = this.sustainedDeliveryBps();
      if (downloading && delivered > 0 && delivered < activeBits) {
        this._abrEarlyCheckAt = now;
        const held = this.source as {
          suspendNetwork?: () => void;
          resumeNetwork?: () => void;
        } | null;
        held?.suspendNetwork?.();
        let probed = -1;
        try {
          probed = await this.probeRungThroughput(active.url);
        } finally {
          held?.resumeNetwork?.();
        }
        if (this._destroyed || !this._autoQuality) return;
        const reading = probed > 0 ? probed : delivered;
        const basis = `${(reading / 1e6).toFixed(1)}Mbps ${probed > 0 ? "on its own stream" : "delivered"}`;
        if (reading * 0.85 >= activeBits) {
          Logger.info(
            TAG,
            `ABR early check at ${bufferAhead.toFixed(1)}s of a ${this._abrBufferPeak.toFixed(1)}s buffer: ${active.label || activeBits} still carried (${basis}) — staying`,
          );
        } else {
          let target = rungs[rungs.length - 1];
          for (let i = activeIdx + 1; i < rungs.length; i++) {
            if ((rungs[i].bandwidth || 0) <= reading * 0.85) {
              target = rungs[i];
              break;
            }
          }
          this.penalizeLeavingRung(activeBits, now);
          Logger.info(
            TAG,
            `ABR downshift ${active.label || activeBits} → ${target.label || target.bandwidth}: reason=early, bufferAhead=${bufferAhead.toFixed(1)}s of ${this._abrBufferPeak.toFixed(1)}s, ${basis}, delivered ${(delivered / 1e6).toFixed(1)}Mbps`,
          );
          this._abrBufferPeak = 0;
          await this.abrCommit(target.url, now);
        }
        return;
      }
    }
    if (
      (stalling || bufferLow) &&
      // Nothing left to fetch means the whole rung is already in hand, and a
      // downshift is a bandwidth remedy: there is no bandwidth problem to
      // remedy, and the lower rung would have to be fetched from scratch. A
      // stall here is the DECODER, not the link — that has its own downshift
      // (the software-ceiling branch above), which still fires and still drops
      // a rung the machine genuinely cannot decode. What this stops is a fully
      // buffered 4K walking down to 1080p and showing the viewer a worse
      // picture for no reason at all.
      !nothingLeftToFetch &&
      !postSeekSettling &&
      !postBackgroundSettling &&
      sinceSwitch > 5000 &&
      activeIdx >= 0 &&
      activeIdx < rungs.length - 1
    ) {
      // Drop to the highest rung the freshly-measured throughput sustains — once
      // the buffer is low the source IS actively downloading again, so its speed
      // is a real reading — but always at least one step down.
      const ns = (
        this.source as {
          getNetworkStats?: () => { currentSpeed: number; lastSpeed?: number };
        } | null
      )?.getNetworkStats?.();
      const downBits = ((ns?.lastSpeed ?? ns?.currentSpeed ?? 0) || 0) * 8;
      // A soft bufferLow (not a hard stall) is only a real "can't sustain the
      // rung" signal when the source is ACTIVELY downloading and STILL can't
      // keep up. Two cases must HOLD the rung and just let it refill instead of
      // dropping quality:
      //   1) Coasting — the buffer filled up so the source paused fetching
      //      (currentSpeed ~0); the drain toward the buffer end is normal and it
      //      resumes on the SAME rung. This is the "1440p playing fine, buffer
      //      hit the end → keep buffering 1440p, don't drop" case.
      //   2) Live download already carries the rung (rate ≥ bitrate + margin).
      // Only an active-but-too-slow link, or a hard stall (playback actually
      // stopped, buffer truly empty), drops quality.
      const liveBits = (ns?.currentSpeed || 0) * 8;
      const currentRungBits = rungs[activeIdx].bandwidth || 0;
      if (!stalling) {
        if (liveBits <= 0) return; // coasting on a full buffer — it will refill
        if (currentRungBits > 0 && liveBits >= currentRungBits * 1.15) return;
      }
      // Default to the LOWEST rung: if the link can't sustain even the smallest
      // bitrate, jump straight there — its tiny file also preps fastest, so
      // playback resumes soonest (cascading one rung at a time means several slow
      // switches while the buffer sits empty). When some higher rung does fit the
      // measured rate, use the highest such rung instead.
      let target = rungs[rungs.length - 1];
      for (let i = activeIdx + 1; i < rungs.length; i++) {
        if ((rungs[i].bandwidth || 0) <= downBits) {
          target = rungs[i];
          break;
        }
      }
      // Penalize the rung we're leaving so the upshift path can't climb straight
      // back into it (or higher) on a transient spike. ESCALATE the hold each
      // repeat — a rung the link keeps failing to sustain gets 30s, then 1m, 2m,
      // … (capped) — so a borderline rung (throughput ≈ its bitrate) settles on
      // the lower one instead of ping-ponging every ~40s. Strikes decay after a
      // clean spell so an improved link still gets another shot.
      const leavingBw = rungs[activeIdx].bandwidth || 0;
      // The link just failed this rung, so the stored rate that opens the next
      // load must stop claiming it can carry it — see lowerLinkBps.
      this.penalizeLeavingRung(leavingBw, now);
      Logger.info(
        TAG,
        `ABR downshift ${rungs[activeIdx].label || rungs[activeIdx].bandwidth} → ${target.label || target.bandwidth}: reason=${stalling ? "stall" : "bufferLow"}, bufferAhead=${bufferAhead.toFixed(1)}s, draining=${draining}, sinceSwitch=${(sinceSwitch / 1000).toFixed(0)}s`,
      );
      await this.abrCommit(target.url, now);
      return;
    }

    // Voluntary UPSHIFT holds for a cooldown after any switch so a single change
    // can't cascade into a rung-by-rung oscillation — the throughput estimate is
    // noisy right after a swap (it reflects the new file's fresh download).
    if (sinceSwitch < 12000) return;

    // And it holds until the CURRENT rung is comfortably carried. A switch is
    // not free: it opens a new file, and the cushion that made the old rung feel
    // safe does not come with it — the new rendition starts from nothing. So a
    // climb made while the buffer is thin or shrinking bets the whole playback
    // on an estimate, and on a marginal link that bet is what turns a video that
    // was playing into one that is buffering.
    //
    // A deep, steady buffer is the evidence that the link has room to spare;
    // without it, hold the rung and let it fill. Throughput alone is not enough
    // — it is a lagging average, and on a paced CDN stream it measures the
    // rung's own bitrate rather than the link's capacity.
    if (draining || bufferAhead < MoviPlayer.ABR_UPSHIFT_MIN_BUFFER_S) {
      // Make the candidate earn its confirmations again from a healthy buffer,
      // so a climb can't be assembled out of one good tick and one bad one.
      this._abrUpCandidate = "";
      this._abrUpConfirms = 0;
      return;
    }

    // Hold voluntary UPSHIFT while the tab is hidden. The video isn't rendered in
    // a background tab (its decode is skipped), so climbing to a higher rung just
    // burns bandwidth on a stream nobody can see — and the throughput estimate is
    // stale anyway, since sampleThroughput() rides the rAF UI loop, which the
    // browser throttles/stops when hidden. The protective downshift above still
    // runs off the download-range buffer signal (fed by the un-throttled
    // background timer), so audio stays safe on a degrading link. PiP is exempt —
    // there the video IS visible, so ABR should keep adapting normally.
    if (this.isBackgrounded && !this.isPiPActive) return;

    const netStats = (
      this.source as {
        getNetworkStats?: () => { currentSpeed: number; lastSpeed?: number };
      } | null
    )?.getNetworkStats?.();
    // Prefer lastSpeed (the last measured rate, which survives idle) over
    // currentSpeed (0 once a small file finishes caching) so Auto keeps a real
    // estimate to size the rung from.
    const raw = netStats?.lastSpeed ?? netStats?.currentSpeed ?? 0;
    // EWMA-smooth the estimate so a single noisy reading doesn't drive a switch.
    if (raw > 0) {
      this._lastThroughputBps =
        this._lastThroughputBps > 0
          ? this._lastThroughputBps * 0.7 + raw * 0.3
          : raw;
    }
    const bps = this._lastThroughputBps;
    if (bps <= 0) {
      // No SUSTAINED measurement yet (playback just started on the smallest
      // rung). Do nothing — don't guess, don't probe a burst. sampleThroughput
      // builds the estimate off real playback within a couple of seconds, and
      // the next tick sizes the ramp from that honest number.
      return;
    }
    const throughputBits = bps * 8;

    // UPSHIFT — only to a higher rung that fits with a safety margin, and only
    // after it holds for two consecutive ticks so a lone spike (a cache-served
    // burst, one fast chunk) doesn't bounce quality up then straight back down.
    //
    // A deep, non-draining buffer means the download is PACING-limited, not
    // link-limited: the server (YouTube's CDN throttles each stream to roughly
    // its own bitrate once the opening burst is over) hands over exactly as much
    // as playback needs and no more. The sustained reading then measures the
    // rung's bitrate rather than the link, so it can only ever justify the next
    // rung up — which is how a connection doing 4 MB/s climbed 144p → 240p → …
    // one 12-second cooldown at a time and never arrived anywhere near the top.
    //
    // While the buffer is that healthy, the sustained number is a FLOOR, and the
    // range probe — a fresh request, served at burst speed — is the better
    // reading. It is still only used to size the CANDIDATE; the confirmation
    // below, the 0.85 margin, and the drain/penalty machinery all still apply, so
    // a rung the link can't really hold gets dropped again on its own.
    // 12s: comfortably above the 6s/4s marks the downshift path treats as
    // trouble, and low enough that a modest `buffersize` still reaches it.
    const paced = bufferAhead >= 12 && !draining;
    let sizingBits = throughputBits;
    if (
      paced &&
      this._lastProbeBits > 0 &&
      now - this._lastProbeAt < MoviPlayer.ABR_PROBE_FRESH_MS
    ) {
      sizingBits = Math.max(sizingBits, this._lastProbeBits);
    }
    let affordableBits = sizingBits * 0.85;
    // Everything below is a CEILING that holds whatever the link says (the
    // device, the CPU, a rung that just failed) — kept apart so the stable-link
    // jump further down can be held to the same limits.
    let capBits = Number.POSITIVE_INFINITY;
    // Never climb into a resolution this device has proven (twice) it can't
    // decode. The cap lives at module level (survives player recreates), so it
    // holds across every video this session — convert the capped heights to a
    // bandwidth ceiling here (higher resolution ⇒ higher bandwidth on any sane
    // ladder, so this also excludes anything above them).
    // Software decode caps the ladder on its own — see softwareDecodeCeiling.
    if (this.decodingOnCpu()) {
      const ceilingH = softwareDecodeCeiling(
        !!this.videoDecoder && !this.videoDecoder.isSoftware,
      );
      let swCapBits = Number.POSITIVE_INFINITY;
      for (const r of rungs) {
        if (
          (r.height ?? 0) > ceilingH &&
          this.softwareCeilingApplies(r.codec)
        ) {
          swCapBits = Math.min(
            swCapBits,
            r.bandwidth || Number.POSITIVE_INFINITY,
          );
        }
      }
      if (swCapBits < Number.POSITIVE_INFINITY) {
        capBits = Math.min(capBits, swCapBits - 1);
      }
    }

    if (deviceDecodeBoundHeights.size > 0) {
      let heightCapBits = Number.POSITIVE_INFINITY;
      for (const r of rungs) {
        if (r.height != null && MoviPlayer.isDecodeBound(r.codec, r.height)) {
          heightCapBits = Math.min(
            heightCapBits,
            r.bandwidth || Number.POSITIVE_INFINITY,
          );
        }
      }
      if (heightCapBits < Number.POSITIVE_INFINITY) {
        capBits = Math.min(capBits, heightCapBits - 1);
      }
    }
    // Honour an active penalty: a rung that recently drained is off-limits (and
    // so is anything above it) until the hold window passes, so a bursty spike
    // can't re-upshift into the same rung that just failed. Cleared once expired.
    if (now < this._abrPenaltyUntil && this._abrPenalizedBandwidth > 0) {
      capBits = Math.min(capBits, this._abrPenalizedBandwidth - 1);
    } else if (this._abrPenaltyUntil !== 0 && now >= this._abrPenaltyUntil) {
      this._abrPenaltyUntil = 0;
      this._abrPenalizedBandwidth = 0;
    }
    // A rung whose in-place switch just failed to prime is off the table for
    // a while, and so is everything above it. Without this the climb aimed at
    // the same rung on every tick: on Safari, 720p → 4320p was probed and
    // abandoned ten times in a row ("could not be primed inside its budget"),
    // each probe a burst reading of 86-103Mbps, and the picture stayed on 720p
    // the whole time while 2160p — which the link carries — was never asked.
    // Capping just under it lets the next tick aim one rung lower.
    //
    // Settled: the owner confirmed this is the right approach (2026-09-26).
    // Do not rework it or remove it.
    for (const r of rungs) {
      const refused = this._primeRefusals.get(r.url);
      if (refused && now < refused.until && (r.bandwidth || 0) > 0) {
        capBits = Math.min(capBits, (r.bandwidth || 0) - 1);
      }
    }
    affordableBits = Math.min(affordableBits, capBits);
    let up = rungs[rungs.length - 1];
    for (const r of rungs) {
      if ((r.bandwidth || 0) <= affordableBits) {
        up = r;
        break;
      }
    }
    let upIdx = rungs.indexOf(up);
    if (activeIdx < 0) {
      // Current rung unknown (unseeded) — establish the affordable one at once.
      await this.abrCommit(up.url, now);
      return;
    }
    // Climb ONE rung at a time WHILE PLAYING. The estimate that sizes the jump
    // is measured against the rung currently playing, and on a small,
    // fully-cached one it reads like a much faster link than it is: a 144p file
    // that finished downloading reported 3.9Mbps and justified a leap to
    // 1080p60, which the link then couldn't hold — down again twelve seconds
    // later. Stepping makes each climb a cheap experiment the next tick can
    // confirm or undo, and the ladder walks up to the highest rung that holds
    // instead of swinging between the top and the bottom.
    //
    // PAUSED is the exception, and it is the one moment the estimate can be
    // trusted whole: nothing is being consumed, the buffer isn't racing a
    // deadline, and the download running underneath is measuring the link
    // rather than the rung's own pacing. Stepping there just means the viewer
    // presses play on a rung several steps below what their connection has
    // already demonstrated. The target probe below still has the final say.
    const paused = this.stateManager.getState() === "paused";
    // …and so is a PACED link, where the number that sizes the jump is not
    // the rung's at all. The step rule guards against an estimate taken off
    // the rung being played; on a deep, steady buffer the target is sized off
    // the LINK instead — the remembered measurement and the probes — and then
    // the target itself is probed before it is entered, so what decides a
    // climb is a reading of the stream being climbed into.
    //
    // Probing only the next rung up made that reading useless as a guide to
    // anything further: one stream through the host's proxy fed 16-22Mbps on
    // a 40-45Mbps line, 3.9 and 7.2 when it shared the link with the playing
    // stream, and every climb was one rung and a cooldown — 480p to 1440p in
    // three switches on a link that carried 1440p from the start. So aim at
    // the highest rung the link is known to carry, and let each refusal bring
    // the aim down to what that rung's own stream actually delivered.
    const jumping = paced && !paused && this._autoQuality;
    if (jumping) {
      const linkBits = Math.max(sizingBits, loadPersistedLinkBps());
      let aimBits = Math.min(linkBits * 0.85, capBits);
      for (const r of rungs) {
        const reading = this._rungProbeBits.get(r.url);
        if (
          reading &&
          now - reading.at < MoviPlayer.ABR_PROBE_FRESH_MS &&
          reading.bits * 0.85 < (r.bandwidth || 0)
        ) {
          aimBits = Math.min(aimBits, reading.bits * 0.85);
        }
      }
      const aimIdx = rungs.findIndex((r) => (r.bandwidth || 0) <= aimBits);
      if (aimIdx >= 0 && aimIdx < activeIdx) {
        upIdx = aimIdx;
        up = rungs[upIdx];
      } else if (upIdx < activeIdx - 1) {
        upIdx = activeIdx - 1;
        up = rungs[upIdx];
      }
    } else if (!paused && upIdx < activeIdx - 1) {
      upIdx = activeIdx - 1;
      up = rungs[upIdx];
    }
    if (upIdx < activeIdx) {
      if (this._abrUpCandidate === up.url) {
        this._abrUpConfirms++;
      } else {
        this._abrUpCandidate = up.url;
        this._abrUpConfirms = 1;
      }
      // First upshift after enabling Auto commits at once (need 1); later ones
      // wait for 2 consecutive ticks so a lone spike can't bounce quality up.
      // Not a paced aim: the spike that rule is for is in the sustained
      // estimate, and a paced climb is decided by probes of the target, which
      // for a jump of more than one rung must agree twice (below).
      const need = this._abrPrimed && !jumping ? 2 : 1;
      if (this._abrUpConfirms >= need) {
        // Confirm the upshift with a fresh probe of the TARGET rung — but the
        // probe can only make the decision MORE conservative, never less. Take
        // the MIN of the sustained estimate and the probe: through a caching/
        // buffering proxy the probe's first slice can read at cache speed (a
        // 600+ MB/s burst), so trusting it OVER the sustained estimate would
        // re-introduce the "jumped to 1080p on a slow link" bug. A genuinely
        // fast link reads fast on BOTH; a slow link stays gated by whichever is
        // lower. So the probe only ever catches a stale-high estimate, it can't
        // inflate a real one.
        // A candidate that keeps confirming gets probed every couple of ticks,
        // and each probe is 2.4MB of real download. When the last reading of
        // this rung is recent AND was short of what the rung needs, it already
        // has its answer — re-measuring can only spend bytes to hear it again,
        // and on a paused player it was doing so on repeat. Reused only in the
        // direction that REFUSES; a reading that would authorise a climb is
        // always re-taken, because that is the one the vote below exists for.
        const prior = this._rungProbeBits.get(up.url);
        const priorAge = prior ? now - prior.at : Number.POSITIVE_INFINITY;
        if (
          prior &&
          priorAge < MoviPlayer.ABR_PROBE_MIN_GAP_MS &&
          prior.bits * 0.85 < (up.bandwidth || 0)
        ) {
          this._abrUpCandidate = "";
          this._abrUpConfirms = 0;
          Logger.debug(
            TAG,
            `ABR upshift to ${up.label || up.bandwidth} held — ${(prior.bits / 1e6).toFixed(1)}Mbps measured ${(priorAge / 1000) | 0}s ago still stands`,
          );
          return;
        }
        // Another probe already running is not a measurement of anything —
        // wait for the next tick rather than let the fallback decide. The
        // candidate and its confirmations stand.
        if (this._abrProbeInFlight) return;
        // Audio first. A probe is bandwidth spent on a BETTER picture, and the
        // split audio stream carries the thinnest buffer of the three things
        // sharing this link — so when it is already thin, taking a share for a
        // luxury is how a quality decision turns into a click in the speakers.
        // Held rather than decided around: nothing is lost by waiting, and
        // deciding without the probe is what hands the answer to a number
        // measured on the rung we are leaving.
        if (!this.disableAudio && !this.audioRenderer.hasHealthyBuffer()) {
          Logger.debug(
            TAG,
            "ABR upshift held — the audio buffer is thin, no bandwidth to spend on a probe",
          );
          return;
        }
        // A rung whose last probes measured nothing is not probed again on
        // the next tick. Each is up to 2MB, and a probe that came back empty
        // will usually come back empty again for the same reason — nothing
        // limited that, so it ran every four seconds for as long as the
        // candidate stood. Backs off 10s, 20s, 40s, capped at a minute, and a
        // reading clears it.
        const miss = this._rungProbeMisses.get(up.url);
        if (
          miss &&
          now - miss.at <
            Math.min(
              MoviPlayer.ABR_PROBE_MIN_GAP_MS * 2 ** (miss.count - 1),
              60_000,
            )
        ) {
          return;
        }
        const rawProbeBits = await this.probeRungThroughput(up.url);
        if (rawProbeBits > 0) {
          this._rungProbeMisses.delete(up.url);
        } else {
          this._rungProbeMisses.set(up.url, {
            count: (miss?.count ?? 0) + 1,
            at: now,
          });
        }
        // A rung gets probed again every time it comes up as a candidate, and
        // committing on the first reading that clears the bar is choosing the
        // best of N tries — which, with a variable link, is a near-certainty
        // given enough tries. This rung was read at 18.3, then 21.4, then
        // 30.6Mbps against a 25.9Mbps need, and the third reading — clearing by
        // 0.4% — is what put an 8K stream on screen that the link then could
        // not feed. The honest summary of those three numbers is "about 20".
        //
        // So a fresh earlier reading of the SAME rung has a vote, and the lower
        // one decides: two independent reads must agree before the ladder moves
        // into it. A link that genuinely improved says so on its next probe and
        // the climb costs one extra cycle; a spike says it once and is outvoted.
        const priorFresh =
          prior && priorAge < MoviPlayer.ABR_PROBE_FRESH_MS ? prior : null;
        let probeBits: number;
        if (rawProbeBits > 0) {
          probeBits = priorFresh
            ? Math.min(rawProbeBits, priorFresh.bits)
            : rawProbeBits;
          this._rungProbeBits.set(up.url, { bits: rawProbeBits, at: now });
          this._lastProbeBits = probeBits;
          this._lastProbeAt = now;
        } else if (priorFresh) {
          // A probe that returns nothing is "don't know", and don't-know must
          // not become yes. It used to: the fallback below hands the decision
          // to the sustained estimate, which is measured on the rung being
          // LEFT and, on a paused player, is stale on top of that. This rung
          // had been read twice at 24.7Mbps against a 25.9Mbps need and
          // refused both times; one unmeasurable probe later, a 52.3Mbps
          // number about another stream put 8K on screen. The readings we
          // already have are better evidence than a number about a different
          // file, and they stand until they go stale.
          probeBits = priorFresh.bits;
        } else {
          probeBits = rawProbeBits; // nothing known — the sustained estimate decides
        }
        // …except when the link is PACED, where "the sustained estimate" is not
        // an estimate of this rung at all.
        //
        // The branch above already refuses to let a don't-know become a yes
        // when there is an earlier reading to fall back on. With NO reading it
        // fell through to throughputBits, which is measured on the rung being
        // LEFT — and on a CDN that paces each stream to its own bitrate that is
        // a fact about a different file. Captured on an 8K ladder: the target
        // probe was thrown out as a cache hit ("1953KB in 18ms — cache or short
        // read, not the link"), and 72.9Mbps measured on the 2160p stream
        // authorised the climb into 4320p. Nothing had measured the 8K stream.
        //
        // Only in the paced case. Draining or on a thin buffer, throughputBits
        // is a real ceiling taken off a stream that is genuinely being pulled
        // as hard as it can be, so it still means something as a limit.
        if (paced && probeBits <= 0) {
          this._abrUpCandidate = "";
          this._abrUpConfirms = 0;
          Logger.info(
            TAG,
            `ABR upshift to ${up.label || up.bandwidth} held — nothing has measured that rung, and the ${(throughputBits / 1e6).toFixed(1)}Mbps we have is about the one we are on`,
          );
          return;
        }
        // MIN normally: with a shallow buffer the sustained number is a real
        // ceiling and the probe must not talk the estimate up past it.
        //
        // When paced, the probe DECIDES — it is no longer maxed against the
        // sustained rate. The sustained rate is measured on the rung being
        // LEFT, and on a CDN that paces each stream separately that is a fact
        // about a different file: the 2160p stream was feeding at 47Mbps while
        // the 8K stream it climbed into fed at 20, and the max let the first
        // number authorise the second. What the max was really for is the
        // paced under-read — a healthy buffer means the server feeds only as
        // fast as it needs to, so sustained is a floor and not a limit — and
        // the probe answers that directly now that it skips the opening burst.
        // Its verdict is about the rung being entered, which is the only rung
        // the question is about.
        const effectiveBits =
          probeBits > 0
            ? paced
              ? probeBits
              : Math.min(throughputBits, probeBits)
            : throughputBits;
        if (effectiveBits * 0.85 < (up.bandwidth || 0)) {
          // Can't sustain the higher rung — fold the tighter number into the
          // estimate and hold; the next tick re-decides on the truer value.
          //
          // Not in the paced case: there the number is a measurement of the
          // TARGET rung's stream, and writing it into the estimate that judges
          // the rung we are STAYING on would have one file's pacing argue for
          // downshifting another. The refusal above is the whole use for it.
          if (!(paced && probeBits > 0)) {
            this._lastThroughputBps = effectiveBits / 8;
          }
          this._abrUpCandidate = "";
          this._abrUpConfirms = 0;
          Logger.info(
            TAG,
            `ABR upshift to ${up.label || up.bandwidth} cancelled — ${(effectiveBits / 1e6).toFixed(1)}Mbps measured, rung needs ${((up.bandwidth || 0) / 1e6).toFixed(1)}Mbps`,
          );
          return;
        }
        // Last word before committing: a rung the CPU cannot hold is not a
        // candidate however fast the link is. The sizing cap earlier in this
        // tick works through BANDWIDTH, which is a proxy — a rung whose
        // bandwidth is missing or understated slips straight past it, and that
        // is how "ABR upshift 480p → 720p: 65.8Mbps" happened on a browser with
        // no WebCodecs, three seconds before "software decode can't hold 720p —
        // correcting to 480p" took it back. This reads the height itself.
        if (this.decodingOnCpu()) {
          const ceilingH = softwareDecodeCeiling(
            !!this.videoDecoder && !this.videoDecoder.isSoftware,
          );
          if (
            (up.height ?? 0) > ceilingH &&
            this.softwareCeilingApplies(up.codec)
          ) {
            this._abrUpCandidate = "";
            this._abrUpConfirms = 0;
            Logger.info(
              TAG,
              `ABR upshift to ${up.height}p refused — the CPU is decoding and can't hold past ${ceilingH}p`,
            );
            return;
          }
        }
        // A jump of more than one rung rests on two readings of the target,
        // not one. A single probe that clears the bar is the best of however
        // many tries it took, and on a variable link that is a matter of time;
        // the next tick reads it again and the lower of the two decides (see
        // priorFresh above). One rung up keeps the single reading — it is the
        // cheap experiment the step rule was always content with.
        if (
          jumping &&
          activeIdx - upIdx >= 2 &&
          !priorFresh &&
          rawProbeBits > 0
        ) {
          Logger.info(
            TAG,
            `ABR upshift to ${up.label || up.bandwidth} held for a second reading — ${(rawProbeBits / 1e6).toFixed(1)}Mbps on its own stream, rung needs ${((up.bandwidth || 0) / 1e6).toFixed(1)}Mbps`,
          );
          return;
        }
        Logger.info(
          TAG,
          `ABR upshift ${rungs[activeIdx].label || rungs[activeIdx].bandwidth} → ${up.label || up.bandwidth}: ${(effectiveBits / 1e6).toFixed(1)}Mbps ${probeBits <= 0 ? "sustained" : rawProbeBits <= 0 ? "last reading of the target rung" : paced ? "probed on the target rung" : "sustained∧probed"}, bufferAhead=${bufferAhead.toFixed(1)}s`,
        );
        await this.abrCommit(up.url, now);
      }
      return;
    }

    // Current rung sits inside the hysteresis dead-zone — hold, and clear any
    // half-formed upshift streak.
    this._abrUpCandidate = "";
    this._abrUpConfirms = 0;
  }

  /**
   * Quick active speed test against a specific rung's file. Fetches a small
   * head slice and returns the measured throughput in BITS/s (or -1 if it can't
   * measure — a failure just falls back to the passive estimate).
   *
   * Probing the TARGET rung, not the current one, is the point: it's a file the
   * browser has never fetched, so it hits the network fresh rather than reading
   * a cache, and it directly answers "can the link carry THIS rung?". Only used
   * to gate an UPSHIFT — a downshift happens because the buffer is already
   * draining, and adding a probe fetch into a struggling link would only slow
   * the recovery, so downshift stays reactive.
   */
  /** Last usable range-probe reading, and when it was taken. Reused to size the
   *  upshift candidate while the buffer is deep — see the paced-link note in
   *  abrTick. */
  private _lastProbeBits = 0;
  private _lastProbeAt = 0;
  /** Last probe reading per rung URL — the second opinion an upshift needs
   *  before the ladder moves into that rung. See the vote in abrTick. */
  private _rungProbeBits = new Map<string, { bits: number; at: number }>();
  /** Rungs whose in-place climb could not be primed, and until when the
   *  ladder aims below them. See the cap in abrDecide. */
  private _primeRefusals = new Map<string, { count: number; until: number }>();
  private static readonly PRIME_REFUSAL_MS = 30_000;
  private static readonly PRIME_REFUSAL_MAX_MS = 120_000;
  /** Probes of a rung that came back with no reading, and when the last one
   *  did — the backoff before asking that rung again. */
  private _rungProbeMisses = new Map<string, { count: number; at: number }>();
  /** How long a probe reading stays fresh enough to size a candidate from. */
  private static readonly ABR_PROBE_FRESH_MS = 60_000;
  /** How long a rung's own refusal stands before it is worth spending another
   *  2.4MB to re-ask. Two ABR ticks and a little. */
  private static readonly ABR_PROBE_MIN_GAP_MS = 10_000;

  private async probeRungThroughput(url: string): Promise<number> {
    if (this._abrProbeInFlight || this._destroyed) return -1;
    this._abrProbeInFlight = true;
    // Time only what arrives AFTER the opening burst, the way the pre-play
    // probe does.
    //
    // Timing the whole slice measured the burst, and a CDN that paces a stream
    // to its own bitrate gives every stream the same generous opening — so the
    // probe answered "how fast does this server start?" and not "how fast does
    // it feed?". The two numbers were 2x apart on the same file, minutes apart:
    // the pre-play probe read the 8K rung at 22.3Mbps and passed it over as
    // unaffordable; this one read the identical URL at 41.8Mbps, climbed into
    // it, and the stream then fed at ~20Mbps until the buffer starved and the
    // rung was abandoned 13 seconds later. The pre-play number was right, and
    // it was right because of how it was measured.
    // Every byte here is a byte the video and the split AUDIO stream do not
    // get, on a link that is already the reason a switch is being considered.
    // The log shows it plainly: the video stream halves, from 6.2MB/s to
    // 3.6MB/s, for as long as a probe runs — and audio, which carries the
    // least buffer of the three, is what the viewer hears break. So the probe
    // takes the smallest sample that answers the question and then stops,
    // rather than downloading a fixed slice to the end.
    const BURST_BYTES = 800_000; // the opening gift — not the link
    const BURST_MS = 250; // …and a slow link should not have to fund all of it
    const TIMED_BYTES = 600_000; // enough to be a measurement
    const TIMED_MS = 500;
    const PROBE_BYTES = 2_000_000; // hard ceiling, rarely reached
    // Its own 6s cap AND the player's lifetime: a probe is up to 2MB of a link
    // the viewer may already have navigated away from, and the local controller
    // this used to build was invisible to destroy().
    const ctl = childAbort(this.lifetimeSignal);
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const startedAt = performance.now();
      const res = await fetch(url, {
        headers: {
          Range: `bytes=0-${PROBE_BYTES - 1}`,
          ...(this.config.headers || {}),
        },
        // Ask the LINK, not the cache — the probe exists to measure the one and
        // the other cannot answer for it.
        //
        // Every probe reads the same opening range, so the first one put those
        // bytes in the HTTP cache and every probe after it was served from
        // there. The reading is then correctly thrown out ("cache or short
        // read, not the link"), which leaves the rung unmeasured, which is
        // exactly the state the paced guard below refuses to climb out of — so
        // it never climbs again. Seen on a 480p → 720p hold: "1953KB in 6ms"
        // thirteen times in a row, on a link that had probed at 79.5Mbps and a
        // buffer 349s deep. A ladder that can only ever step up once.
        //
        // `reload` bypasses the cache on the way out and still writes the
        // response back, so the bytes are there for the switch that follows.
        cache: "reload",
        signal: ctl.signal,
      });
      if ((!res.ok && res.status !== 206) || !res.body) {
        Logger.debug(TAG, `Rung probe: no body (HTTP ${res.status})`);
        return -1;
      }

      let total = 0;
      let timedBytes = 0;
      let timingStart = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        total += value.byteLength;
        const pastBurst =
          total > BURST_BYTES || performance.now() - startedAt > BURST_MS;
        if (pastBurst) {
          if (timingStart === 0) timingStart = performance.now();
          else timedBytes += value.byteLength;
        }
        // Enough of a sample. Everything after this would be bandwidth spent
        // to reach the same conclusion, so drop the connection and let the
        // streams that are actually feeding playback have it back.
        if (
          (timedBytes >= TIMED_BYTES &&
            performance.now() - timingStart >= 0.15 * 1000) ||
          (timingStart > 0 && performance.now() - timingStart >= TIMED_MS)
        ) {
          break;
        }
        if (total >= PROBE_BYTES) break;
      }
      try {
        await reader.cancel();
      } catch {}
      if (this._destroyed) return -1;
      const totalSecs = (performance.now() - startedAt) / 1000;
      // A body that arrived faster than any link could deliver it came from a
      // cache, not the network — no measurement beats a fictional one.
      if (totalSecs < 0.03 || total < 262144) {
        Logger.debug(
          TAG,
          `Rung probe: ${(total / 1024) | 0}KB in ${(totalSecs * 1000) | 0}ms — cache or short read, not the link`,
        );
        return -1;
      }
      // The chunk that starts the clock isn't counted, so a body that arrived
      // in one piece past the burst leaves nothing to time. Fall back to the
      // whole slice — burst-inflated, but the alternative is no number at all.
      if (timedBytes === 0) {
        if (totalSecs >= 0.15) return (total / totalSecs) * 8;
        Logger.debug(
          TAG,
          `Rung probe: whole slice in ${(totalSecs * 1000) | 0}ms — too quick to time`,
        );
        return -1;
      }
      const timedSecs = (performance.now() - timingStart) / 1000;
      if (timedSecs < 0.05) {
        // Too fast to time is an answer, not a failure: the whole slice came
        // in faster than the timing window can open, which a slow link cannot
        // do. Returning nothing made a fast link the one thing the ABR could
        // not measure — on a line that read 150Mbps, 30 probes in a row came
        // back "too short to time", each a 2MB download, and the paced guard
        // held every climb for want of a number. The whole slice, round trip
        // included, is a floor on what the link carries, and a floor is all a
        // climb needs.
        if (totalSecs >= 0.15) {
          Logger.debug(
            TAG,
            `Rung probe: past the burst in ${(timedSecs * 1000) | 0}ms — using the whole slice as a floor`,
          );
          return (total / totalSecs) * 8;
        }
        Logger.debug(
          TAG,
          `Rung probe: only ${(timedSecs * 1000) | 0}ms past the burst — too short to time`,
        );
        return -1;
      }
      return (timedBytes / timedSecs) * 8;
    } catch (e) {
      Logger.debug(TAG, `Rung probe failed: ${(e as Error)?.name || e}`);
      return -1;
    } finally {
      clearTimeout(timer);
      this._abrProbeInFlight = false;
    }
  }

  /** Perform an ABR switch and arm the anti-thrash cooldown/hysteresis. */
  private async abrCommit(url: string, now: number): Promise<void> {
    this._lastAbrSwitchAt = now;
    this._abrUpCandidate = "";
    this._abrUpConfirms = 0;
    this._abrPrimed = true; // subsequent upshifts use the 2-tick confirmation
    this._lastBufferAhead = 0; // buffer restarts from the resume point post-swap
    await this.abrSwitchTo(url);
  }

  private async abrSwitchTo(url: string): Promise<void> {
    this._abrSwitchInProgress = true;
    try {
      await this.switchVideoRenditionInPlace(url);
    } catch {
      /* keep the current rendition on failure */
    } finally {
      this._abrSwitchInProgress = false;
    }
  }

  /**
   * Relieve a DECODE/render bottleneck — the device can't sustain the CURRENT
   * rung's resolution even though the network is fine (buffer full, throughput
   * healthy), so frames are being dropped and playback stutters. The plain ABR
   * never sees this because it reads only network signals; this is driven off
   * the renderer's sustained frame-deficit detector instead. Drops ONE rung and
   * penalizes the one it leaves so the ABR won't climb straight back into a
   * resolution the device just proved it can't decode. A no-op unless Auto is on
   * and a lower rung exists — at the lowest rung (or with Auto off) the renderer's
   * FPS cap + software frame-skip remain the only levers. Re-fires naturally if
   * the lower rung is still too heavy: switchVideoRenditionInPlace reconfigures
   * the renderer, which re-arms its perf window for a fresh measurement.
   */
  /**
   * Ask the device, BEFORE climbing, whether it can actually play a rung.
   *
   * The reactive path learns a ceiling by climbing into a rung, stuttering for
   * a perf window or two, and dropping back out — so every machine that cannot
   * do 8K tries 8K, on a good connection, every time. MediaCapabilities answers
   * beforehand: decodingInfo() reports `smooth` (real-time) and
   * `powerEfficient` (hardware) for a codec at a resolution and frame rate.
   * A rung that isn't smooth here goes into the same ceiling the decode-bound
   * detector fills, so the ABR simply never offers it.
   *
   * Screened once per ladder, and only above 4K. Below that, software decode is
   * a legitimate option plenty of machines sustain, and screening it out would
   * cost quality on devices that were coping fine.
   *
   * Above it, three verdicts bar a rung: unsupported, not smooth, and NOT
   * powerEfficient. The last one matters because `smooth` is optimistic —
   * measured on a Mac, Chrome answers 8K AV1 with smooth:true even where
   * playback stutters, while 8K H.264 comes back powerEfficient:false. At that
   * size powerEfficient:false means a software decoder, and software 8K is not
   * real-time on anything. Whatever this misses, the decode-bound detector
   * still catches — once, now that the ceiling survives a reload.
   */
  private async screenRungsForDecodeCapability(
    rungs: {
      url: string;
      label?: string;
      height?: number;
      bandwidth?: number;
      codec?: string;
    }[],
  ): Promise<void> {
    await screenLadderForDecode(
      rungs,
      this.trackManager?.getActiveVideoTrack()?.frameRate || 30,
      this.videoDecoder?.configuredCodec || "",
      this.trackManager?.getActiveVideoTrack()?.height || 0,
      this._decodeScreened,
      MoviPlayer._isMobileDevice,
    );
  }

  private abrDeviceDownshift(): void {
    if (!this._autoQuality || this._abrSwitchInProgress) return;
    const rungs = this._dashRenditions
      .filter((r) => (r.bandwidth || 0) > 0)
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (rungs.length < 2) return;
    const activeIdx = rungs.findIndex(
      (r) => r.url === this._activeDashRendition,
    );
    if (activeIdx < 0 || activeIdx >= rungs.length - 1) return; // already lowest
    const now = performance.now();
    // Don't stack a device-downshift onto a just-made switch — the renderer needs
    // a fresh perf window on the new rung before the next decision is meaningful.
    if (now - this._lastAbrSwitchAt < 3000) return;
    const target = rungs[activeIdx + 1];
    const failing = rungs[activeIdx];
    const failingBw = failing.bandwidth || 0;
    this._abrPenalizedBandwidth = failingBw;
    // Cap this HEIGHT for the session on the FIRST decode-bound. The renderer
    // has already tried an FPS cap by now, so this means the device can't
    // sustain the resolution even at half rate — a device limit, not a
    // transient. Barring it (module-level, survives recreates) stops throughput
    // from re-climbing into it and re-stuttering (the log showed 4K re-tried 3×
    // before the old 2-fail cap engaged). Reload re-learns.
    const failH = failing.height ?? 0;
    const capped = failH > 0;
    if (capped) {
      const failCodec =
        this.videoDecoder?.configuredCodec || failing.codec || "";
      const failKey = decodeBoundKey(failCodec, failH);
      deviceDecodeBoundHeights.add(failKey);
      // What gets written down is the exact rung SHAPE, not the family at this
      // height — "8K AV1" is not one thing, and a machine that cannot hold a
      // 10-bit 8K rung may well hold an 8-bit one. The broad key still bars the
      // whole height for THIS SESSION, which is what stops the re-climb loop;
      // it just doesn't follow the device around forever. With no codec string
      // to be exact about there is nothing finer to say, so the broad key is
      // what persists, as before.
      const failExact = decodeBoundExactKey(failCodec, failH);
      if (failExact) {
        deviceDecodeBoundHeights.add(failExact);
        sessionOnlyDecodeBoundHeights.add(failKey);
      }
      // …but only WRITE IT DOWN if the hardware path was the one that failed.
      // A software-decoding session cannot hold 720p on a phone and says
      // nothing about what the GPU can do — yet this was persisted all the
      // same, and every later session (hardware, WebCodecs, prefer-hardware)
      // read it back and barred those rungs. Auto then sat at 480p on a link
      // measuring 29.7Mbps, permanently, with no way back short of clearing
      // storage. The in-memory bar still stands for THIS session, which is
      // what stops the re-climb-and-restutter loop.
      if (!this.isSoftwareDecoding()) {
        persistDecodeCeiling();
      } else {
        sessionOnlyDecodeBoundHeights.add(failKey);
        if (failExact) sessionOnlyDecodeBoundHeights.add(failExact);
        Logger.info(
          TAG,
          `ABR: ${failH}p barred for this session only — software decode failing says nothing about the hardware path`,
        );
      }
    }
    this._abrPenaltyUntil = Math.max(
      this._abrPenaltyUntil,
      now + MoviPlayer.ABR_DECODE_PENALTY_MS,
    );
    Logger.info(
      TAG,
      `ABR: device decode-bound at ${failing.label || failingBw + "bps"}${failH ? " (" + failH + "p)" : ""} — dropping to ${target.label || target.bandwidth + "bps"}${capped ? ` and capping ${failH}p+ for this session` : " to relieve stutter"}`,
    );
    void this.abrCommit(target.url, now);
  }

  /**
   * Last resort: the video has stopped moving under running audio and the
   * normal ABR hasn't rescued it. Bail out to the LOWEST rung immediately.
   *
   * Everything the ordinary downshift weighs — the 5s settle, the 12s cooldown,
   * "is the source coasting", the throughput estimate — exists to keep quality
   * from flapping on a healthy link. None of it applies once playback has
   * actually stopped: the rung has been disproven by the outcome, so this
   * skips the lot and goes straight to the bottom of the ladder, whose small
   * file also preps fastest.
   *
   * Retried once, because the failure that gets here is usually a flaky link
   * and the rescue's own open has to cross the same one — a single fumbled
   * size probe was enough to leave a real session frozen until the viewer
   * seeked by hand.
   *
   * Auto only. A rung the viewer picked by hand is their decision, and this
   * does not get to overrule it: if the link can't carry 1080p, a viewer who
   * asked for 1080p gets buffering, not a quality they didn't choose. (It used
   * to override the pick once playback stopped, on the grounds that a stalled
   * picture helps nobody. The choice is the viewer's to make and to change.)
   *
   * Returns the label of the rung it moved to, or null when there was nothing
   * to switch to (Auto off, no ladder, already lowest) — then the caller falls
   * back to its own recovery.
   */
  /**
   * How long the picture has been catching up to the sound, in ms — null when
   * it is not. The wait is normally under a tenth of a second, so the UI can
   * hold its spinner back for a moment rather than flashing one on every
   * return from a background tab.
   */
  videoCatchUpElapsedMs(): number | null {
    if (this._videoResumeTarget < 0) return null; // -1 none, -Infinity finished
    return performance.now() - this._videoCatchUpStartedAt;
  }

  /**
   * Milliseconds since a rendition switch last LANDED (Infinity if none has).
   * The picture is legitimately still for a moment after one — the queue was
   * emptied at the swap and the new decoder has not filled it yet — so the
   * element's frozen-video watchdog needs to know the difference between that
   * and a stall.
   */
  msSinceRenditionSwitch(): number {
    return performance.now() - this._lastAbrSwitchAt;
  }

  async abrEmergencyDownshift(reason: string): Promise<string | null> {
    if (!this._autoQuality || this._abrSwitchInProgress) return null;
    // A rung that was only just switched to has nothing buffered yet BY
    // DEFINITION — every switch starts a new file from zero. Rescuing that
    // state drops another rung, which starts another empty buffer, which looks
    // like starvation again: the log showed 480p → 360p → 240p in twelve
    // seconds, each step "rescuing" the refill of the step before. Give a fresh
    // rung the same settle the ordinary downshift gets.
    if (performance.now() - this._lastAbrSwitchAt < 10000) return null;
    // Same reasoning as the ordinary downshift: with the download finished
    // there is no link to relieve, so whatever froze the picture — decode, or
    // simply the end of the file — a lower rung cannot address it, and the
    // switch would cost a re-open and a spinner to prove that.
    if (this.nothingLeftToFetch()) return null;
    const rungs = this._dashRenditions
      .filter((r) => (r.bandwidth || 0) > 0)
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (rungs.length < 2) return null;
    const activeIdx = rungs.findIndex(
      (r) => r.url === this._activeDashRendition,
    );
    if (activeIdx < 0 || activeIdx >= rungs.length - 1) return null; // already lowest
    // Aim at what the link is actually delivering rather than diving straight to
    // the bottom: dropping a 4320p pick to 144p over one bad minute is its own
    // kind of broken. With no usable reading, the lowest rung is the safe
    // answer — its small file also preps fastest, so playback resumes soonest.
    const ns = (
      this.source as {
        getNetworkStats?: () => { currentSpeed: number; lastSpeed?: number };
      } | null
    )?.getNetworkStats?.();
    // A frozen source often reports no live speed at all, and reading that as
    // "the link is dead" sent a 480p stall straight to 144p. The remembered
    // estimate is the better answer when there is no fresh one.
    const measuredBits =
      ((ns?.lastSpeed ?? ns?.currentSpeed ?? 0) ||
        0 ||
        this._lastThroughputBps) * 8;
    let target = rungs[rungs.length - 1];
    if (measuredBits > 0) {
      for (let i = activeIdx + 1; i < rungs.length; i++) {
        if ((rungs[i].bandwidth || 0) <= measuredBits * 0.8) {
          target = rungs[i];
          break;
        }
      }
    }
    const now = performance.now();
    // Bar the rung that stalled (and everything above it) from being climbed
    // back into on the next spike — it just proved it can't be sustained.
    const failingBw = rungs[activeIdx].bandwidth || 0;
    this._abrPenalizedBandwidth = failingBw;
    this._abrPenaltyUntil = Math.max(
      this._abrPenaltyUntil,
      now + MoviPlayer.ABR_PENALTY_MS * 2,
    );
    Logger.warn(
      TAG,
      `ABR emergency downshift (${reason}): ${rungs[activeIdx].label || failingBw} → ${target.label || target.bandwidth}`,
    );
    this._lastAbrSwitchAt = now;
    this._abrUpCandidate = "";
    this._abrUpConfirms = 0;
    this._lastBufferAhead = 0;
    this._abrSwitchInProgress = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (await this.switchVideoRenditionInPlace(target.url)) {
            return (
              target.label ||
              `${Math.round((target.bandwidth || 0) / 1000)}kbps`
            );
          }
        } catch {
          /* fall through to the retry */
        }
        if (this._destroyed) return null;
        await new Promise((r) => setTimeout(r, 400));
      }
    } finally {
      this._abrSwitchInProgress = false;
    }
    return null;
  }

  private async configureDecoders(): Promise<void> {
    if (!this.demuxer) return;

    // Configure video renderer/decoder
    const videoTrack = this.trackManager.getActiveVideoTrack();
    if (videoTrack && this.videoDecoder) {
      // Use WebCodecs - configure decoder
      const extradata = this.demuxer.getExtradata(videoTrack.id) ?? undefined;

      // Pass explicit frame rate override if present (for throttling)
      const targetFps = this.config.frameRate ?? 0;

      const configured = await this.videoDecoder.configure(
        videoTrack,
        extradata,
        targetFps,
      );
      if (configured) {
        Logger.info(
          TAG,
          `Video decoder configured: ${videoTrack.codec} ${videoTrack.width}x${videoTrack.height}`,
        );
        // The ladder usually arrives BEFORE this (the quality menu hands it
        // over as soon as the element parses its <source> children), and the
        // capability screen needs the codec string, which only exists once the
        // decoder has been configured. Run it again now that it does.
        void this.screenRungsForDecodeCapability(this._dashRenditions);
        if (this.videoRenderer) {
          // Pass color space metadata for HDR detection and frame rate for 60fps conversion
          // Support manual frame rate override (fps parameter)
          const frameRate = this.config.frameRate || videoTrack.frameRate;

          this.videoRenderer.configure(
            videoTrack.width,
            videoTrack.height,
            videoTrack.colorPrimaries,
            videoTrack.colorTransfer,
            frameRate,
            videoTrack.rotation ?? 0,
            videoTrack.isHDR,
            videoTrack.pixelFormat,
          );
        }
      } else {
        Logger.warn(TAG, "Failed to configure video decoder");
      }
    }

    // Configure audio decoder (skip if disabled for debugging)
    // Configure audio decoder (skip if disabled for debugging or native audio)
    const audioTrack = this.trackManager.getActiveAudioTrack();
    if (audioTrack && !this.disableAudio) {
      const extradata = this.demuxer.getExtradata(audioTrack.id) ?? undefined;
      const configured = await this.audioDecoder.configure(
        audioTrack,
        extradata,
      );
      if (configured) {
        Logger.info(
          TAG,
          `Audio decoder configured: ${audioTrack.codec} ${audioTrack.sampleRate}Hz ${audioTrack.channels}ch`,
        );
        // Pre-initialize AudioContext during load (created suspended, no audio plays).
        // Moves ~500ms creation cost from play() to load() for instant playback start.
        // init() no longer resumes — play() handles resume on user gesture.
        if (!this.disableAudio) {
          // Tell the renderer the source's rate BEFORE it builds the context.
          // The context is created once, at whatever rate it is given, and a
          // context that does not match the source resamples every buffer it
          // is handed — audibly, as periodic clicking, because each buffer is
          // resampled with its own filter state and the seams land at the
          // buffer boundaries. AudioRenderer already knows to ask for the
          // source rate; it just has to have been told what that is, and
          // init() is the last moment that is true.
          //
          // Only PlaybackController did this. Both paths here went straight to
          // init(), so _sourceSampleRate was still 0 and the context came up
          // at the device default — 48000 on Android against a 44100 source,
          // which is why the clicking was a mobile-only report. Desktop
          // Chrome usually opens its default context at 44100 and the mismatch
          // never arises.
          this.audioRenderer.configure(
            audioTrack.sampleRate,
            audioTrack.channels,
          );
          // Await so we can read destination.maxChannelCount synchronously
          // before deciding the downmix policy. Init is cheap; the
          // perf-sensitive bit (`resume`) is still gated on the user
          // gesture in play().
          await this.audioRenderer.init();
          // Preserve native channel layout when the device can drive
          // every plane (e.g. 7.1 over HDMI / DAC reporting
          // maxChannelCount=8). Otherwise leave the WASM downmix on
          // — FFmpeg's matrix is higher quality than Web Audio's
          // automatic "speakers" interpretation fallback.
          const sourceCh = audioTrack.channels ?? 2;
          const maxCh = this.audioRenderer.getMaxChannelCount();
          if (sourceCh > 2 && maxCh >= sourceCh) {
            Logger.info(
              TAG,
              `Multichannel passthrough: source ${sourceCh}ch, destination supports ${maxCh}ch`,
            );
            this.audioDecoder.setDownmix(false);
            this.audioRenderer.setOutputChannelCount(sourceCh);
          } else if (sourceCh > 2) {
            Logger.info(
              TAG,
              `Downmixing to stereo: source ${sourceCh}ch, destination caps at ${maxCh}ch`,
            );
          }
        }
      } else {
        Logger.warn(TAG, "Failed to configure audio decoder");
      }
    } else if (audioTrack && this.disableAudio) {
      Logger.info(TAG, "Audio processing disabled for debugging");
    }

    // Drop unused audio tracks from the demuxer read path (issue #11).
    this.applyStreamDiscard();

    // Configure subtitle decoder
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (subtitleTrack && this._customRendererFor(subtitleTrack)) {
      // A host renderer owns subtitles — configure it and skip the internal path.
      await this._configureCustomSubtitleRenderer();
    } else if (subtitleTrack && this.subtitleDecoder) {
      const extradata =
        this.demuxer.getExtradata(subtitleTrack.id) ?? undefined;
      const configured = await this.subtitleDecoder.configure(
        subtitleTrack,
        extradata,
      );
      if (configured) {
        Logger.info(
          TAG,
          `Subtitle decoder configured: ${subtitleTrack.codec} (${subtitleTrack.subtitleType || "unknown"} type)`,
        );

        // Set up subtitle cue callback
        this.subtitleDecoder.setOnCue((cue) => {
          Logger.debug(
            TAG,
            `Subtitle cue received: "${cue.text?.substring(0, 30)}..." (${cue.start.toFixed(2)}s - ${cue.end.toFixed(2)}s)`,
          );
          // Update subtitle cues on video renderer
          if (this.videoRenderer) {
            // Get current cues and add/update this one
            // For simplicity, we'll just set a single cue for now
            // In a full implementation, we'd maintain a cue list
            Logger.debug(TAG, "Setting subtitle cue on video renderer");
            this.videoRenderer.setSubtitleCues([cue]);
          } else {
            Logger.warn(
              TAG,
              "Subtitle cue received but videoRenderer is null!",
            );
          }
        });

        // Set bindings (should already be set in load(), but set again to be safe)
        const bindings = this.demuxer.getBindings();
        if (bindings) {
          this.subtitleDecoder.setBindings(bindings, false); // Don't auto-configure, we're configuring manually
        }
      } else {
        Logger.warn(
          TAG,
          `Failed to configure subtitle decoder for track ${subtitleTrack.id} (${subtitleTrack.codec}) - subtitles will not be displayed`,
        );
      }
    }
  }

  /**
   * Pre-read a small amount of media into the packet queues before reporting
   * "ready". On short videos the demux burst can drain the file faster than
   * the HTTP source delivers bytes, tripping the stall detector the moment
   * play() starts; reading ahead gives the source layer more time to buffer
   * bytes.
   *
   * We deliberately do NOT decode here — the video decoder's onFrame
   * callback drops frames whenever state !== "playing", and the audio
   * renderer starts AudioContext playback the moment samples arrive. Both
   * break if we decode during prebuffer. Nothing feeds the decoders until
   * processLoop runs, so queuing is enough.
   */
  private async prebuffer(): Promise<void> {
    if (!this.demuxer) return;

    const hasVideoTrack = !!this.trackManager.getActiveVideoTrack();
    const hasInFileAudio =
      !!this.trackManager.getActiveAudioTrack() && !this.disableAudio;

    if (!hasVideoTrack && !hasInFileAudio) return;

    const startWall = performance.now();
    let packetsRead = 0;
    let videoPacketsStashed = 0;
    let audioDurationStashed = 0;
    let eof = false;

    const videoTargetMet = () =>
      !hasVideoTrack ||
      videoPacketsStashed >= MoviPlayer.PREBUFFER_VIDEO_FRAMES;
    const audioTargetMet = () =>
      !hasInFileAudio ||
      audioDurationStashed >= MoviPlayer.PREBUFFER_AUDIO_SECONDS;

    // Once audio has what it needs, keep looking for the video frames — but not
    // to the end of the packet budget. A file can interleave so much audio at
    // the head (two TrueHD tracks and PGS subtitles, in the case this was found
    // on) that chasing a second video frame reads hundreds of audio packets
    // before the player has even been asked to play. Past this point the
    // pipeline is better off starting and letting the normal read loop find
    // the rest.
    // Packets read at the moment audio was satisfied; the video search gets a
    // bounded number of packets beyond it.
    let audioMetAt = -1;
    const packetBudget = () => {
      if (audioMetAt < 0 && audioTargetMet()) {
        audioMetAt = packetsRead;
      }
      return audioMetAt < 0
        ? MoviPlayer.PREBUFFER_MAX_PACKETS
        : Math.min(
            MoviPlayer.PREBUFFER_MAX_PACKETS,
            audioMetAt + MoviPlayer.PREBUFFER_VIDEO_SEARCH_PACKETS,
          );
    };
    while (
      (!videoTargetMet() || !audioTargetMet()) &&
      !eof &&
      packetsRead < packetBudget()
    ) {
      if (performance.now() - startWall > MoviPlayer.PREBUFFER_MAX_WALL_MS) {
        Logger.warn(
          TAG,
          `Prebuffer wall-clock timeout after ${MoviPlayer.PREBUFFER_MAX_WALL_MS}ms`,
        );
        break;
      }

      let packet: Packet | null;
      const readEpoch = this._refreshEpoch;
      try {
        packet = await this.demuxer.readPacket();
      } catch (err) {
        Logger.warn(TAG, "Prebuffer demux error, aborting prebuffer", err);
        break;
      }

      if (!packet) {
        eof = true;
        break;
      }
      packetsRead++;
      this.enqueuePacket(packet, readEpoch !== this._refreshEpoch);

      if (!this.trackManager.isActiveStream(packet.streamIndex)) continue;

      const activeVideo = this.trackManager.getActiveVideoTrack();
      const activeAudio = this.trackManager.getActiveAudioTrack();

      if (
        hasVideoTrack &&
        activeVideo &&
        activeVideo.id === packet.streamIndex
      ) {
        videoPacketsStashed++;
      } else if (
        hasInFileAudio &&
        activeAudio &&
        activeAudio.id === packet.streamIndex
      ) {
        audioDurationStashed += packet.duration > 0 ? packet.duration : 0.02;
      }
    }

    Logger.info(
      TAG,
      `Prebuffer complete: read=${packetsRead}, video=${videoPacketsStashed}, audio=${audioDurationStashed.toFixed(2)}s, eof=${eof}`,
    );
  }

  /**
   * Start playback
   */
  play(): Promise<void> {
    if (this.playInFlight) return this.playInFlight;

    const operation = this.playInternal();
    this.playInFlight = operation;
    operation.then(
      () => {
        if (this.playInFlight === operation) this.playInFlight = null;
      },
      () => {
        if (this.playInFlight === operation) this.playInFlight = null;
      },
    );
    return operation;
  }

  private async playInternal(): Promise<void> {
    if (this.streamWrapper) {
      return this.streamWrapper.play();
    }

    // Stop pause-time buffering — we're resuming active playback
    this.stopPauseBuffering();
    // …and let the window slide with the reader again, once the first read
    // of this play has landed (the realignment below re-reads a keyframe).
    if (this.source instanceof HttpSource)
      this.source.releaseWindowAfterNextRead();

    // Fallback stamp for callers that drive playback without going through
    // load() — normally load() sets this. Lets ABR tell "the buffer hasn't
    // filled yet" apart from "this rung can't be sustained".
    if (this._playbackStartedAt === Number.NEGATIVE_INFINITY) {
      this._playbackStartedAt = performance.now();
    }

    if (!this.stateManager.canPlay()) {
      Logger.warn(TAG, "Cannot play in current state");
      return;
    }

    const currentState = this.stateManager.getState();

    // During buffering or seeking, mark intent to resume when ready
    if (currentState === "buffering" || currentState === "seeking") {
      this.wasPlayingBeforeRebuffer = true;
      Logger.info(
        TAG,
        `Play requested during ${currentState} — will resume when ready`,
      );
      return;
    }

    const wasEnded = currentState === "ended";

    // Replay path: delegate to seek(0). The full seek pipeline runs flush +
    // demuxer.seek + waitingForVideoSync + keyframe wait, and on first frame
    // notifySeekCompletion syncs the clock to the actual first decodable PTS
    // (matters for Open-GOP sources where the first ~2s have no usable IDR —
    // without this the clock advances from startTime while video stays
    // frozen, so EOF fires ~2s early and no buffering UI is shown). Setting
    // wasPlayingBeforeSeek after the await flips the resume path so the
    // seek completion transitions straight to "playing".
    if (wasEnded && this.demuxer) {
      Logger.debug(TAG, "Replaying from beginning after ended state");
      // This branch serves a manual replay too — pressing play on a finished
      // file. Only a looping one is a loop.
      if (this._loopEnabled) this.noteLoopTurn();
      this.requestWakeLock();
      // Set the resume intent BEFORE awaiting seek(0). Replay data is always
      // already buffered, so notifySeekCompletion can fire synchronously
      // inside the await — if wasPlayingBeforeSeek is still false at that
      // point, seek completion takes the "paused" branch and replay stalls at
      // the first frame instead of resuming. seek() itself derives
      // wasPlayingBeforeSeek from the entry state ("ended" → false), which is
      // why we must force it true here up front rather than after the await.
      this.wasPlayingBeforeSeek = true;
      // Re-arm the play grace so the stall/desync detectors don't fire on the
      // replay-seek transient. Right after "Replaying from beginning" the video
      // renderer's currentTime is still stale at the ended position (~duration)
      // while audio resets to 0 — without a fresh grace the desync detector sees
      // a ~full-duration "behind" and kicks off a spurious resync seek (an
      // audible trip at the start of every replay).
      this._playStartTime = performance.now();
      // The replay seek(0) flushes the audio decoder like any seek, so heavy
      // software audio (TrueHD/DTS) re-primes automatically via the seek-resume
      // path — no separate first-play re-arm needed. Codec-gated, so
      // hardware/lightweight audio replays stay instant.
      try {
        await this.seek(0, { suppressSpinner: true });
      } catch (error) {
        this.suppressSeekSpinner = false;
        this.wasPlayingBeforeSeek = false;
        Logger.warn(TAG, "Failed to seek to start on replay", error);
      }
      return;
    }
    // If resuming from paused state, seek to current time to ensure demuxer is at correct position

    // Fire-and-forget WakeLock (no need to block play for screen sleep prevention)
    this.requestWakeLock();

    // First play after poster seek: re-seek demuxer to the clock's current
    // time. Poster seek's processLoop reads the demuxer ahead (~1s) while
    // decoding the first video frame, so the demuxer cursor is out of sync
    // with where we actually want playback to start. Re-seeking realigns it.
    //
    // IMPORTANT: respect any user seek that happened before the first play —
    // read the target from the clock (which getTime() reports as paused or
    // seeked position), NOT the hardcoded startTime. Previously we always
    // seeked to startTime here, which silently discarded a pre-play scrub
    // and restarted from the beginning.
    // Guard: only treat this as the first play when the clock is still parked
    // at the start. _playStartTime is the primary signal, but if anything ever
    // leaves it at 0 mid-session, this stops the first-play seek(0) from
    // dragging an in-progress video (clock well past startTime) back to zero.
    const atStart = this.clock.getTime() <= this.startTime + 1;
    if (this._playStartTime === 0 && atStart && this.demuxer) {
      // First play: always seek to 0. The poster seek's processLoop reads the
      // demuxer ~1s ahead while decoding the first video frame, so the cursor
      // is out of sync with the start. Re-seeking to 0 realigns it so playback
      // begins cleanly from the beginning. The full seek pipeline runs
      // waitingForVideoSync + keyframe wait and notifySeekCompletion syncs the
      // clock to the actual first decodable PTS — same path as replay, so
      // buffering UI, A/V sync and EOF timing all behave identically.
      // Set wasPlayingBeforeSeek BEFORE the await: seek() enters from the
      // "paused" state and would otherwise derive it as false, so a fast
      // (already-buffered) completion firing inside the await would take the
      // paused branch and stall instead of starting playback. seek()'s
      // re-derivation now skips when this is already true.
      const uiTarget = 0;
      this.wasPlayingBeforeSeek = true;
      try {
        // Realigning the demuxer after the poster seek is housekeeping, not a
        // seek anybody asked for: pressing play on a fresh element reports no
        // seeking/seeked at all, and this one used to make it look as though
        // the viewer had scrubbed before playback began. (The replay-from-ended
        // seek above stays audible — an element genuinely does report that
        // one.)
        await this.seek(uiTarget, { suppressSpinner: true, internal: true });
        this._playStartTime = performance.now();
      } catch (error) {
        this.suppressSeekSpinner = false;
        this.wasPlayingBeforeSeek = false;
        Logger.warn(TAG, "First-play seek failed", error);
      }
      return;
    }

    if (this._playStartTime === 0 && this.demuxer) {
      const targetTime = this.clock.getTime();
      // Said out loud, because its absence is invisible: when this does NOT run
      // the only symptom is a picture that holds still for as long as the gap,
      // with nothing else in the log to explain it.
      Logger.info(
        TAG,
        `Realigning the demuxer to the clock at ${targetTime.toFixed(3)}s before first play`,
      );

      // Flush the decode pipeline before re-seeking the demuxer. The
      // poster seek's processLoop reads ahead, racing the demuxer cursor
      // ahead of pts=0 while it hunts for the first video frame. Without a
      // flush + audio reset here, the first audio packet
      // that surfaces after demuxer.seek(targetTime) can land at a stale
      // interleaved PTS (e.g. 2.6s), starting the audio timeline there
      // and forcing video to skip ahead to catch up — the first-play
      // stutter. Mirrors the replay path which flushes + resets first.
      await this.videoDecoder.flush();
      await this.audioDecoder.flush();
      if (this.videoRenderer) this.videoRenderer.clearQueue();
      this.audioRenderer.reset();

      // Seek the demuxer first; only after it completes do we resume the
      // audio context. Running them concurrently let the audio renderer
      // accept the very first decoded packet before the demuxer cursor
      // had finished rewinding.
      //
      // Guard the seek: the demuxer rejects with "error -1" when the source
      // opened in a degenerate state (e.g. a non-faststart file whose prebuffer
      // hit EOF with zero frames, or a rapid source-switch that tore down the
      // read path mid-open). Unguarded, it escaped as an uncaught rejection —
      // and with the caller re-issuing play() it spammed/looped. Bail cleanly
      // and mark the source unplayable so the UI can show the broken state
      // instead of retrying a seek that can never succeed.
      try {
        await this.demuxer.seek(targetTime, 1, this.getSeekStreamIndex());
      } catch (error) {
        Logger.error(TAG, "Demuxer realignment seek on play failed", error);
        this.wasPlayingBeforeSeek = false;
        this.suppressSeekSpinner = false;
        this.stateManager.setState("error");
        this.emit(
          "error",
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
      // After Open-GOP recovery (decoder rejected the first keyframe past
      // the seek target and reset), the next decoded frames will begin at
      // the previous GOP's keyframe — often 1-2s behind targetTime. Without
      // the seekTargetTime guard those pre-target frames get presented and
      // video lags audio for the rest of the GOP. Re-arm only the filter
      // (not waitingForVideoSync) — onFrame's pre-target drop check at the
      // top of the handler reads seekTargetTime alone, while leaving
      // waitingForVideoSync false keeps notifySeekCompletion from firing
      // and clobbering the state machine that play() is about to drive
      // into "playing" right below.
      this.seekTargetTime = targetTime;
      if (!this.disableAudio) {
        await this.audioRenderer.play();
      }
      this.clock.seek(targetTime);
      // Discard pause-time buffered packets — demuxer was just re-seeked,
      // so queued packets are stale (would feed later timestamps into the
      // decoder, making first frame jump ahead instead of starting at targetTime).
      this.clearPacketQueues();
      this.resetEof();
    } else {
      if (!this.disableAudio) {
        await this.audioRenderer.play();
      } else {
        Logger.debug(TAG, "Audio playback skipped (disabled for debugging)");
      }

      // Drop frames left in the queue that are stale relative to the clock.
      // This handles the rapid open→play→fullscreen→track-toggle case where
      // a decoder reset (Open GOP) re-decodes from an earlier reference
      // frame, leaves those frames queued during pause, and then presents
      // them on resume — causing a multi-second video lag behind audio.
      if (this.videoRenderer) {
        this.videoRenderer.dropStaleFrames(this.clock.getTime(), 0.2);
      }
    }

    // Start video presentation loop for smooth 60Hz playback
    if (this.videoRenderer) {
      this.videoRenderer.startPresentationLoop();
    }

    this.clock.start();
    this._playStartTime = performance.now();

    // Transition to playing state
    // At this point, state should be 'ready', 'paused', or 'seeking' (never 'ended' as it's handled above)
    const stateForPlay = this.stateManager.getState();
    if (
      stateForPlay === "ready" ||
      stateForPlay === "paused" ||
      stateForPlay === "seeking"
    ) {
      // Arrived — the state itself carries the queue open from here.
      this._resumeToPlayPending = false;
      if (!this.stateManager.setState("playing")) {
        Logger.error(
          TAG,
          `Failed to transition to playing from state: ${stateForPlay}`,
        );
        this.clock.pause();
        return;
      }
    } else if (stateForPlay !== "playing") {
      Logger.error(
        TAG,
        `Cannot transition to playing from state: ${stateForPlay}`,
      );
      this.clock.pause();
      return;
    }
    // Already playing is not a failure — it is this call's own goal, reached
    // by something else while we were awaiting above.
    //
    // play() is async and everything between the entry check and here can
    // yield: resuming the AudioContext, a first-play re-seek, a decoder flush.
    // A seek completing in that window resumes playback itself, so this call
    // comes back to a state it was on its way to setting. canPlay() bars
    // "playing" at the door, so this can only ever be that race.
    //
    // It used to fall into the branch above, which logs an error and PAUSES
    // THE CLOCK — undoing the playback that had just started. Read off a
    // Safari session's unmute, where the tap runs an audio resync seek and a
    // play() together: "Cannot transition to playing from state: playing",
    // then "Clock: Paused at 0.00026s", and the only reason it survived is
    // that the unmute re-seeks immediately afterwards and starts it again.
    // Nothing to transition, nothing to undo: fall through to the loops.

    // Start demux loop
    // Cancel any existing animation frame to prevent duplicates
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Resuming while the tab is hidden (e.g. a Media Session / lock-screen play,
    // or a media-key press with the tab in the background): the rAF-driven
    // processLoop is throttled to ~1fps in background tabs, so decode falls
    // behind and audio starves and stops within seconds. Drive decode off the
    // un-throttled background Worker timer instead — pause() tore it down, and
    // if the tab was hidden while already paused it was never started. Mirror
    // the hide path's setup (drop video presentation; frames are discarded while
    // hidden anyway). Gated on audio, matching handleVisibilityChange — a
    // no-audio hidden source would just race the demuxer to EOF.
    const resumingHidden =
      typeof document !== "undefined" &&
      document.visibilityState === "hidden" &&
      !this.isPiPActive;
    if (resumingHidden) {
      this.isBackgrounded = true;
      if (this.videoRenderer) {
        this.videoRenderer.stopPresentationLoop();
        this.videoRenderer.clearQueue();
      }
      this.ensureBackgroundPump();
    }

    // In WASM split audio-only mode the main (video) demux loop stays parked —
    // resuming it would re-download + decode the video body we're saving. Only
    // the audio loop runs. (Muxed audio-only DOES run processLoop, whose own
    // _audioOnly check skips just the video decode while decoding in-file
    // audio.)
    if (!(this._audioOnly && this.audioDemuxer)) {
      this.processLoop();
    }
    this.startAudioLoop();

    Logger.info(TAG, "Playing");
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (this.streamWrapper) {
      this.streamWrapper.pause();
      return;
    }

    // A pause ends whatever a seek was still working through, including the
    // spinner suppression its own re-prime buffering holds (see
    // notifySeekCompletion). Left latched, a genuine stall much later would
    // show no spinner at all.
    this.suppressSeekSpinner = false;

    // A pause lands on top of a resume that had not arrived yet — the viewer
    // changed their mind mid-flight. Nothing is resuming any more.
    this._resumeToPlayPending = false;

    if (!this.stateManager.canPause()) {
      Logger.warn(TAG, "Cannot pause in current state");
      return;
    }

    // Pause requested while a seek is still in flight. The seek owns the state
    // machine until it completes, so we do NOT force "paused" here — that would
    // race handleSeekComplete's own final-state transition. Instead drop the
    // resume intent, which lands the seek in its "Seek completed in paused
    // state" branch, and stop the output side immediately so the tap feels
    // instant. Without this the pause was silently dropped ("Cannot pause in
    // current state") and playback resumed on its own once the seek landed —
    // wide open on a software-decoded phone, where seeks run for seconds and
    // the frozen picture reads as "already paused".
    if (this.stateManager.getState() === "seeking") {
      this.wasPlayingBeforeSeek = false;
      this.wasPlayingBeforeRebuffer = false;
      this.releaseWakeLock();
      this.clock.pause();
      if (!this.disableAudio) this.audioRenderer.pause();
      if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
      this.stopBackgroundTimer();
      Logger.info(TAG, "Paused during seek — seek will settle into paused");
      return;
    }

    // During buffering, transition to paused and stop auto-resume
    if (this.stateManager.getState() === "buffering") {
      this.wasPlayingBeforeRebuffer = false;
      if (!this.disableAudio) this.audioRenderer.pause();
      if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
      this.stateManager.setState("paused");
      // No tick will run for a held speed change once paused.
      this.maybeApplyPendingRate();
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.stopBackgroundTimer();
      this.startPauseBuffering();
      Logger.info(TAG, "Paused during buffering");
      return;
    }

    // Release WakeLock when pausing
    this.releaseWakeLock();

    this.clock.pause();
    if (!this.disableAudio) {
      this.audioRenderer.pause();
    }

    // Stop video presentation loop
    if (this.videoRenderer) {
      this.videoRenderer.stopPresentationLoop();
    }

    this.stateManager.setState("paused");
    // No tick will run for a held speed change once paused.
    this.maybeApplyPendingRate();

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.stopBackgroundTimer();

    // Continue buffering ahead while paused (YouTube-like behavior)
    this.startPauseBuffering();

    Logger.info(TAG, "Paused");
  }

  /**
   * Flag to prevent concurrent async WASM operations
   */
  private demuxInFlight = false;
  private demuxInFlightStartTime: number = 0;
  private static readonly DEMUX_TIMEOUT = 35000; // 35 seconds timeout (slightly more than HTTP timeout of 30s)
  // Loop is the element's: handleEnded() fires `ended`, the element replays.
  // The player only keeps the flag and counts the turns (see noteLoopTurn).
  private _loopEnabled = false;
  /** Turns this source has come back round, from 1. Reset when the source is. */
  private _loopCount = 0;

  private eofReached = false;
  // Wall-clock time (performance.now) when eofReached first flipped true.
  // Used as a watchdog: if the normal drained-and-played-out conditions
  // never all line up (e.g. a marginal float mismatch between the audio
  // playout head and the last video frame), force the ended transition
  // rather than freezing one frame short of the end forever.
  private eofSince = 0;
  /** How long the picture-only ending waits for the renderer's queue to run
   *  out once the clock has armed it (upstream f266004). Only ever runs at the
   *  very end of a file. */
  private static readonly EOF_PICTURE_DRAIN_MS = 2000;
  /** How long the decoder must have emitted nothing before an empty renderer
   *  queue is taken to mean the picture is finished rather than between
   *  callbacks. Several frame intervals at any rate we play. */
  private static readonly EOF_PICTURE_SETTLE_MS = 150;
  /**
   * The `eofSince` the one-shot work below was done for. Every place that
   * clears eofReached also zeroes eofSince, so keying on it re-arms the flush
   * and the drain wait for the next end of file without a reset at each site.
   */
  private _eofWorkFor = -1;
  private _eofFlushed = false;
  /** When the picture-only ending was armed (timeDone first true), so the drain
   *  wait is measured from then and not from a much earlier EOF. */
  private _eofPictureDrainSince = 0;

  // ── Where each stream ends ─────────────────────────────────
  // Some files carry sound past the end of their picture (a phone recording
  // whose camera stopped at 80s while the mic ran to 161s) and some the other
  // way round (a 4K MKV whose Opus ends at 193s of a 243s film). Nothing in an
  // empty queue tells that apart from a stream that is merely late, so the
  // stall detector, the resume gate and the ending all waited for packets that
  // do not exist (upstream 27e9dab, 6043339, f0953e8, 775fa9d, b11f19a).
  //
  // Two sources, never a gap between the cursors (we read each stream to its own
  // readahead, so a sparse interleave puts video seconds ahead of audio on any
  // ordinary file): the container's own per-stream duration, known before
  // playback starts; and the end of file, where the read pass has covered
  // everything from where it began and "no audio packet in it" is simply true.
  /** Media time from which the file has audio but no video. */
  private _declaredVideoEnd = Number.POSITIVE_INFINITY;
  /** Media time from which the file has video but no audio. */
  private _declaredAudioEnd = Number.POSITIVE_INFINITY;
  private _learnedVideoEnd = Number.POSITIVE_INFINITY;
  private _learnedAudioEnd = Number.POSITIVE_INFINITY;
  /** Where the current read pass began, and the furthest end (pts + duration)
   *  of each stream's packets it has produced; -1 for none. */
  private _passStart = 0;
  private _passVideoEnd = -1;
  private _passAudioEnd = -1;
  /** A stream must stop at least this long before the file to count as a tail. */
  private static readonly STREAM_END_GAP_S = 1;

  private videoEnd(): number {
    return Math.min(this._declaredVideoEnd, this._learnedVideoEnd);
  }

  private audioEnd(): number {
    return Math.min(this._declaredAudioEnd, this._learnedAudioEnd);
  }

  /** The playhead is past the last picture of a file whose sound runs on. */
  private videoFinished(): boolean {
    return this.clock.getTime() >= this.videoEnd() - 0.05;
  }

  /** The playhead is past the last sound of a file whose picture runs on. */
  private audioFinished(): boolean {
    return this.clock.getTime() >= this.audioEnd() - 0.05;
  }

  /** For the element: past the picture there are no frames to count. */
  isPastVideoEnd(): boolean {
    return this.videoFinished();
  }

  /** A tail needs both streams, a real picture, and a muxed audio track. */
  private tailCapable(): boolean {
    const v = this.trackManager.getActiveVideoTrack();
    return (
      !!v &&
      !v.isAttachedPic &&
      !!this.trackManager.getActiveAudioTrack() &&
      !this.audioDemuxer
    );
  }

  private tailOrNone(end: number): number {
    const fileEnd = this.startTime + (this.mediaInfo?.duration ?? 0);
    return fileEnd - end > MoviPlayer.STREAM_END_GAP_S
      ? end
      : Number.POSITIVE_INFINITY;
  }

  /** Read the per-stream durations the container declared. */
  private declareStreamEnds(): void {
    this._declaredVideoEnd = Number.POSITIVE_INFINITY;
    this._declaredAudioEnd = Number.POSITIVE_INFINITY;
    this._learnedVideoEnd = Number.POSITIVE_INFINITY;
    this._learnedAudioEnd = Number.POSITIVE_INFINITY;
    this._passStart = this.startTime;
    this._passVideoEnd = -1;
    this._passAudioEnd = -1;
    if (!this.tailCapable()) return;
    const vd = this.trackManager.getActiveVideoTrack()?.duration ?? 0;
    const ad = this.trackManager.getActiveAudioTrack()?.duration ?? 0;
    if (vd > 0) this._declaredVideoEnd = this.tailOrNone(this.startTime + vd);
    if (ad > 0) this._declaredAudioEnd = this.tailOrNone(this.startTime + ad);
    if (this._declaredVideoEnd < Number.POSITIVE_INFINITY) {
      Logger.info(
        TAG,
        `Video track ends at ${this._declaredVideoEnd.toFixed(2)}s — the sound plays on past the last frame`,
      );
    }
    if (this._declaredAudioEnd < Number.POSITIVE_INFINITY) {
      Logger.info(
        TAG,
        `Audio track ends at ${this._declaredAudioEnd.toFixed(2)}s — the picture plays on past the last sample`,
      );
    }
  }

  /** A read pass starts here (a seek, a re-read): forget what the last one saw. */
  private beginReadPass(from: number): void {
    this._passStart = from;
    this._passVideoEnd = -1;
    this._passAudioEnd = -1;
  }

  /** Note the extent of each stream's packets as the pass produces them. */
  private notePassPacket(packet: Packet): void {
    const end = packet.timestamp + (packet.duration > 0 ? packet.duration : 0);
    if (!Number.isFinite(end)) return;
    const v = this.trackManager.getActiveVideoTrack();
    if (v && v.id === packet.streamIndex) {
      if (end > this._passVideoEnd) this._passVideoEnd = end;
    } else if (
      this.trackManager.getActiveAudioTrack()?.id === packet.streamIndex
    ) {
      if (end > this._passAudioEnd) this._passAudioEnd = end;
    }
  }

  /**
   * The demuxer ran out: the pass has covered everything from where it began
   * to the end of the file, so a stream with packets in it ended where its last
   * one did, and a stream with none ended before the pass began — which is all
   * that may be claimed, so the tail starts there. A later pass sharpens it: a
   * bound learned from a seek past the sound gives way to the exact end once a
   * pass runs through the sound, and never moves the other way.
   */
  private learnStreamEnds(): void {
    if (!this.tailCapable()) return;
    const learn = (seen: number, prev: number) =>
      seen >= 0 ? seen : Math.min(prev, this._passStart);
    this._learnedVideoEnd = this.tailOrNone(
      learn(this._passVideoEnd, this._learnedVideoEnd),
    );
    this._learnedAudioEnd = this.tailOrNone(
      learn(this._passAudioEnd, this._learnedAudioEnd),
    );
  }

  /** The demuxer reached the end of the file. */
  private markEof(): void {
    if (!this.eofReached) this.eofSince = performance.now();
    this.eofReached = true;
    this.learnStreamEnds();
  }

  /** Back to reading: the end of file no longer holds, and a pass begins. */
  private resetEof(passStart = this.clock.getTime()): void {
    this.eofReached = false;
    this.eofSince = 0;
    this.beginReadPass(passStart);
  }

  /**
   * Keep decoded audio from rewinding the renderer during a seek. FFmpeg seeks
   * to a point before the requested timestamp and decoder flushes may also
   * emit an old in-flight frame. Packet-level filtering cannot catch either
   * case once the packet has entered a decoder, so both output formats are
   * guarded at the final renderer boundary, mirroring the video-frame guard.
   */
  private renderDecodedAudio(data: AudioData): void {
    this.traceDecodedAudio(data.timestamp / 1_000_000);
    if (this.dropsBeforeAudioStart(data.timestamp / 1_000_000)) {
      try {
        data.close();
      } catch {
        // Already closed by a decoder shutdown race.
      }
      return;
    }
    if (
      this.seekTargetTime !== -1 &&
      data.timestamp / 1_000_000 < this.seekTargetTime
    ) {
      try {
        data.close();
      } catch {
        // Already closed by a decoder shutdown race.
      }
      return;
    }
    this.audioRenderer.render(data);
  }

  private renderDecodedPCM(frame: PCMFrame): void {
    this.traceDecodedAudio(frame.timestamp / 1_000_000);
    if (this.dropsBeforeAudioStart(frame.timestamp / 1_000_000)) {
      return;
    }
    if (
      this.seekTargetTime !== -1 &&
      frame.timestamp / 1_000_000 < this.seekTargetTime
    ) {
      return;
    }
    this.audioRenderer.renderPCM(frame);
  }

  /**
   * Audio start alignment (mpv's audio SYNCING, player/audio.c): until the
   * first decoded frame at or after the clock, frames from before it are
   * dropped, and that first frame is the one the renderer anchors on. The
   * refresh seek of an audio track switch starts a second before the playhead
   * (further, back to a sync point), and AudioRenderer.reset() has cleared
   * hasFirstBuffer, so without this the first buffer to arrive — from before
   * the playhead — would establish the anchor, Clock would hard-sync onto it,
   * and the playhead would walk BACKWARD by that distance.
   *
   * Against the clock as it is NOW, not as it was at the switch: the picture
   * keeps playing on the wall clock while the new decoder starts up, so the
   * playhead has moved on by the time its output arrives. Self-clearing: the
   * first frame at or after the clock ends the drop, so a switch near a sparse
   * sync point cannot leave the gate latched. That frame is also the sound
   * being back, which is what ends _audioSwitching.
   */
  private traceDecodedAudio(ptsSeconds: number): void {
    if (!this.switchTraceActive) return;
    const clock = this.clock.getTime();
    this.traceAudioSwitch(
      "first-decoded-audio",
      { pts: ptsSeconds, clock, aligning: this._audioStartAlign },
      true,
    );
    if (this._audioStartAlign && ptsSeconds < clock) {
      this._switchTraceAlignDrops++;
    } else {
      this.traceAudioSwitch(
        "first-rendered-audio",
        { pts: ptsSeconds, clock, aligning: this._audioStartAlign },
        true,
      );
    }
  }

  private dropsBeforeAudioStart(ptsSeconds: number): boolean {
    if (!this._audioStartAlign) return false;
    if (ptsSeconds < this.clock.getTime()) return true;
    this._audioStartAlign = false;
    this._audioSwitching = false;
    return false;
  }

  /**
   * Internal handler for seek completion when first target frame is found.
   * Clears the seek flag, synchronizes clock, and transitions to final state.
   */
  private cancelBlackFrameWatchdog(): void {
    if (this._blackFrameWatchdog !== null) {
      clearTimeout(this._blackFrameWatchdog);
      this._blackFrameWatchdog = null;
    }
  }

  /**
   * After a seek force-completes with no decodable video frame, watch for one to
   * actually land. If none does within a short window — the decoder can't produce
   * a picture at this point (open-GOP / a bad seek target), and the audio-driven
   * resume has flipped to "playing" over a BLACK screen — nudge the playhead onto
   * the next GOP by seeking a little forward. Escalates the jump each attempt and
   * stops after MAX_BLACK_RECOVERY_SEEKS so a genuinely undecodable stream doesn't
   * seek forever. This automates the manual seek users do to unstick a black
   * screen. Superseded silently if a newer seek (incl. the user's own) intervenes.
   */
  private armBlackFrameWatchdog(seekTarget: number): void {
    this.cancelBlackFrameWatchdog();
    const session = this.seekSessionId;
    const baseFrames = this.videoRenderer?.getStats?.().framesPresented ?? 0;
    this._blackFrameWatchdog = setTimeout(() => {
      this._blackFrameWatchdog = null;
      if (this.seekSessionId !== session) return; // a newer seek owns recovery
      // A black screen is a decode failure; a finished video track is not.
      if (this.videoFinished()) return;
      const nowFrames = this.videoRenderer?.getStats?.().framesPresented ?? 0;
      if (nowFrames > baseFrames) {
        this._blackRecoverySeeks = 0; // a frame decoded on its own — recovered
        return;
      }
      const st = this.stateManager.getState();
      // Also act while still "seeking": on open-GOP content the seek can sit
      // there with every keyframe a CRA the decoder rejects, so no frame ever
      // decodes and the seek never completes — the black screen the nudges exist
      // to clear. Only paused/ready/idle/error are left alone. The session check
      // above already prevents fighting a newer seek, and we only nudge when
      // ZERO frames decoded since arming, so a slow-but-working seek is safe.
      if (st !== "playing" && st !== "buffering" && st !== "seeking") return;
      // Starved, not stuck: with no buffered data ahead there is nothing to
      // decode at ANY position, so nudging forward only burns the budget and
      // resets the pipeline. These nudges exist to clear a bad GOP run, not a
      // slow link — re-arm and let it buffer, so the budget is still there if a
      // genuine undecodable run shows up once data flows again.
      const from0 = Math.max(seekTarget, this.clock.getTime());
      if (this.getBufferedTime() - from0 < 0.5) {
        this.armBlackFrameWatchdog(seekTarget);
        return;
      }
      if (this._blackRecoverySeeks >= MoviPlayer.MAX_BLACK_RECOVERY_SEEKS) {
        Logger.warn(
          TAG,
          "Black-frame recovery exhausted — no decodable frame after nudges",
        );
        return;
      }
      this._blackRecoverySeeks++;
      // Escalate the jump so a whole bad GOP run is cleared: 2s → 6s → 10s.
      const jump = 2 + (this._blackRecoverySeeks - 1) * 4;
      const duration = this.getDuration() || 0;
      const from = Math.max(seekTarget, this.clock.getTime());
      let target = from + jump;
      if (duration > 1 && target > duration - 0.5) {
        target = Math.max(0, duration - 1);
      }
      Logger.info(
        TAG,
        `Black-frame recovery #${this._blackRecoverySeeks}: no frame at ${from.toFixed(1)}s — nudging to ${target.toFixed(1)}s`,
      );
      void this.seek(target);
    }, 2500);
  }

  private notifySeekCompletion(time: number, forced: boolean = false): void {
    Logger.debug(
      TAG,
      `notifySeekCompletion called: time=${time.toFixed(3)}s, waitingForVideoSync=${this.waitingForVideoSync}, seekTargetTime=${this.seekTargetTime.toFixed(3)}s, forced=${forced}`,
    );
    if (!this.waitingForVideoSync) {
      Logger.warn(
        TAG,
        "notifySeekCompletion: early return (waitingForVideoSync=false)",
      );
      return;
    }
    // Bail if a newer seek has superseded the one that armed this completion.
    // A stale frame/timeout from a coalesced rapid seek would otherwise run the
    // resume/paused branch and consume wasPlayingBeforeSeek out from under the
    // live seek — intermittently leaving rapid seeks stuck paused.
    if (this.seekArmedSessionId !== this.seekSessionId) {
      Logger.warn(
        TAG,
        `notifySeekCompletion: stale session ${this.seekArmedSessionId} != ${this.seekSessionId} — ignoring`,
      );
      // But the armed seek is DEAD — a later op (a subtitle prefetch, an audio
      // switch, a quality swap) bumped the session to supersede it without
      // clearing the sync flag it left set. If we only ignore, every frame
      // re-enters here and bails forever while `waitingForVideoSync` stays true,
      // so the pipeline sits in a permanent "seeking"/loading state that only a
      // fresh manual seek clears. The superseding op owns its own resume, so we
      // must NOT run the resume/paused branch — just release the dead flag so
      // playback can proceed. (seekTargetTime is left alone: the superseding op
      // may be using it as a pre-target frame filter.)
      if (
        this.seekArmedSessionId < this.seekSessionId &&
        this.waitingForVideoSync
      ) {
        Logger.info(
          TAG,
          "notifySeekCompletion: releasing a superseded seek's stuck video-sync flag",
        );
        this.waitingForVideoSync = false;
        this.seekingToKeyframe = false;
      }
      return;
    }

    // "The seek is done" is a different statement from "playback has resumed",
    // and only the first one is what `seeked` means.
    //
    // This used to be announced at the very end of this function — which the
    // branches below never reach when playback was rolling: a seek made while
    // playing lands in one of the "buffer until the cushion fills" paths and
    // returns from there. So a scrub during playback fired `seeking` and then
    // nothing, and any page waiting for `seeked` waited for good. A media
    // element says seeked as soon as the new position is available and then,
    // if it has to refill, waiting — in that order.
    let seekedAnnounced = false;
    const announceSeeked = () => {
      if (seekedAnnounced) return;
      seekedAnnounced = true;
      // Media time back to UI time.
      const at = Math.max(0, time - this.startTime);
      // The pipeline's own completion, which fires for EVERY seek. `seeked` is
      // the page's event and stays quiet for the ones nobody asked for; the
      // element still has to know when its poster frame has landed, and
      // borrowing the public event for that meant suppressing the event
      // silently broke the poster: the clock was never reset off the poster
      // timestamp, so playback began there and the readout — held at zero for
      // the length of the poster seek — was held there for good.
      this.emit("seekcomplete", at);
      if (this._seekIsInternal) return;
      this.emit("seeked", at);
    };

    // A genuine frame-driven completion (forced=false) means a real picture
    // decoded — cancel any pending black-frame watchdog and refill its budget so
    // a later, unrelated black event gets fresh recovery attempts.
    if (!forced) {
      this.cancelBlackFrameWatchdog();
      this._blackRecoverySeeks = 0;
    } else {
      // …and a forced one means the opposite: this seek is finishing with
      // nothing on the canvas. Note what it still owes so the frames the
      // decoder is about to hand over — the ones this gave up waiting for —
      // are not dropped by the state gate the moment we leave "seeking".
      // Settled by the first frame that reaches the renderer.
      this._pictureOwedFrom = time;
    }

    // Forced completion (safety timeout) with no decoded video frame yet: the
    // seek didn't actually produce a picture — slow network/decode just hasn't
    // delivered one. Going straight to "playing" here advances the clock over a
    // black screen and only recovers on a manual pause→play. Instead, finish
    // the seek bookkeeping but resume into "buffering" with the play intent
    // latched, so the normal buffering→resume path flips to "playing" the
    // moment the first frame is actually decoded — no user interaction needed.
    // Only a source that HAS a picture can be waiting for one — see hasPicture.
    const noVideoFrameYet =
      this.hasPicture && this.videoRenderer!.getQueueSize() === 0;
    // …but NOT while the tab is hidden, where there is no picture to wait for.
    // Video decode is skipped there on purpose, so "resume into buffering until
    // a frame decodes" is a wait that cannot end: the next video after a
    // background auto-advance sat in buffering, silent, until the viewer came
    // back and the decoder started again. Read off a real session's log —
    // "notifySeekCompletion … forced=true", "State: seeking -> buffering", and
    // then nothing at all until "Foreground recovery". Backgrounded, the audio
    // IS the playback, so let it start. PiP is not backgrounded in this sense:
    // the picture is on screen and worth waiting for.
    const pictureIsBeingDecoded = !this.isBackgrounded || this.isPiPActive;
    const forcedWithoutFrame =
      forced &&
      noVideoFrameYet &&
      // Upstream's guard: backgrounded there IS no picture to wait for, so the
      // barrier below would be a wait that cannot end (the next video after a
      // background auto-advance sat silent in buffering until the viewer came
      // back). PiP is not backgrounded in this sense.
      pictureIsBeingDecoded &&
      !!this.trackManager.getActiveVideoTrack() &&
      // Past the last frame of the file nothing is coming to wait for.
      !this.videoFinished();

    // The restart barrier (P3, ours). With a video track present, a seek is not
    // complete until a presentable frame exists — so the forced timeout does NOT
    // complete the seek. We stay sync-armed (seekTargetTime and
    // waitingForVideoSync are cleared below, AFTER this return) and buffer, so
    // the clock cannot advance over a black screen and the first real frame
    // still lands through the normal completion path. Locked by
    // test/core/seek-sync.test.ts.
    //
    // Upstream instead COMPLETED the seek here and entered buffering with the
    // resume intent kept. That branch is unreachable under our barrier — the
    // return below fires first — so it is not carried as a second, contradictory
    // handler for the same condition. What it did that we did not is carried:
    // the self-inflicted buffering flag (this wait is our own doing, so the
    // stall floor must not be served on top of it), the audio cold-prime (heavy
    // software audio is flushed-cold by the seek and would otherwise drain its
    // buffer through a multi-second CRA wait and underrun on resume), and the
    // black-frame watchdog (a decoder that simply cannot produce a frame at this
    // seek point would otherwise hang here forever).
    if (forcedWithoutFrame) {
      Logger.warn(
        TAG,
        "Seek timeout fired before a video frame arrived; staying sync-armed and buffering instead of completing seek",
      );
      this.suppressSeekSpinner = false;
      if (this.wasPlayingBeforeSeek || this.wasPlayingBeforeRebuffer) {
        this.wasPlayingBeforeSeek = false;
        this.wasPlayingBeforeRebuffer = true;
        this._bufferingSelfInflicted = true;
        if (this.activeAudioNeedsColdPrime()) {
          this.beginAudioPrime();
        }
        if (this._playStartTime === 0) {
          this._playStartTime = performance.now();
        }
        this.stateManager.setState("buffering");
        this.armBlackFrameWatchdog(this.seekTargetTime);
      }
      return;
    }

    const seekTarget = this.seekTargetTime;
    this.seekTargetTime = -1;
    this.waitingForVideoSync = false;
    this.seekSyncArmedAt = 0; // disarm read-ahead cap + hard-timeout watchdog
    this.seekDemuxAheadTime = -1;
    this.seekingToKeyframe = false; // Also clear keyframe skip flag
    // First-play/replay seek has produced its first frame — drop spinner
    // suppression so any later genuine rebuffer shows the loading UI.
    //
    // …but not when this same seek is about to buffer for its own cold prime:
    // the state sequence is seeking -> buffering -> paused -> playing, and the
    // buffering in the middle belongs to the seek, not to a later stall. Clearing
    // here drew a loading ring over a picture that was already up (upstream
    // a96c8d3, 8e77c8a). The resume gate clears it instead.
    if (!(
      (this.wasPlayingBeforeSeek || this.wasPlayingBeforeRebuffer) &&
      this.activeAudioNeedsColdPrime()
    )) {
      this.suppressSeekSpinner = false;
    }

    // How far past the requested target did the first frame actually land?
    // Long-GOP .ts files can land seconds late; subtract that in
    // getCurrentTime() so the UI timeline starts where the user clicked.
    if (seekTarget >= 0) {
      this.seekKeyframeOffset = Math.max(0, time - seekTarget);
    }

    Logger.debug(
      TAG,
      `Seek completion at ${time.toFixed(3)}s (target: ${seekTarget.toFixed(3)}s)`,
    );

    // Sync correction: Match clock to actual video/audio start time.
    //
    // When video arrives late (hardware decode lag, or no keyframe at the
    // exact seek target), we have two options:
    //
    //   a) Sync clock to earliest audio packet — audio stays continuous, but
    //      video frame sits queued until clock catches up, so the user hears
    //      audio while the video is frozen/stale for the gap duration.
    //
    //   b) Sync clock to video frame time — drops the stale audio packets
    //      between seek target and video time, but A/V stays coherent.
    //
    // Small gaps (< 200ms) are imperceptible, so (a) wins. Large gaps (from
    // sparse keyframes / slow HEVC+HDR decoders) were causing bad user-facing
    // desync: video and audio visibly drifting for nearly a second. For those
    // we now prefer (b) — a brief audio skip beats sustained A/V mismatch.
    if (time > seekTarget + 0.01) {
      const AUDIO_SYNC_GAP_LIMIT = 0.2;
      let syncTime = time;
      let syncedToAudio = false;

      if (this.audioQueue.length > 0) {
        const earliestAudioTime = this.audioQueue.firstTimestamp;

        if (earliestAudioTime < time) {
          const gap = time - earliestAudioTime;
          if (gap <= AUDIO_SYNC_GAP_LIMIT) {
            syncTime = earliestAudioTime;
            syncedToAudio = true;
            Logger.debug(
              TAG,
              `Video arrived late (${time.toFixed(3)}s), syncing clock to earliest audio (${syncTime.toFixed(3)}s) — gap ${(gap * 1000).toFixed(0)}ms`,
            );
          } else {
            Logger.info(
              TAG,
              `Video-audio gap ${(gap * 1000).toFixed(0)}ms exceeds ${AUDIO_SYNC_GAP_LIMIT * 1000}ms; syncing clock to video (${time.toFixed(3)}s) and dropping stale audio before that`,
            );
          }
        } else {
          Logger.debug(
            TAG,
            `Stream jumped ahead. Syncing clock to video at ${syncTime.toFixed(3)}s.`,
          );
        }
      } else {
        Logger.debug(
          TAG,
          `Stream jumped ahead. Syncing clock to ${syncTime.toFixed(3)}s.`,
        );
      }

      this.clock.seek(syncTime);

      // Filter audio packets:
      //  - synced to audio: keep everything from seek target onward
      //  - synced to video: drop audio before the video frame so AV stays
      //    aligned after the seek
      const cutoff = syncedToAudio ? seekTarget - 0.01 : syncTime - 0.01;
      while (
        this.audioQueue.length > 0 &&
        this.audioQueue.firstTimestamp < cutoff
      ) {
        this.audioQueue.shift();
      }
      // Split (separate-URL) audio never passes through audioQueue —
      // its own loop decodes straight from the audio demuxer — so that filter
      // left it untouched and the two paths disagreed about where playback
      // resumes. The audio demuxer's seek lands on ITS container boundary,
      // which can sit well before the target, and its in-flight guard
      // (seekTargetTime) is released the moment this completion runs. Those
      // early packets were then decoded and scheduled, the clock followed audio
      // backwards, and the picture sat frozen on a full renderer queue until
      // the clock crawled back up to the first video frame.
      //
      // It bites hardest exactly where the video starts LATE: an open-GOP CRA
      // whose keyframe the decoder rejects resumes video a good half second
      // past the target, so the audio-behind gap is at its widest. Measured on
      // a split source: video resumed at 10.552s against a 10.000s target while
      // audio started at 9.47s — 616ms of frozen picture. Hand the same cutoff
      // to the split loop so it drops the stale head too.
      if (this.audioDemuxer) {
        // An exact cutoff: nothing provisional about it.
        this._splitAudioSkipBefore = cutoff;
      }
    }

    // Transition to final state.
    //
    // NOTE: the forced-timeout-without-a-frame case is owned entirely by the
    // `forcedWithoutFrame` early-return near the top of this method — our P3
    // restart barrier, locked by test/core/seek-sync.test.ts. Execution only
    // reaches here once a real video frame has arrived, so `forcedWithoutFrame`
    // is always false at this point. Upstream had an alternate "complete-then-
    // buffer-with-prime" branch here for the same condition; under our barrier
    // it is unreachable, so rather than carry two contradictory handlers its
    // three distinct behaviours (self-inflicted buffering, audio cold-prime,
    // black-frame watchdog) were folded INTO the barrier itself and the branch
    // dropped. Nothing upstream did here is lost; it just happens earlier.
    if (this.wasPlayingBeforeSeek || this.wasPlayingBeforeRebuffer) {
      // Consume the resume intent so it doesn't leak into the next seek. It's
      // never reset elsewhere, so a stale `true` would make a later paused
      // user-seek wrongly auto-resume (and would defeat seek()'s re-derivation
      // guard that now skips re-deriving when this is already true).
      this.wasPlayingBeforeSeek = false;
      this.wasPlayingBeforeRebuffer = false;
      if (this._playStartTime === 0) {
        this._playStartTime = performance.now();
      }

      // Cold-start audio prime for heavy software audio (TrueHD/DTS via WASM),
      // which decodes sub-realtime for ~1-2s while the decode path warms up. If
      // we start now, the fast HW video races ahead while audio underruns —
      // gap-fills ("atak-atak") then a ~2s A/V resync once the buffer empties.
      // Route the resume through the same buffering machinery the stall path
      // uses: hold the AudioContext suspended (isPlaying=true so decoded audio
      // still accumulates), hold the clock and video presentation, and let the
      // buffering→resume gate below start both together once a real audio
      // cushion exists. NOT one-shot — every seek flushes the decoder, so each
      // post-seek resume is a cold start that needs the cushion too, else a
      // mid-playback seek resumes thin and underruns into ~2s of jitter (issue
      // #11, seek case). Hardware audio (AAC) and lightweight software codecs
      // (Opus/FLAC/AC-3/E-AC-3) decode faster than realtime even cold, so
      // activeAudioNeedsColdPrime() gates them out — no needless buffer for them.
      if (this.activeAudioNeedsColdPrime()) {
        this.beginAudioPrime();
        this.wasPlayingBeforeRebuffer = true; // resume intent for buffering→play
        this._bufferingSelfInflicted = false;
        this.stateManager.setState("buffering");
        this.clock.pause();
        if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
        Logger.info(TAG, "Audio cold-prime: buffering until cushion");
        announceSeeked();
        return;
      }

      // The queue depth is the evidence upstream 5a12a30 argues from: a resume
      // on the first frame back starts the clock against a queue of one.
      Logger.info(
        TAG,
        `Resuming playback after seek (renderer queue=${this.videoRenderer?.getQueueSize() ?? 0})`,
      );
      // Playback is starting; if the tab is hidden this is the only thing that
      // will feed the renderer.
      this.ensureBackgroundPump();
      // Stamp it: the decoders were flushed by this seek, so playback is
      // restarting on a thin cushion and an underrun in the next moment is our
      // doing, not a starving link (see SELF_INFLICTED_STALL_WINDOW_MS).
      this._lastSeekResumeAt = performance.now();
      this.stateManager.setState("playing");
      // Mark that playback has actually started. When play() is pressed during
      // the initial poster-seek it early-returns before reaching the body that
      // normally sets _playStartTime, and the seek-completion resume path takes
      // over here instead — so _playStartTime would stay 0 for the whole
      // session. A later mid-playback recovery (decode-error → buffering →
      // this.play()) would then see _playStartTime === 0, mistake itself for
      // the "first play", and seek(0) — yanking a video that's an hour in back
      // to the start. Stamp it here so the first-play branch only ever fires
      // for a genuine first play.
      if (this._playStartTime === 0) {
        this._playStartTime = performance.now();
      }
      this.clock.start();
      // The audio held in audioQueue during the wait is fed by the read loop's
      // next pass, AFTER this play() — AudioRenderer.isPlaying is true by then,
      // so render() accepts the decoded AudioData instead of dropping it.
      if (!this.disableAudio && !this.audioRenderer.isAudioPlaying()) {
        this.audioRenderer.play();
      }
    } else {
      Logger.info(TAG, "Seek completed in paused state");
      this.wasPlayingBeforeSeek = false;
      this.stateManager.setState("paused");

      // Don't decode audio now (AudioRenderer not playing — would drop all
      // data). The held audio stays queued from the target onward, which is
      // exactly where play() resumes; a first play re-seeks to 0 and clears
      // the queues itself.

      // Don't start clock or audio — but continue buffering ahead
      this.startPauseBuffering();
    }

    // Ready — and if a branch above already said so, this is a no-op.
    announceSeeked();
  }

  /**
   * True once a seek has waited past the hard limit for its first video frame.
   * The process loop then force-completes the seek so a frame-starved seek
   * (decode stuck, unseekable stream) can neither hang the player nor keep the
   * demuxer downloading forever. `now` is injected for testability.
   */
  private seekSyncHardTimedOut(now: number): boolean {
    return (
      this.waitingForVideoSync &&
      this.seekSyncArmedAt > 0 &&
      now - this.seekSyncArmedAt > MoviPlayer.SEEK_SYNC_HARD_TIMEOUT_MS
    );
  }

  /**
   * Heavy lossless/complex software audio codecs (TrueHD/MLP, DTS/DCA) decode
   * sub-realtime for ~1-2s from a cold start. Every seek flushes the decoder,
   * so each post-seek resume is a cold start that needs the audio prime cushion
   * — not just the first play/replay. Hardware audio (AAC) and lightweight
   * software codecs (Opus/FLAC/AC-3/E-AC-3) decode faster than realtime even
   * cold and don't need it. Our software path may run the decode off-thread in
   * the worker, but the cushion logic is identical — usesSoftware is true for
   * both. (issue #11)
   */
  private activeAudioNeedsColdPrime(): boolean {
    const codec = (
      this.trackManager.getActiveAudioTrack()?.codec ?? ""
    ).toLowerCase();
    return (
      !this.disableAudio &&
      // Nothing to prime when the audio is being discarded: muted with a
      // context the browser won't start (autoplay blocked). The cushion the
      // prime waits for can never appear, so it would only freeze the picture
      // for the full max-dwell before starting anyway.
      !this.audioRenderer.isDroppingAudio() &&
      this.audioDecoder.usesSoftware &&
      /truehd|mlp|dts|dca/.test(codec)
    );
  }

  /**
   * True while a seek is still waiting for its first frame AND we have already
   * demuxed more than SEEK_MAX_DEMUX_AHEAD_SECONDS past the target. The process
   * loop then stops reading — every packet the first frame needs (keyframe ≤
   * target) is already read, so this only halts a runaway that would otherwise
   * sequentially download the whole file (the infinite-traffic bug).
   */
  private seekReadAheadExceeded(): boolean {
    return (
      this.waitingForVideoSync &&
      this.seekTargetTime !== -1 &&
      this.seekDemuxAheadTime >= 0 &&
      this.seekDemuxAheadTime - this.seekTargetTime >
        MoviPlayer.SEEK_MAX_DEMUX_AHEAD_SECONDS
    );
  }

  /**
   * Tell the demuxer to skip every audio track except the active one. A file
   * with a second, unused audio track (e.g. a dual-TrueHD source with ~933
   * packets/s PER track) otherwise floods the read path with packets the loop
   * immediately throws away — roughly doubling the reads needed per second. On
   * a slower engine (Safari pulls ~half the packets/s of Chromium) that starved
   * the ACTIVE audio below realtime and stalled every few seconds (issue #11).
   * AVDISCARD_ALL makes av_read_frame skip them internally so each read returns
   * a useful packet. Only audio streams are touched — video and subtitles keep
   * their demuxer defaults (subtitles are read on demand). Re-applied on every
   * audio-track switch so the newly-selected track is re-enabled.
   */
  private applyStreamDiscard(): void {
    const bindings = this.demuxer?.getBindings();
    if (!bindings) return;
    const activeAudioId = this.trackManager.getActiveAudioTrack()?.id;
    for (const t of this.trackManager.getTracks()) {
      if (t.type === "audio") {
        bindings.setStreamDiscard(t.id, t.id !== activeAudioId);
      }
    }
  }

  /**
   * The audio device failed or was taken away and the sound is back (see
   * AudioRenderer.setupContextStateMonitoring). The renderer has dropped what
   * the dead context held; the picture carried on against the wall clock, so
   * the sound has to be rebuilt at the playhead. A seek to the playhead is the
   * existing way to do that (it flushes both pipelines and restarts both
   * decoders there, the same thing the desync net below does), and the
   * cooldown it shares keeps that net from firing a second one on top.
   *
   * Only while playing: paused, buffering or seeking already have their own
   * restart at the playhead.
   */
  private onAudioContextRecovered(): void {
    if (this.disableAudio || this.stateManager.getState() !== "playing") return;
    const at = this.clock.getTime();
    Logger.warn(
      TAG,
      `Audio device recovered, restarting sound at ${at.toFixed(2)}s`,
    );
    this._lastDesyncSeekTime = performance.now();
    this.seek(at).catch(() => {});
  }

  /**
   * Start AudioRenderer's timeline over and re-seat the Clock at the CURRENT
   * position across an audio track switch — no position change, just a decoder
   * rebuild.
   *
   * B1 (docs/PLAN_MERGE.MD §4.11): the audioTrackChange handler used to close
   * the old MoviAudioDecoder and construct a new one without touching either
   * object, and what the old track had scheduled went on describing the clock:
   * the gap while the old worker tears down and the new one spins up reads as
   * an ordinary underrun, and the first buffer of the new track (whatever raw
   * PTS it carries, with no check that it continues the old timeline) was
   * stitched onto the old one. The step that made in the media clock was then
   * only ever partly corrected (measured 0.064x-4.13x across samples).
   *
   * Both primitives already exist and are exactly what the seek path uses to
   * rebuild the pipeline at a fixed position (see seek()'s
   * `audioRenderer.reset()` -> `clock.seek(target)` sequence). The demuxer side
   * is refreshDemuxerForAudioSwitch, issued by the audioTrackChange handler
   * after applyStreamDiscard() — it has to happen AFTER the discard flags flip,
   * or the re-enabled track still has no packet at the target.
   *
   *   - `audioRenderer.reset()` stops the old track's already-scheduled Web
   *     Audio nodes and empties the list of scheduled segments, so the old
   *     track's timeline is gone and the new track's first buffer starts a
   *     fresh one.
   *   - `clock.seek(currentTime)` puts the time source's wall clock at the
   *     position we were actually at. With no segments the audio has no answer,
   *     so the picture runs on the wall clock from there until the new sound is
   *     audible — and the time source takes it up the moment it is. Nothing
   *     else (the picture included) has to be told: they all read that one
   *     source.
   *
   * Captured as its own method (not inlined in the handler) so it can be
   * driven directly in a test without wiring a full MoviPlayer instance.
   */
  private realignAudioTimelineForTrackSwitch(): void {
    const currentTime = this.clock.getTime();
    if (this.audioSwitchTraceEnabled) {
      this.beginAudioSwitchTrace();
      const video = this.videoRenderer?.getFrameStats();
      this.traceAudioSwitch("switch", {
        clock: currentTime,
        lastPts: video?.lastPts ?? -1,
        frameQueue: video?.queued ?? -1,
        videoPackets: this.videoQueue.length,
      });
    }
    this.audioRenderer.reset();
    this.clock.seek(currentTime);
  }

  /**
   * The demuxer half of an audio track switch: mpv's refresh seek
   * (demux/demux.c initiate_refresh_seek). Go back a second before the
   * playhead and read the file again from there, so the stream just enabled
   * has packets at the playhead to give; the streams that were already playing
   * drop what they had taken (see enqueuePacket) so they carry on exactly
   * where they left off. Video is not touched at all: its decoder, its queue
   * and the frames in the renderer are not flushed, cleared or re-keyframed,
   * which is the whole point — the old version moved the shared read cursor
   * and then had to rebuild the picture around it.
   *
   * Everything that has to be decided about the old position is decided
   * synchronously, before the seek is awaited: the audio queue is emptied (it
   * held the old track), the epoch is stepped so packets whose read began
   * before this point are recognised as coming from the position being
   * abandoned, and the refresh flags go up. The seek itself is serialized
   * behind any read already in flight by the demuxer's operation chain.
   *
   * Returns once the seek has landed. A failed seek is not worth tearing
   * playback down over: the old behaviour (scan forward) still produces
   * audio, just from the wrong place.
   */
  private refreshDemuxerForAudioSwitch(): Promise<void> {
    const demuxer = this.demuxer;
    if (!demuxer) return Promise.resolve();
    const target = Math.max(
      this.startTime,
      this.clock.getTime() - MoviPlayer.AUDIO_SWITCH_REFRESH_BACK_S,
    );
    this._refreshEpoch++;
    this.audioQueue.clear();
    this._refreshingVideo = Number.isFinite(this.videoQueue.lastDts);
    this._refreshingSubtitle = Number.isFinite(this._lastSubtitleDts);
    const session = this.seekSessionId;
    if (this.switchTraceActive) {
      this.traceAudioSwitch("refresh-seek", {
        target,
        clock: this.clock.getTime(),
      });
    }
    return demuxer.seek(target, 1, this.getSeekStreamIndex()).then(
      () => {
        if (this.switchTraceActive) {
          this.traceAudioSwitch("refresh-landed", {
            clock: this.clock.getTime(),
          });
        }
        // A real seek since then owns the cursor and the EOF flag.
        if (session !== this.seekSessionId) return;
        // The cursor is no longer where the read-ahead found the end of the
        // file, and processLoop reads nothing while eofReached is up. Without
        // this a switch within the last seconds of a file stayed silent.
        this.resetEof();
      },
      (error) => {
        Logger.error(
          TAG,
          "Audio track switch: demuxer refresh seek failed",
          error,
        );
      },
    );
  }

  /**
   * Begin an audio prime: hold the AudioContext suspended (primeForBuffering,
   * which never issues a resume() so it can't drain/race) while the read loop
   * keeps feeding queued audio into the decoder, and flag _primingAudio so the
   * buffering→resume gate waits for a real cushion (2s) rather than the thin
   * 0.1s default before resuming.
   */
  private beginAudioPrime(): void {
    this.holdAudioForBuffering();
    this._primingAudio = true;
  }

  /**
   * The mechanical half of a prime, without the 2s cushion demand: hold the
   * context suspended and hand the stashed post-seek packets to the decoder so
   * the buffer fills against a frozen clock.
   *
   * Any seek-completion branch that holds the picture back has to do this. The
   * packets are stashed precisely BECAUSE the renderer isn't playing yet
   * (render() drops AudioData while isPlaying is false), so a branch that
   * returns without calling this leaves the audio buffer at zero — and the
   * resume gate it just handed control to reads that as "audio not ready" and
   * waits out its escape every single time.
   */
  private holdAudioForBuffering(): void {
    this.audioRenderer.primeForBuffering();
    this._primingAudio = true;
  }

  /**
   * Hand a run of audio packets to the decoder in as few WASM round-trips as
   * possible.
   *
   * Only the legacy main-thread software path batches — and that's where it
   * matters: TrueHD/MLP emits a 40-sample access unit (~0.8 ms), so priming a
   * 2s cushion after a seek means ~2400 packets, each otherwise costing its own
   * send/receive/getter round-trips and per-channel copies. Batched, the whole
   * run crosses once. WebCodecs codecs — and the worker software decoder, whose
   * transport already keeps the per-packet cost off the main thread — have no
   * such cost and just replay one by one (see AudioDecoder.canBatch).
   *
   * A short `consumed` means the block ended at a format change or pts
   * discontinuity, so the remainder goes as a fresh batch — never flattened.
   */
  private submitAudioPackets(
    packets: { data: Uint8Array; timestamp: number; keyframe: boolean }[],
  ): void {
    if (packets.length === 0) return;
    if (!this.audioDecoder.canBatch()) {
      for (const pkt of packets) {
        this.audioDecoder.decode(pkt.data, pkt.timestamp, pkt.keyframe);
      }
      return;
    }

    let batch = packets.map((p) => ({ data: p.data, pts: p.timestamp }));
    while (batch.length > 0) {
      const consumed = this.audioDecoder.decodeBatch(batch);
      if (consumed <= 0) break; // decoder errored/broke — drop the rest
      if (consumed >= batch.length) break;
      batch = batch.slice(consumed);
    }
  }

  /**
   * The picture is behind a clock that is about to be held, and has to reach it.
   *
   * Every frame the decoder delivers until it does is late and will be dropped,
   * so the only thing that matters is how fast it gets there — and the frames
   * nothing references (H.264 nal_ref_idc == 0, HEVC TRAIL_N/RASL_N/RADL_N and
   * the like, flagged `disposable` by the demuxer) are exactly the ones that can
   * be skipped without breaking the stream: mpv's --framedrop=decoder. The
   * decoder already has that switch for adaptive load shedding; it is thrown
   * for the length of the catch-up and put back after, unless the performance
   * detector has thrown it for good.
   */
  private beginVideoCatchUp(): void {
    this._catchingUpVideo = true;
    if (
      this.videoDecoder &&
      !this._perfSkipLatched &&
      !this._catchUpSkipEngaged
    ) {
      this.videoDecoder.setPerformanceSkip(true);
      this._catchUpSkipEngaged = true;
    }
  }

  private endVideoCatchUp(): void {
    this._catchingUpVideo = false;
    if (this._catchUpSkipEngaged) {
      this._catchUpSkipEngaged = false;
      if (!this._perfSkipLatched) this.videoDecoder?.setPerformanceSkip(false);
    }
  }

  /**
   * Hold playback while a stream refills: the one way into "buffering" from
   * playing, shared by every kind of stall (audio running dry, the picture
   * running dry, the picture falling too far behind).
   */
  private enterStallBuffering(reason: string): void {
    Logger.warn(TAG, reason);
    this.wasPlayingBeforeRebuffer = true;
    // A stall landing right after a rate change is one WE caused:
    // AudioRenderer's re-anchor drops the scheduled old-rate audio, so
    // the buffer reads empty for exactly as long as the decoder needs to
    // refill. Nothing is actually starving — the decoder is idle and the
    // video queue is full — so this must not serve the underrun recovery
    // (1.5s dwell + a 2s cushion for software audio). Without this every
    // speed change froze the picture for ~1.5-2s.
    //
    // A stall just after a SEEK resumed is the same story: the seek
    // flushed both decoders, so playback restarts on whatever thin
    // cushion the first packets provide and the underrun detector fires
    // a few hundred ms later. Captured on a streaming 4K AV1 source —
    // seek lands at 2.05s, audio ducks at 2.29s, stall at 2.50s, then
    // the picture sat frozen for a further 1516ms serving the floor
    // alone. The resume gate in processLoop is the right gate for both.
    const now = performance.now();
    this._bufferingSelfInflicted =
      now - this._lastRateChangeAt <
        MoviPlayer.SELF_INFLICTED_STALL_WINDOW_MS ||
      now - this._lastSeekResumeAt < MoviPlayer.SELF_INFLICTED_STALL_WINDOW_MS;
    this.stateManager.setState("buffering");
    this.clock.pause();
    // Suspend AudioContext so already-scheduled audio doesn't play ahead of video.
    // Keep isPlaying=true so render() still accepts AudioData and buffers fill up.
    if (this.audioRenderer) {
      this.audioRenderer.suspendForBuffering();
    }
    // Stop presentation loop so decoded frames accumulate in queue
    // (otherwise it keeps consuming them and videoReady never becomes true)
    if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
    this._stallStartTime = 0;
  }

  /**
   * Main Playback Loop
   */
  private processLoop = async () => {
    const currentState = this.stateManager.getState();
    // Run if playing OR buffering (for rebuffering) OR if we are resolving a seek (fetching target frame)
    if (
      currentState !== "playing" &&
      currentState !== "buffering" &&
      !this.waitingForVideoSync
    )
      return;

    // Capture session ID at start of loop - if a new seek starts, this loop should abort
    const currentSessionId = this.seekSessionId;
    // …and which video pipeline this pass belongs to. An in-place rendition
    // swap replaces the demuxer and closes the old one while a readPacket()
    // from this pass may still be suspended inside it; that read then fails
    // BECAUSE we tore its source down, and the catch below has no way to tell
    // that from a real failure. It was classifying the teardown as a fatal
    // WASM abort and rebuilding the whole player — twice in a two-minute
    // session, each time interrupting playback that was otherwise fine.
    const pipelineGeneration = this._demuxerGeneration;

    // ONE chain, always. This loop is entered from several places — the frame
    // it schedules here, the background timer's tick, play(), a rendition swap,
    // a video-only resync — and each entry used to schedule another frame
    // without retiring the one already pending. While the tab is hidden that
    // compounds: rAF callbacks do not run, so every background tick leaves one
    // more queued, and on return they all fire in the same frame and each
    // spawns a self-sustaining chain of its own. Measured on a 12-second
    // background stint: 359,761 loop entries in the first second, the thread
    // saturated, and the first packet not read until a second after the tab
    // came back — which is the "sometimes the picture takes forever" this was
    // chased for. Retiring the pending frame first keeps exactly one chain
    // whatever calls in.
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.animationFrameId = requestAnimationFrame(this.processLoop);

    if (!this.demuxer) return;

    // Check if a new seek has started - if so, abort this loop iteration
    if (this.seekSessionId !== currentSessionId) {
      Logger.debug(TAG, "ProcessLoop aborted: new seek started");
      return;
    }

    // Hard watchdog: a seek whose first video frame never arrives must not hang
    // the player or let the demuxer download forever. Past the hard limit,
    // force-complete the seek (hold/resume whatever we have) instead of staying
    // sync-armed and reading packets indefinitely. The one-shot seek timeout
    // can leave us buffering with waitingForVideoSync latched; this is the
    // terminal backstop. Never fires on a healthy seek (first frame arrives in
    // ~1 GOP, well under the limit).
    if (this.seekSyncHardTimedOut(performance.now())) {
      Logger.warn(
        TAG,
        `Seek sync hard-timeout (${MoviPlayer.SEEK_SYNC_HARD_TIMEOUT_MS}ms) with no video frame — force-completing seek to stop runaway demux`,
      );
      this.seekSyncArmedAt = 0;
      this.notifySeekCompletion(this.seekTargetTime);
      return;
    }

    // Check if audio is rebuffering due to playback rate change
    if (!this.disableAudio && this.audioRenderer.isRebuffering()) {
      // Enter buffering state and pause clock until rebuffering completes
      const currentState = this.stateManager.getState();
      if (currentState === "playing") {
        this.wasPlayingBeforeRebuffer = true;
        this.stateManager.setState("buffering");
        this.clock.pause();
        if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
        this._bufferingSelfInflicted = true;
        Logger.debug(TAG, "Entered buffering state for playback rate change");
      }
      // Continue processing to allow new audio to be decoded and scheduled
    } else if (
      this.stateManager.getState() === "buffering" &&
      this.wasPlayingBeforeRebuffer
    ) {
      // Out of a stall when every stream the player is consuming holds
      // RESUME_SECS ahead, or the file has ended — mpv's `cache_pause_wait`.
      // Waiting by the clock instead (a 1.5s floor, a 3s fallback, a 15s
      // escape when the picture was bound to the sound) was a guess at how
      // long a refill takes; the queues say how much is there, and the reads
      // are no longer blocked by anything a full decoder does, so a second
      // is always reachable unless the source has nothing left to give.
      //
      // Decoded media counts toward it. The presentation loop is stopped for
      // the whole stall, so frames and audio the decoders already produced sit
      // waiting to be played: leaving them out would make the player wait for
      // a second MORE than it holds, by however deep the renderer's queue is.
      //
      // The first-play cold prime still needs a REAL decoded audio cushion on
      // top: the software decode is sub-realtime to begin with (and slower once
      // video competes for CPU), so starting on a thin buffer underruns again
      // → a second stall + a ~2s A/V resync. The wait for it is bounded by the
      // reads, which nothing blocks any more, so it needs no dwell cap. A rate
      // change is not that case — we discarded the scheduled audio ourselves in
      // the re-anchor and the decoder is idle and refilling at full speed — so
      // it takes the light threshold (_bufferingSelfInflicted).
      // Catching the picture up to a clock that stopped: whatever the decoder
      // delivers is behind that clock until it has caught up, and is dropped as it
      // arrives, so "a frame is queued" below means one that can be shown ON TIME.
      // The clock is held, so this converges: the decoder only has to reach it.
      if (this._catchingUpVideo && this.videoRenderer) {
        this.videoRenderer.discardLateFrames(this.clock.getTime());
      }
      const audioTargetS =
        this._primingAudio && !this._bufferingSelfInflicted ? 2.0 : 0.1;
      const audioReady =
        !this.audioIsPlayable() ||
        this.audioRenderer.getBufferedDuration() > audioTargetS;
      // At least one frame to show: resuming the clock over a black picture
      // is the one thing no amount of queued packets excuses.
      const videoReady =
        !this.videoRenderer ||
        this.videoFinished() ||
        this.videoRenderer.getQueueSize() >= 1;
      const aheadReady =
        this.eofReached ||
        this.bufferedAheadSeconds() >= MoviPlayer.RESUME_SECS ||
        // The queues stop growing at the byte ceiling, so seconds they can
        // never hold are not worth waiting for (8K AV1 reaches it first).
        this.videoQueue.bytes + this.audioQueue.bytes >=
          MoviPlayer.MAX_QUEUE_BYTES;
      // The `!waitingForVideoSync` guard is OURS and is load-bearing under the
      // P3 restart barrier: notifySeekCompletion's forcedWithoutFrame branch
      // deliberately stays sync-armed and buffers until a real frame lands or
      // the hard-timeout backstop fires. Upstream can drop it because upstream
      // COMPLETES the seek before buffering; we do not. Without it, the gate
      // resumes over a black screen mid-seek and then snaps back when the frame
      // finally decodes.
      const canResume =
        !this.waitingForVideoSync && aheadReady && audioReady && videoReady;
      if (canResume) {
        this._primingAudio = false;
        this.endVideoCatchUp();
        this._bufferingSelfInflicted = false;
        // Stamp the resume so the stall detector can tell this — a warm
        // pipeline picking back up — from a cold first play, and not hand it
        // the full three-second grace (see playGraceMs).
        this._stallResumeAt = performance.now();
        // Before the state moves, not after: the decoder can hand over a frame
        // between these two lines. See _resumeToPlayPending.
        this._resumeToPlayPending = true;
        this.stateManager.setState("paused");
        this.wasPlayingBeforeRebuffer = false;
        // Resume AudioContext before play() so audio picks up from where it was
        if (this.audioRenderer) {
          this.audioRenderer.resumeFromBuffering();
        }
        Logger.info(TAG, "Buffers refilled, resuming playback");
        // The seek that armed this buffering is finally done — see the note in
        // notifySeekCompletion. Anything that stalls from here is genuinely new
        // and deserves its spinner.
        this.suppressSeekSpinner = false;
        this.play().catch((err) => {
          this._resumeToPlayPending = false;
          Logger.error(
            TAG,
            "Failed to resume playback after rebuffering:",
            err,
          );
        });
      }
    }

    // Update FileSource preload position based on current time
    if (this.source instanceof FileSource && this.mediaInfo) {
      const currentTime = this.clock.getTime();
      const duration = this.mediaInfo.duration + this.startTime;
      if (duration > 0) {
        this.source.updatePreloadPosition(currentTime, duration);
      }
    }

    // Emit periodic time update for UI
    this.emit("timeUpdate", this.getCurrentTime());

    // A speed change waiting for the audio to be able to carry it.
    this.maybeApplyPendingRate();

    // The sound has played out for good: let go of the audio clock, which would
    // otherwise stay clamped to the last sample and hold the picture with it.
    if (this.audioFinished() && !this.audioRenderer.isStreamEnded()) {
      Logger.info(
        TAG,
        `Sound ends at ${this.audioEnd().toFixed(2)}s — the picture plays the rest out without it`,
      );
      this.audioRenderer.endOfStream();
    }

    // Stall detection: if playing but both video and audio buffers are critically low
    // Skip near end of video to avoid false stall at EOF
    const nearEnd =
      this.mediaInfo &&
      this.clock.getTime() >= this.mediaInfo.duration + this.startTime - 3;
    // Longer stall timeout for slow + high-FPS: stretcher / hardware rate fallback
    // causes brief audio gaps that aren't true stalls. 2s vs 500ms default.
    const currentRate = this.clock.getPlaybackRate();
    const currentFps = (this.mediaInfo as any)?.videoFrameRate ?? 30;
    const isSlowHighFps = currentRate < 0.99 && currentFps >= 50;
    const stallTimeout = isSlowHighFps ? 2000 : 500;
    // Is there sound that can walk away from a frozen picture? (Split audio
    // lives in its own demuxer, outside the track manager — see the resume
    // gate.) Only then does a binding have anything to hold together.
    const boundToAudio =
      this._bindAV &&
      !this.disableAudio &&
      !this._audioOnly &&
      // Sound the browser refuses to start cannot walk away from anything.
      !this.audioRenderer.isDroppingAudio() &&
      (!!this.trackManager.getActiveAudioTrack() || !!this.audioDemuxer) &&
      !this.audioFinished();
    // Grace period after play() starts: allow decode pipeline to fill before stall detection.
    // Without this, clicking play on a poster triggers a false stall → buffering → loading spinner.
    //
    // That is a COLD start — play() on a poster, nothing decoded yet. A resume
    // out of a stall is not: the pipeline was already running and the gate only
    // let go because frames were there. Handing it the full three seconds is
    // how a bound stream drifts anyway — the queue runs dry again immediately
    // and the sound has three clear seconds before the detector may even look,
    // once per stall. Five of those in a row is where the audio in the reported
    // session got 17 seconds ahead of a picture that never moved. Bound, a
    // resume off the stall path gets a short grace instead.
    const sinceStallResume = performance.now() - this._stallResumeAt;
    const playGraceMs =
      boundToAudio && this._stallResumeAt > 0 && sinceStallResume < 3000
        ? MoviPlayer.BOUND_RESUME_GRACE_MS
        : 3000;
    const inPlayGrace =
      this._playStartTime > 0 &&
      performance.now() - this._playStartTime < playGraceMs;
    // Grace while the video decoder is recovering from a transient decode
    // error (recreate + wait-for-keyframe). The video queue is legitimately
    // empty for ~1 GOP there — counting it as a stall sends the player into a
    // buffering→resume loop (seen on high-bitrate 1080p H.264 whose HW decoder
    // throws an EncodingError on every IDR). The keyframe-wait handler already
    // shows buffering during the actual recovery; this just stops the stall
    // detector from piling on right after.
    // NOTE: this grace is applied to the VIDEO-empty branch only, not to the
    // whole detector. Gating everything on it meant that on a source whose
    // decoder recreates after every seek (open-GOP HEVC), the audio-underrun
    // branch below could never fire — precisely when the user is hearing the
    // glitches and needs the spinner. The two are independent: the video
    // decoder rebuilding says nothing about whether audio is keeping up.
    //
    // …and that suppression has to END. isRecentlyRecovering() is true for the
    // whole keyframe wait, and a keyframe only arrives if packets do: when the
    // link dies mid-recovery the wait never ends and the detector is switched
    // off for good. Read off the reported session — the decoder recreated at
    // 2607s, the network went offline in the same breath, and the sound (a
    // separate source with its bytes already in hand) played on for 57 seconds
    // over a picture frozen on one frame, timeline running the whole way, no
    // spinner at any point. Bound, that is exactly what must not happen, so cap
    // the hold: past the cap an empty video queue is a stall like any other.
    // Unbound the documented behaviour is untouched — clock and audio carry on
    // and the picture catches up at the next keyframe.
    const keyframeHoldTooLong =
      boundToAudio &&
      (this.videoDecoder?.keyframeWaitMs() ?? 0) >
        MoviPlayer.BOUND_KEYFRAME_HOLD_MS;
    const decoderRecovering =
      !!this.videoDecoder &&
      this.videoDecoder.isRecentlyRecovering() &&
      !keyframeHoldTooLong;
    // EOF normally means the picture is finished rather than stalled: the queue
    // drains, playback ends, and a spinner over that would be wrong. But the
    // demuxer's read cursor runs well ahead of the decode, so "no more packets"
    // can arrive with most of the video still unshown — in one session the
    // video demuxer read out to the end of the file while the playhead sat at
    // 97s of 142s, and the flag silenced the detector for the rest of the
    // session: the sound ran on alone for twenty-one seconds and only a manual
    // seek brought the picture back. Bound, EOF stops speaking for the picture;
    // the genuine end of playback is already covered by `nearEnd` below.
    const eofSilencesStall = this.eofReached && !boundToAudio;
    if (
      this.stateManager.getState() === "playing" &&
      !eofSilencesStall &&
      !this.waitingForVideoSync &&
      !nearEnd &&
      !this.isBackgrounded &&
      !inPlayGrace
    ) {
      const videoEmpty = this.videoRenderer
        ? this.videoRenderer.getQueueSize() === 0
        : false;
      // Split (separate-URL) audio has no track in the MAIN demuxer's
      // trackManager — it's decoded from its own demuxer into audioRenderer. So
      // count audioDemuxer too, else hasAudio is false, audioLow is always true,
      // and the detector false-stalls on any momentary video-queue blip while the
      // (independent) audio buffer is perfectly healthy.
      //
      // …and audio the browser will not let us start is not audio at all here.
      // Blocked by autoplay policy the context stays suspended, so its clock
      // never advances and nothing scheduled against it is ever consumed: the
      // buffer reads empty on every pass, forever. Counting that as a track made
      // `audioStarved` permanently true, and under a binding the picture waited
      // on sound that could never arrive — stall, spinner, resume, stall, for as
      // long as the viewer left it muted. isDroppingAudio() is false for our OWN
      // suspends (a prime, a buffering hold), which are exactly the ones the
      // picture SHOULD wait through.
      const hasAudio =
        (!!this.trackManager.getActiveAudioTrack() || !!this.audioDemuxer) &&
        !this.disableAudio &&
        // Sound being rebuilt for a track switch is not sound that ran out —
        // the picture plays on over it (see _audioSwitching).
        !this._audioSwitching &&
        !this.audioFinished() &&
        !this.audioRenderer.isDroppingAudio();
      const audioLow =
        !hasAudio || this.audioRenderer.getBufferedDuration() < 0.05;
      // Suppress the underrun→buffering path briefly after returning from
      // background: the throttled-decode underrun that lands on recovery is
      // transient and refills on its own. Suspending audio for it would stop
      // playback (e.g. background music) the instant the user comes back.
      const inForegroundGrace =
        this._foregroundRecoveryAt > 0 &&
        performance.now() - this._foregroundRecoveryAt < 3000;
      const audioUnderrunning =
        hasAudio && !inForegroundGrace && this.audioRenderer.isUnderrunning();
      // Whichever side runs out, when the two are bound (see _bindAV).
      //
      // Unbound, a side running dry only counts if the OTHER one did too: a
      // frozen picture over continuous sound, or continuous picture over
      // patched-up sound, is taken as the lesser evil. Bound, either is enough
      // on its own — which is the point, since it is precisely the healthy side
      // carrying on that lets the two drift apart.
      //
      // `audioLow` is not the audio side of that test: with no audio track at
      // all it is permanently true, so a silent video would read as starved in
      // every frame. It has to be audio that EXISTS and has run out.
      const audioStarved =
        hasAudio && this.audioRenderer.getBufferedDuration() < 0.05;
      // An output running dry is only a stall when its packet queue has
      // nothing left to feed it. Otherwise the decoder is behind, and
      // freezing the picture to wait for data that is already here would only
      // make it later.
      const videoStalled =
        videoEmpty &&
        !this.videoFinished() &&
        (audioLow || this._bindAV) &&
        !decoderRecovering &&
        this.videoSourceStarved();
      // The audio side of the stall, whether it arrived as a real underrun
      // (holes already heard) or as an empty buffer under a binding.
      const audioBlocking =
        (audioUnderrunning || (this._bindAV && audioStarved)) &&
        this.audioSourceStarved();
      // The picture is not keeping up although neither side has run dry: the
      // decoder is slower than the clock, so every frame it delivers is already
      // late and is dropped (see CanvasRenderer.isLate), and the picture sits on
      // what it has while the sound plays on. Chromium waits out exactly this for
      // a while before calling it an underflow — with the audio still full, a
      // video underflow is deferred by video_underflow_threshold_ (3s) so that a
      // hitch in the picture does not cost a glitch in the sound
      // (renderer_impl.cc OnBufferingStateChange; renderer_impl.h) — and then
      // pauses the audio and the clock TOGETHER so the decoder can catch up to
      // where the clock stopped. The same here: this is a stall like the others,
      // and goes through the same buffering state and the same resume gate.
      const pictureUnderflow =
        this.videoIsConsumed() &&
        !this.trackManager.getActiveVideoTrack()?.isAttachedPic &&
        // A picture that has nothing left to show is finished, not behind.
        !(this.eofReached && this.videoSourceStarved()) &&
        (this.videoRenderer?.getVideoUnderflowMs() ?? 0) >=
          VIDEO_UNDERFLOW_THRESHOLD_MS;
      if (pictureUnderflow) {
        this.beginVideoCatchUp();
        this.enterStallBuffering(
          `Video underflow: no on-time frame for ${Math.round(this.videoRenderer?.getVideoUnderflowMs() ?? 0)}ms ` +
            `(sound buffered ${this.audioRenderer.getBufferedDuration().toFixed(2)}s), ` +
            "holding audio and clock until the picture catches up",
        );
      } else if (videoStalled || audioBlocking) {
        // An underrun isn't a silent buffer dipping low — it's a hole the user
        // ALREADY heard as a click. Waiting the full stall window means five or
        // six audible glitches before the spinner appears, which is the whole
        // complaint. Two gaps is enough evidence the decoder is behind.
        // Left at the standard window under a binding too. Shortening it to
        // 250ms was tried and measured: 2.91s of drift against 3.05s, which is
        // noise. The residual is not the detection window — it is the second or
        // so of playback between resuming and running dry again — so a shorter
        // window buys nothing and only makes the spinner flicker more.
        const effectiveStallTimeout =
          audioBlocking && !videoEmpty ? 200 : stallTimeout;
        const framesNow = this.videoRenderer
          ? this.videoRenderer.getStats().framesPresented
          : 0;
        // A 60fps source a machine can only decode at ~30 keeps the queue at or
        // near zero the whole time — the presentation loop takes each frame the
        // instant it lands — so `videoEmpty` reads true forever and this
        // detector called it a stall. The picture was never stopped; it was
        // HALF RATE, and a spinner over moving video is worse than the stutter
        // it complains about. So ask what actually reached the screen across
        // the stall window: frames still arriving at a watchable rate means
        // slow decode, not an empty pipe, and the window simply restarts.
        //
        // Never applied when it is the AUDIO that is short — those gaps are
        // already audible (or, under a binding, about to be), and rebuilding
        // the cushion is the right answer however healthy the picture looks.
        const stallElapsed = this._stallStartTime
          ? performance.now() - this._stallStartTime
          : 0;
        const pictureMoving =
          !audioBlocking &&
          stallElapsed > 0 &&
          ((framesNow - this._stallStartFrames) * 1000) / stallElapsed >=
            MoviPlayer.STALL_MOVING_FPS;
        if (!this._stallStartTime || pictureMoving) {
          this._stallStartTime = performance.now();
          this._stallStartFrames = framesNow;
        } else if (stallElapsed > effectiveStallTimeout) {
          // Only enter buffering after 500ms of continuous stall
          this.enterStallBuffering(
            audioUnderrunning
              ? "Stall detected: audio underrunning for 500ms (decode behind realtime), entering buffering state"
              : audioBlocking
                ? "Stall detected: audio buffer empty and bound to video, entering buffering state"
                : "Stall detected: buffers empty for 500ms, entering buffering state",
          );
        }
      } else {
        this._stallStartTime = 0;
        this._stallStartFrames = 0;
      }
    } else {
      this._stallStartTime = 0;
      this._stallStartFrames = 0;
    }

    // Audio desync detection: if audio falls significantly behind video at 1x.
    // Clock syncs to audio so clock vs audio is always ~0. Compare audio against
    // maxScheduledMediaTime vs actual playback position to detect real desync.
    // Skip only when audio is genuinely out of the pipeline (muted AND a
    // suspended context — autoplay blocked): there the demux loop drops audio
    // frames, so getAudioClock() stays clamped and this would falsely trip. A
    // muted-but-running context schedules audio normally and can desync just
    // like an audible one.
    if (
      this.stateManager.getState() === "playing" &&
      !this.disableAudio &&
      !this.audioRenderer.isDroppingAudio() &&
      !inPlayGrace &&
      Math.abs(this.clock.getPlaybackRate() - 1.0) < 0.01
    ) {
      const audioTime = this.audioRenderer.getAudioClock();
      const videoTime = this.videoRenderer
        ? ((this.videoRenderer as any).currentTime ?? -1)
        : -1;
      if (audioTime >= 0 && videoTime > 0) {
        const audioBehind = videoTime - audioTime;
        // Cooldown: a resync seek itself takes ~1–2s, so back-to-back desync
        // detections trigger a stutter loop where almost no playback happens
        // between seeks (especially with slow software audio decoders). Wait
        // at least 5s between desync-driven seeks — better to tolerate a
        // sustained ~500ms offset than to pause every second.
        const sinceLastResync = performance.now() - this._lastDesyncSeekTime;
        if (audioBehind > 0.5 && sinceLastResync > 5000) {
          // Suppress the seek when the audio renderer already has samples
          // scheduled past the presented video frame. The gap is just the
          // buffer runway — audio playback will catch up on its own. Forcing
          // a seek here would flush already-decoded audio and cause an
          // audible trip. Most visible after foreground recovery: while
          // backgrounded the audio worker keeps scheduling buffers (out to
          // ~maxScheduledMediaTime), the demuxer-seek brings video forward
          // to that same point, and the playback head is still chewing
          // through the runway — looks like 1s of "desync" but isn't.
          const audioBufferEnd = this.audioRenderer.getMaxScheduledMediaTime();
          if (audioBufferEnd < videoTime - 0.1) {
            // Resync FORWARD, to where the video (what the viewer is actually
            // watching) already is — never to getCurrentTime(), which the audio
            // drives: with the audio 100s behind that would rewind the whole
            // playback 100s, throwing away progress the viewer already saw.
            // Pull the audio up to the video instead. If that position isn't
            // buffered yet the seek simply waits (loading) — acceptable — but
            // the position must not go backwards.
            const resyncTo = Math.max(videoTime, this.getCurrentTime());
            Logger.warn(
              TAG,
              `Audio desync detected: video=${videoTime.toFixed(2)}s, audio=${audioTime.toFixed(2)}s, behind=${(audioBehind * 1000).toFixed(0)}ms — pulling audio forward to ${resyncTo.toFixed(2)}s`,
            );
            this._lastDesyncSeekTime = performance.now();
            this.seek(resyncTo).catch(() => {});
          }
        }
      }
    }

    const limits = this.pipelineLimits();

    const videoBuffered = this.videoRenderer?.getQueueSize() ?? 0;
    // Stuck decoder detection: if video decoder queue is full but renderer queue
    // stays empty for too long, the decoder is hung (e.g. 8K content too heavy).
    // Flush it to unstick — some frames may be lost but playback continues.
    if (
      this.videoDecoder.queueSize > limits.maxVideoQueue &&
      videoBuffered === 0
    ) {
      if (!this._decoderStuckSince) {
        this._decoderStuckSince = performance.now();
      } else if (performance.now() - this._decoderStuckSince > 5000) {
        Logger.warn(
          TAG,
          `Video decoder stuck for 5s (queue=${this.videoDecoder.queueSize}, output=0), flushing`,
        );
        this.videoDecoder.flush().catch(() => {});
        this._decoderStuckSince = 0;
      }
    } else {
      this._decoderStuckSince = 0;
    }

    // Feed before anything that can return early. A read can sit in flight for
    // a long time on a slow link (the check below returns while it does), and
    // the decoders must not wait on it when their packets are already queued.
    this.feedDecoders(limits);

    // Prevent concurrent async WASM operations (Asyncify limitation)
    // Add timeout safeguard - if demux has been in flight too long, reset it
    if (this.demuxInFlight) {
      const elapsed = performance.now() - this.demuxInFlightStartTime;
      if (elapsed > MoviPlayer.DEMUX_TIMEOUT) {
        Logger.warn(
          TAG,
          `Demux operation timeout after ${elapsed}ms, resetting flag`,
        );
        this.demuxInFlight = false;
      } else {
        return;
      }
    }

    // Check if we've reached EOF and decoders are empty - transition to ended
    if (this.eofReached) {
      if (this._eofWorkFor !== this.eofSince) {
        this._eofWorkFor = this.eofSince;
        this._eofPictureDrainSince = 0;
        this._eofFlushed = false;
      }
      // Ask the decoder for its tail, once. WebCodecs holds reordered frames in
      // its DPB until a flush — on H.264 with B-frames, the last few pictures
      // of the file — and no more packets are coming to push them out. Only
      // once everything queued has been handed over (upstream 1147919: a flush
      // with packets still queued makes the decoder wait for a keyframe that
      // never comes).
      if (
        !this._eofFlushed &&
        this.videoQueue.length === 0 &&
        !this.videoDecoder.isWaitingForKeyframe
      ) {
        this._eofFlushed = true;
        this.videoDecoder.flush().catch(() => {
          /* a decoder that cannot flush has nothing left to give */
        });
      }
      const currentTime = this.clock.getTime();
      const duration = this.mediaInfo?.duration ?? 0;
      const timeDone =
        currentTime >= duration + this.startTime - 0.5 || duration === 0;

      const hasAudioTrack =
        !!this.trackManager?.getActiveAudioTrack() &&
        !this.disableAudio &&
        // Sound that ended before the file did is not one to wait to play out.
        !this.audioFinished();

      if (hasAudioTrack) {
        const decodersDone =
          this.videoQueue.length === 0 &&
          this.audioQueue.length === 0 &&
          this.videoDecoder.queueSize === 0 &&
          this.audioDecoder.queueSize === 0;
        // The audio renderer keeps playing buffers it already scheduled for
        // seconds after the decoder queue drains. The clock is synced to that
        // playout head, so it only reaches maxScheduledMediaTime once the final
        // samples are actually heard. End when the playout head has caught up to
        // the furthest scheduled audio — not when the decoder empties — or the
        // last few seconds get clipped (audible on near-end seeks of audio-only
        // files). duration===0 keeps the unknown-length fallback.
        // maxScheduled is already absolute media time (the scheduler stores
        // raw packet timestamps), same basis as clock.getTime(). Don't add
        // startTime again — on sources with a non-zero start (e.g. a .ts
        // beginning at 4200s) the double-add pushes the threshold out of
        // reach, audioPlayedOut never trips, and EOF never transitions to
        // ended (timer freezes short of duration).
        const maxScheduled = this.audioRenderer.getMaxScheduledMediaTime();
        // Normally audio is "played out" once the clock catches the furthest
        // scheduled buffer. But maxScheduled can be stale/runaway — e.g. when
        // a prior decoder instance scheduled audio out to a wrong (longer)
        // duration and the AudioRenderer carried that value into the new
        // player (HW→software fallback on the same element). The clock is also
        // clamped to the true container duration in getTime(), so it plateaus
        // at `duration` and can never reach an inflated maxScheduled. Treat
        // audio as done if EITHER the playout head is reached OR the clock has
        // arrived at the real end of content — whichever the clock can attain.
        const reachedContentEnd =
          duration > 0 && currentTime >= duration + this.startTime - 0.25;
        const audioPlayedOut =
          (maxScheduled > 0 && currentTime >= maxScheduled - 0.1) ||
          reachedContentEnd;
        // The clock is clamped to the audio playout head (getAudioClock caps
        // at maxScheduledMediaTime). When the last video frame's PTS sits past
        // that head — e.g. video runs a few ms longer than the audio track —
        // the presentation loop never reaches it, so it lingers in the queue
        // forever and a strict queue-empty check would block the ended
        // transition indefinitely (EOF reached, but never ends). Once the
        // demuxer and video decoder are both drained, treat the renderer as
        // done if its queue is empty OR only holds this unpresentable tail
        // (head frame at/after the audio playout head).
        const headFrameTime = this.videoRenderer?.getHeadFrameTime() ?? -1;
        const videoDone =
          !this.videoRenderer ||
          this.videoRenderer.getQueueSize() === 0 ||
          (decodersDone &&
            maxScheduled > 0 &&
            headFrameTime >= maxScheduled - 0.05);
        if ((decodersDone && videoDone && audioPlayedOut) || duration === 0) {
          this.handleEnded();
          return;
        }
        // Watchdog: the audio has fully played out (it's the master clock and
        // its playout head has been reached) but the strict conditions above
        // never all aligned — a marginal float mismatch between the audio tail
        // and the last video frame can leave one frame unpresentable forever.
        // Once audio is done and we've waited a beat, end rather than freeze.
        if (
          audioPlayedOut &&
          this.eofSince > 0 &&
          performance.now() - this.eofSince > 750
        ) {
          Logger.warn(
            TAG,
            "EOF watchdog: audio played out but pipeline never fully drained; forcing ended",
          );
          this.handleEnded();
          return;
        }
      } else {
        // Video-only: WebCodecs decodeQueueSize drops to 0 before all output
        // callbacks fire, so the decoder's queue cannot say when the picture is
        // finished. The clock ARMS the ending half a second before the end and
        // the picture running out FINISHES it — ending on the clock alone threw
        // away thirty frames at 60fps (upstream f266004).
        //
        // An empty renderer queue is necessary but not sufficient: it reads
        // zero for an instant while output callbacks are in flight, so the
        // decoder must also have been quiet for EOF_PICTURE_SETTLE_MS.
        if (timeDone) {
          const pictureLeft = (this.videoRenderer?.getQueueSize() ?? 0) > 0;
          const decoderQuiet =
            (this.videoDecoder?.msSinceLastFrame?.() ??
              Number.POSITIVE_INFINITY) > MoviPlayer.EOF_PICTURE_SETTLE_MS;
          if (!pictureLeft && decoderQuiet) {
            this.handleEnded();
            return;
          }
          // …and never wait forever: a last frame whose PTS sits past the
          // container's duration can never come due against a clock clamped
          // to that duration. Measured from when the ending was armed, not from
          // eofSince, which a small fully-buffered file reaches seconds earlier.
          if (this._eofPictureDrainSince === 0) {
            this._eofPictureDrainSince = performance.now();
          } else if (
            performance.now() - this._eofPictureDrainSince >
            MoviPlayer.EOF_PICTURE_DRAIN_MS
          ) {
            Logger.warn(
              TAG,
              `EOF watchdog: ${this.videoRenderer?.getQueueSize() ?? 0} frame(s) never came due; ending`,
            );
            this.handleEnded();
            return;
          }
        }
      }
      return; // Don't demux more, just wait for playback to finish
    }

    // Read-ahead cap: while a seek's first frame hasn't arrived, stop reading
    // once we've demuxed SEEK_MAX_DEMUX_AHEAD_SECONDS past the target. Every
    // packet the first frame needs (keyframe <= target through target) is
    // already read well before this, so this only halts a runaway; the hard
    // watchdog above terminates the seek if the frame never comes.
    if (this.seekReadAheadExceeded()) {
      return;
    }

    // Read until every consumed stream has its readahead queued (see
    // needsMorePackets), feeding the decoders after each packet, and give the
    // main thread back every READ_SLICE_MS. This replaced a per-tick burst
    // size tuned by fps, post-seek state, keyframe waits and whether the file
    // had audio — all of them guesses at how many packets would keep the
    // decoders fed without starving anything, which the queues now answer
    // directly.
    try {
      // Final check before starting async operation - ensure no new seek started
      if (this.seekSessionId !== currentSessionId) {
        Logger.debug(TAG, "ProcessLoop aborted before demux: new seek started");
        return;
      }

      this.demuxInFlight = true;
      this.demuxInFlightStartTime = performance.now();
      let sliceStart = performance.now();

      for (;;) {
        const sliceLimits = this.pipelineLimits();
        this.feedDecoders(sliceLimits);
        if (!this.needsMorePackets(sliceLimits.readaheadSecs)) break;
        if (this.seekReadAheadExceeded()) break;

        if (performance.now() - sliceStart >= MoviPlayer.READ_SLICE_MS) {
          // MessageChannel rather than setTimeout: it runs as soon as the
          // tasks queued behind us have, without the timer clamp.
          const channel = new MessageChannel();
          await new Promise((resolve) => {
            channel.port1.onmessage = resolve;
            channel.port2.postMessage(null);
          });
          if (this.seekSessionId !== currentSessionId) {
            Logger.debug(
              TAG,
              "ProcessLoop aborted during packet read: new seek started",
            );
            return;
          }
          // Paused (or torn down) while we yielded: stop reading for a
          // pipeline nothing is consuming.
          if (!this.pipelineRunning()) break;
          sliceStart = performance.now();
        }

        const demuxer = this.demuxer;
        if (!demuxer) break;
        // Per read, not per loop: the in-flight timeout above is about one
        // read that never returns, and a loop that keeps reading for longer
        // than that on a slow link is healthy.
        this.demuxInFlightStartTime = performance.now();
        const readEpoch = this._refreshEpoch;
        const packet = await demuxer.readPacket();

        // Check again after async readPacket - seek may have started during read
        if (this.seekSessionId !== currentSessionId) {
          Logger.debug(
            TAG,
            "ProcessLoop aborted after readPacket: new seek started",
          );
          return;
        }

        if (!packet) {
          // No bytes can mean two very different things, and they arrive
          // identically. The demuxer reads through a C callback that answers
          // with a byte count, so a read that FAILED looks exactly like the end
          // of the file: FFmpeg reports EOF either way. A source that had been
          // refused mid-file therefore ended the video — the picture stopped,
          // the clock jumped to the duration, and anything watching for "ended"
          // (an autoplay-next, a playlist) moved on as though the video had
          // simply finished. Ask the source which of the two this was.
          const sourceFailure = (
            this.source as { getFatalError?: () => Error | null } | null
          )?.getFatalError?.();
          if (sourceFailure) {
            Logger.error(
              TAG,
              `Read returned nothing because the source failed, not because the file ended: ${sourceFailure.message}`,
            );
            throw sourceFailure;
          }
          // EOF reached - mark it but don't stop immediately
          // Let the decoders finish processing
          this.markEof();

          // Clear seeking flag if we hit EOF before finding keyframe
          if (this.seekingToKeyframe) {
            this.seekingToKeyframe = false;
            Logger.warn(TAG, "EOF reached before finding keyframe after seek");
          }

          // If we were waiting for sync, trigger it now so player doesn't hang in loading state
          if (this.waitingForVideoSync) {
            Logger.warn(
              TAG,
              "EOF reached while waiting for seek sync, forcing completion",
            );
            // forced=true: this is a no-frame forced completion (the decoder
            // exhausted the stream without a decodable frame — e.g. an open-GOP
            // 4K AV1 whose keyframes the HW decoder keeps rejecting). Without the
            // flag, notifySeekCompletion advances the clock straight into
            // "playing" over a BLACK screen (framesPresented=0) that only a
            // manual seek recovers. With it, the forcedWithoutFrame path resumes
            // into "buffering" with play intent latched, so the first frame that
            // actually decodes — e.g. after the ABR downshifts to a rendition the
            // decoder CAN handle — auto-flips to "playing". Matches the seek-
            // timeout path, which already passes forced=true.
            this.notifySeekCompletion(this.seekTargetTime, true);
          }

          Logger.debug(TAG, "EOF reached");
          break;
        }

        this.enqueuePacket(packet, readEpoch !== this._refreshEpoch);
      }
    } catch (e) {
      // Belongs to a pipeline that has since been swapped out — its source was
      // closed under it on purpose. Nothing to report and nothing to recover.
      if (pipelineGeneration !== this._demuxerGeneration) {
        Logger.debug(TAG, "Demux error from a retired pipeline — ignoring", e);
        this.demuxInFlight = false;
        return;
      }
      Logger.error(TAG, "Demux error", e);

      // Check for fatal errors that indicate corrupted state
      const errorMessage = (e as any).message || "";
      // WASM-level traps. Once av_read_frame or any other FFmpeg entry
      // point dereferences past the heap, the entire WASM module is
      // unrecoverable — every subsequent ccall hits the same OOB. Without
      // this branch, processLoop classifies it as transient and retries
      // every ~17ms, flooding the console and pinning the CPU until the
      // user closes the tab.
      const isWasmFatal =
        /out of bounds memory access|memory access out of bounds|RuntimeError|Aborted\(\)/i.test(
          errorMessage,
        );
      const isCorruptError =
        isWasmFatal ||
        errorMessage.includes("Invalid packet size") ||
        errorMessage.includes("Invalid typed array length") ||
        errorMessage.includes("State may be corrupted");

      // Source-level failures (HTTP 4xx/5xx, exhausted retries, CORS, etc.)
      // surface through here as the demuxer reads its bytes from the source.
      // Without classifying these as fatal, processLoop just keeps retrying
      // the demux and the buffering spinner spins indefinitely with no
      // user-visible reason. The actual messages come from HttpSource —
      // see the strings it throws in startStream/buildHeaders.
      const isSourceError =
        // Unanchored — the demuxer wraps it ("Failed to open media: HTTP 403"),
        // and a wrapped 4xx is every bit as fatal as a bare one.
        /\bHTTP \d{3}\b/.test(errorMessage) ||
        errorMessage.includes("Access denied") ||
        errorMessage.includes("Authentication required") ||
        errorMessage.includes("Video not found") ||
        errorMessage.includes("Failed to fetch video resource") ||
        errorMessage.includes("Stream failed after") ||
        errorMessage.includes("Server does not support range requests");

      if (isWasmFatal) {
        // The abort left the SHARED cached WASM module permanently dead — the
        // main demuxer reuses that singleton, so without this every later open
        // (a new video, a quality switch) fails "File is corrupted" until a page
        // reload. Drop the cached module so the recovery reload — and the next
        // source — instantiates a fresh one instead of reusing the corpse.
        resetWasmModule();
      }

      if (isCorruptError || isSourceError) {
        Logger.error(
          TAG,
          isSourceError
            ? `Fatal source error, pausing playback: ${errorMessage}`
            : "Fatal demux error detected, pausing playback",
        );
        this.pause();
        this.stateManager.setState("error");
        this.emit(
          "error",
          isSourceError
            ? e instanceof Error
              ? e
              : new Error(errorMessage)
            : new Error("Playback error: corrupt data stream"),
        );
        return; // Exit process loop
      }

      // For non-fatal errors, continue (transient network glitches, etc.)
    } finally {
      this.demuxInFlight = false;
    }
  };

  /** True while something is consuming what the read loop produces. */
  private pipelineRunning(): boolean {
    const state = this.stateManager.getState();
    return (
      state === "playing" || state === "buffering" || this.waitingForVideoSync
    );
  }

  /**
   * The ceilings the feed step works to, and the readahead the read loop
   * reads to. Recomputed per use because every input (rate, decoder path,
   * seek state, backgrounding) can change between two packets.
   */
  private pipelineLimits(): {
    maxVideoQueue: number;
    maxAudioQueue: number;
    maxVideoBuffered: number;
    maxAudioBuffered: number;
    readaheadSecs: number;
  } {
    const decodeMode = getDecodeMode(this.videoDecoder, this.audioDecoder);
    const isVideoSoftware = decodeMode.videoSoftware;
    const isAudioSoftware = decodeMode.audioSoftware;
    const isVideoWorkerSoftware = Boolean(
      this.videoDecoder.getStats?.()?.worker,
    );
    const isAudioWorkerSoftware = Boolean(this.audioDecoder.getStats().worker);
    const isPostSeek =
      this.justSeeked &&
      performance.now() - this.seekTime < MoviPlayer.POST_SEEK_THROTTLE_MS;

    // Adaptive limits for software/hardware modes
    // During post-seek or while waiting for initial sync, we are more permissive with decoder queues
    // to ensure they have enough data to output the first few frames.
    const maxVideoQueue = isVideoWorkerSoftware
      ? 48
      : isVideoSoftware
        ? 1000
        : isPostSeek || this.waitingForVideoSync
          ? 60
          : 30;
    const maxAudioQueue = isAudioWorkerSoftware
      ? 96
      : isAudioSoftware
        ? 40
        : isPostSeek || this.waitingForVideoSync
          ? 40
          : 20;

    // Buffer targets — scale up at slow speeds so both audio and video buffers
    // hold the same wall-clock duration as at 1x. Without this, at 0.5x the 100-frame
    // video buffer lasts 3.3s wall-time while 2s audio buffer starves after 2s → stutter.
    const rate = Math.max(0.25, this.clock.getPlaybackRate());
    // Slow rates: keep the same wall-clock buffer duration (so a 2s audio
    // target doesn't underrun at 0.5x). Fast rates: give the video pipeline
    // proportional headroom too — at 1.5x the decoder is producing frames
    // 50% faster than wall-clock, and the base queue cap empties just as
    // quickly, so any decode jitter shows up as stutter. Cap at 2x scale
    // so 4x playback doesn't balloon VRAM/audio buffers on heavy sources.
    const rateScale = rate < 1.0 ? 1.0 / rate : Math.min(2.0, rate);
    // P4 — recomputed for the post-A5 architecture rather than inherited from
    // either side, because the thing that used to make a deep lead expensive is
    // gone and the thing that would make it catastrophic is new.
    //
    // Upstream capped the lead because every buffered frame was a live
    // AudioBufferSourceNode: ~215 of them at a 5s lead, which a phone's audio
    // thread cannot render in time. Two mechanisms now stand between the lead
    // and the graph, and they are from opposite sides of this merge:
    //
    //   - AudioRenderer.SCHEDULE_LOOKAHEAD (1.0s, upstream): buffers wait as
    //     plain data and become nodes only as their turn approaches, so the
    //     LEAD no longer sets the WIDTH of the graph. Live nodes ≈ one second's
    //     worth, whatever the lead is.
    //   - AudioRenderer's pendingPCM coalescing (fork, kept under A8): caps how
    //     many nodes one second of media can produce at all.
    //
    // Measured through the real WASM decoder and the real renderer (see the A8
    // block in test/render/audio-renderer.test.ts), nodes per second of media:
    // aac 47, mp3 42, ac3 32, dts 47, truehd 50. With a 1s lookahead that is a
    // worst case of ~50 live nodes at a 5s lead — a quarter of the 215 upstream
    // was reacting to.
    //
    // The same measurement is why the lead is NOT sized off upstream's
    // assumption that the decoder emits large frames: A5 made the worker the
    // primary path for every codec, and the worker posts libavcodec's frames
    // raw — TrueHD's are 40 samples, 1200 per second. Without the fork's
    // coalescing a 5s lead would mean 1200 live nodes, not 215.
    //
    // Since A5, isAudioSoftware is true for every audio track (needsSoftware-
    // Decoding() is unconditional), so this is now the lead for ALL audio, not
    // just the heavy codecs it was written for. That is intended: the branch it
    // used to select against — a hardware WebCodecs audio decoder — no longer
    // exists.
    const maxAudioBuffered =
      (isAudioSoftware ? 5.0 : isPostSeek ? 1.5 : 2.0) * rateScale;
    // Renderer queue limits (in frames). Two separate constraints:
    //
    //  1. High-res (≥4K): per-frame VRAM cost is huge (8K HDR ≈ 50MB/frame).
    //     A deep queue locks GBs of VRAM and starves the GPU compositor,
    //     producing slips even when decode is keeping up. Hard frame cap.
    //
    //  2. Mobile at any res: weaker hardware + Chrome Android's conservative
    //     AV1 HW whitelist mean software dav1d is common; deep buffering
    //     just delays the inevitable underrun. Cap by wall-clock duration
    //     (~800ms) so the cap scales with fps — a 25fps source doesn't end
    //     up with the same tiny 16-frame buffer as 60fps, which would fire
    //     demuxer backpressure long before audio is ready to refill (this
    //     was the "audio drift" symptom).
    //
    // When both apply (e.g. 8K on mobile), use the tighter of the two.
    const activeVideo = this.trackManager.getActiveVideoTrack();
    const pixels = (activeVideo?.width ?? 0) * (activeVideo?.height ?? 0);
    const fps = Math.max(15, Math.min(120, activeVideo?.frameRate ?? 30));
    const is8KPlus = pixels >= 7680 * 4320;
    const isHighRes = pixels >= 3840 * 2160; // 4K and above
    const isMobile = MoviPlayer._isMobileDevice;
    let baseHwQueue: number;
    if (is8KPlus) {
      // 8K+ desktop: 16 frames is a VRAM-bound sweet spot (8K HDR frames are
      // ~50MB each; deeper queues stall the compositor and 100 × 50MB ≈ 5GB
      // VRAM was the original starvation cause). Mobile shifts to software
      // dav1d so a shallow queue helps the decoder catch up.
      if (isMobile) baseHwQueue = isPostSeek ? 8 : 12;
      else baseHwQueue = isPostSeek ? 12 : 16;
    } else if (isHighRes) {
      // 4K (not 8K) desktop: 4K HDR RGBA8 frames are ~33MB so 48 × 33MB ≈
      // 1.6GB VRAM — bounded but deep enough to absorb 250-500ms GC/decode
      // hiccups without draining the renderer queue. The previous uniform
      // 16-frame cap (267ms @60fps) was too shallow for 4K60 HEVC HDR: any
      // jitter emptied the queue, paused demuxing, and starved audio.
      if (isMobile) baseHwQueue = isPostSeek ? 8 : 16;
      else baseHwQueue = isPostSeek ? 24 : 48;
    } else if (isMobile) {
      // 1080p (and lighter) on mobile is smooth at the 800ms target — keep it.
      const targetMs = isPostSeek ? 400 : 800;
      baseHwQueue = Math.max(12, Math.round((fps * targetMs) / 1000));
    } else {
      baseHwQueue = isPostSeek ? 20 : 100; // desktop default
    }
    const maxVideoBuffered = Math.round(
      (isVideoSoftware ? 60 : baseHwQueue) * rateScale,
    );

    // How much each consumed stream's queue should hold beyond what its
    // decoder has taken before the read loop rests — mpv's demuxer readahead.
    // The same seconds the decoded-audio target already uses (5s for software
    // audio, which since A5 is every track; 2s otherwise), so the packets
    // waiting behind a full decoder cover about as much as the decoder itself
    // was allowed to get ahead.
    const readaheadSecs = (isAudioSoftware ? 5.0 : 2.0) * rateScale;

    return {
      maxVideoQueue,
      maxAudioQueue,
      maxVideoBuffered,
      maxAudioBuffered,
      readaheadSecs,
    };
  }

  /**
   * mpv's read decision (demux/demux.c): read while any stream the player is
   * consuming has nothing queued, or less than the readahead, and only while
   * the queues together are under their byte ceiling. A full video decoder no
   * longer stops anything but the video feed — the audio queue running dry is
   * reason enough to read, and the video packets read on the way wait in
   * their own queue instead of being dropped to make room.
   */
  private needsMorePackets(readaheadSecs: number): boolean {
    if (
      this.videoQueue.bytes + this.audioQueue.bytes >=
      MoviPlayer.MAX_QUEUE_BYTES
    ) {
      return false;
    }
    const consumed: PacketQueue[] = [];
    if (this.videoIsConsumed()) consumed.push(this.videoQueue);
    if (this.audioIsConsumed()) consumed.push(this.audioQueue);
    return consumed.some(
      (q) => q.length === 0 || q.forwardSeconds() < readaheadSecs,
    );
  }

  /**
   * Video whose packets are thrown away at the feed — audio-only mode, a
   * hidden tab outside PiP — gets no say in the read decision: its queue is
   * empty by construction and would keep the loop reading to the end of the
   * file.
   */
  private videoIsConsumed(): boolean {
    return (
      !!this.trackManager.getActiveVideoTrack() &&
      !this._audioOnly &&
      !this.videoFinished() &&
      !(this.isBackgrounded && !this.isPiPActive)
    );
  }

  private audioIsConsumed(): boolean {
    return !!this.trackManager.getActiveAudioTrack() && !this.disableAudio;
  }

  /**
   * Whether there is sound the stall logic should wait on. Split
   * (separate-URL) audio has no track in the MAIN demuxer's trackManager — it
   * is decoded from its own demuxer straight into the audio renderer — so
   * asking the track manager alone reads as "no audio at all" on every split
   * source, and `bindav` then held the way IN to a stall and let go the way
   * OUT on the picture alone. And audio the browser will not let us start
   * (autoplay-blocked, suspended context) never fills its buffer, so waiting
   * on it never ends.
   */
  private audioIsPlayable(): boolean {
    return (
      (!!this.trackManager.getActiveAudioTrack() || !!this.audioDemuxer) &&
      !this.disableAudio &&
      // The sound is being rebuilt for a track switch: what the buffer holds
      // says nothing about the link, so nothing waits on it.
      !this._audioSwitching &&
      // …and sound that has played out for good (a track that ends before the
      // file does) is not sound that is late: nothing waits for it.
      !this.audioFinished() &&
      !this.audioRenderer.isDroppingAudio()
    );
  }

  /** The packet queue the active audio is read into. */
  private activeAudioQueue(): PacketQueue {
    return this.audioDemuxer ? this.splitAudioQueue : this.audioQueue;
  }

  /**
   * Seconds of media held ahead of the playhead on the least-provisioned
   * stream the player is consuming: packets still queued plus what the
   * decoders already turned into frames and samples. Infinity when nothing is
   * consumed. The buffering exit measures this (mpv reads the same quantity
   * off the demuxer to decide when to leave "paused for cache").
   */
  private bufferedAheadSeconds(): number {
    let ahead = Infinity;
    if (this.videoIsConsumed()) {
      const fps =
        this.trackManager.getActiveVideoTrack()?.frameRate ||
        (this.mediaInfo as any)?.videoFrameRate ||
        24;
      ahead = Math.min(
        ahead,
        this.videoQueue.forwardSeconds() +
          (this.videoRenderer?.getQueueSize() ?? 0) / fps,
      );
    }
    if (this.audioIsPlayable()) {
      // A split track that has been read to its end has nothing more to wait
      // for, however short what is left is.
      ahead = Math.min(
        ahead,
        this.audioDemuxer && this._splitAudioEof
          ? Infinity
          : this.activeAudioQueue().forwardSeconds() +
              this.audioRenderer.getBufferedDuration(),
      );
    }
    return ahead;
  }

  /**
   * True when a stream's output has run dry because nothing is left to feed
   * it — its packet queue is empty and its decoder holds nothing in flight.
   * An output that is empty while packets wait in the queue, or sit in the
   * decoder, is a slow decode, which buffering cannot fix (mpv enters
   * "paused for cache" only when the demuxer is also starved).
   */
  private videoSourceStarved(): boolean {
    return (
      this.videoQueue.length === 0 && (this.videoDecoder?.queueSize ?? 0) === 0
    );
  }

  private audioSourceStarved(): boolean {
    return (
      this.activeAudioQueue().length === 0 && this.audioDecoder.queueSize === 0
    );
  }

  private clearPacketQueues(): void {
    this.videoQueue.clear();
    this.audioQueue.clear();
    // What the queues had taken is gone, and with it what a refresh would
    // have had to skip.
    this._refreshingVideo = false;
    this._refreshingSubtitle = false;
    this._lastSubtitleDts = Number.NaN;
  }

  /**
   * Route a packet the demuxer returned: audio and video into their queues,
   * subtitles straight to their decoder, anything inactive nowhere. The read
   * loop, the load-time prebuffer and pause-time buffering all go through
   * here, which is what lets the first two stop keeping stashes of their own.
   */
  private enqueuePacket(packet: Packet, stale = false): void {
    if (this.switchTraceActive && !stale) {
      this.traceAudioSwitch(
        "first-packet",
        {
          stream: packet.streamIndex,
          pts: packet.timestamp,
          clock: this.clock.getTime(),
        },
        true,
      );
    }
    // Track how far past the seek target we've demuxed so the read-ahead
    // cap can halt a frame-starved seek before it downloads forever.
    if (
      this.waitingForVideoSync &&
      Number.isFinite(packet.timestamp) &&
      packet.timestamp > this.seekDemuxAheadTime
    ) {
      this.seekDemuxAheadTime = packet.timestamp;
    }

    if (!this.trackManager.isActiveStream(packet.streamIndex)) return;
    this.notePassPacket(packet);

    const activeVideo = this.trackManager.getActiveVideoTrack();
    if (activeVideo && activeVideo.id === packet.streamIndex) {
      // A refresh re-read starts before the playhead: what the queue already
      // took is dropped here, before it can reach the decoder a second time,
      // and the first packet past it ends the refresh. A packet read before
      // the seek landed is the stream's own next one, never a duplicate.
      if (this._refreshingVideo && !stale) {
        const dts = Number.isFinite(packet.dts) ? packet.dts : packet.timestamp;
        if (dts <= this.videoQueue.lastDts) return;
        this._refreshingVideo = false;
      }
      this.videoQueue.push(packet);
      return;
    }

    const activeAudio = this.trackManager.getActiveAudioTrack();
    if (activeAudio && activeAudio.id === packet.streamIndex) {
      if (this.disableAudio) return;
      if (this.switchTraceActive && !stale) {
        this.traceAudioSwitch(
          "first-audio-packet",
          {
            pts: packet.timestamp,
            clock: this.clock.getTime(),
            seekTarget: this.seekTargetTime,
          },
          true,
        );
      }
      // Audio before the seek target is never wanted: FFmpeg lands on the
      // keyframe before the target, and the audio interleaved up to it would
      // otherwise anchor the renderer early.
      if (
        this.seekTargetTime !== -1 &&
        packet.timestamp < this.seekTargetTime
      ) {
        return;
      }
      // Read before an audio track switch's refresh seek landed: from the
      // position the switch is abandoning, however far ahead the new track's
      // first packet is there. The re-read supplies the right ones.
      if (stale) return;
      this.audioQueue.push(packet);
      return;
    }

    // Subtitles are re-read by a refresh too; same rule as video.
    const dts = Number.isFinite(packet.dts) ? packet.dts : packet.timestamp;
    if (this._refreshingSubtitle && !stale) {
      if (dts <= this._lastSubtitleDts) return;
      this._refreshingSubtitle = false;
    }
    this._lastSubtitleDts = dts;
    this.dispatchSubtitlePacket(packet);
  }

  private dispatchSubtitlePacket(packet: Packet): void {
    // Check for subtitle track
    const activeSubtitle = this.trackManager.getActiveSubtitleTrack();
    const custom =
      activeSubtitle && activeSubtitle.id === packet.streamIndex
        ? this._customRendererFor(activeSubtitle)
        : null;
    if (custom) {
      // A host renderer (e.g. jassub/libass) owns this track — hand it the
      // raw packet and skip the internal decoder entirely.
      try {
        void custom.pushPacket(packet);
      } catch (e) {
        Logger.error(TAG, "Custom subtitle renderer pushPacket failed", e);
      }
    } else if (
      activeSubtitle &&
      activeSubtitle.id === packet.streamIndex &&
      this.subtitleDecoder
    ) {
      let duration = packet.duration;
      if (!duration || duration <= 0) {
        duration = 0;
        Logger.debug(
          TAG,
          `Subtitle packet has no duration, will use fallback: timestamp=${packet.timestamp.toFixed(3)}s`,
        );
      }
      Logger.debug(
        TAG,
        `Processing subtitle packet: stream=${packet.streamIndex}, size=${packet.data.length}, timestamp=${packet.timestamp.toFixed(3)}s, duration=${duration > 0 ? duration.toFixed(3) : "fallback"}s`,
      );
      this.subtitleDecoder
        .decode(packet.data, packet.timestamp, packet.keyframe, duration)
        .catch((error) => {
          Logger.error(TAG, "Subtitle decode error", error);
        });
    }
  }

  private feedDecoders(limits = this.pipelineLimits()): void {
    this.feedVideo(limits);
    this.feedAudio(limits);
  }

  /**
   * Hand queued video to the decoder while it — and the renderer behind it —
   * has room. Packets that are not wanted are dropped here, at the head of
   * the queue, rather than at read time, so the read decision never depends
   * on what the decoder will do with them.
   */
  private feedVideo(limits: {
    maxVideoQueue: number;
    maxVideoBuffered: number;
  }): void {
    // Audio-only mode and a hidden tab (outside PiP) skip video decode
    // entirely: decode is the expensive part, and nothing would show the
    // frames. Toggling back to video re-seeks to recover a keyframe (see
    // setAudioOnly and resyncVideoToAudio).
    const discard =
      this._audioOnly || (this.isBackgrounded && !this.isPiPActive);
    while (this.videoQueue.length > 0) {
      if (discard) {
        this.videoQueue.shift();
        continue;
      }
      if (this.videoDecoder.queueSize > limits.maxVideoQueue) return;
      if ((this.videoRenderer?.getQueueSize() ?? 0) > limits.maxVideoBuffered) {
        return;
      }
      const packet = this.videoQueue.shift()!;
      if (this.seekingToKeyframe && !this.admitVideoAfterSeek(packet)) continue;
      // All packets including pre-target are decoded to build reference
      // frames; the onFrame callback filters out frames before seekTargetTime.
      this.videoDecoder.decode(
        packet.data,
        packet.timestamp,
        packet.keyframe,
        packet.dts,
        packet.isIdr,
        packet.isRasl,
      );
    }
  }

  /**
   * After a seek, skip video until a keyframe the decoder can restart on —
   * a flushed decoder fed a delta errors. Returns false for a packet to skip.
   */
  private admitVideoAfterSeek(packet: Packet): boolean {
    // Check timeout - if we've been waiting too long, give up and accept any frame
    const elapsed = performance.now() - this.seekingToKeyframeStartTime;
    this.seekKeyframeScanned++;
    // Prefer a true IDR to restart: on mixed-keyframe HEVC a CRA sent
    // as `key` is rejected by the HW decoder (open-GOP) and forces a
    // software fallback, while an IDR restarts cleanly. But accept a
    // CRA if no IDR arrives quickly — some streams have only CRA
    // keyframes for long stretches (seeking deep into a DoVi P8 .ts),
    // where waiting for an IDR never resumes and the video stays black.
    const idrWaitElapsed = elapsed > MoviPlayer.SEEK_IDR_WAIT_MS;
    // A CRA at/before the seek target IS the demuxer's restart point —
    // decode straight from it (pre-target frames are dropped by the
    // onFrame filter). The IDR-preference below only helps when a true
    // IDR sits within a few frames of the target; a CRA-only stream
    // has none, and skipping the target CRA then lets the demux loop
    // (which outruns the 400ms wall-clock IDR wait) race through the
    // whole file, skipping every CRA to EOF with no frame decoded →
    // permanent "buffering". So accept the target CRA outright rather
    // than hunt for an IDR that never arrives.
    const isTargetCra =
      packet.keyframe &&
      this.seekTargetTime !== -1 &&
      packet.timestamp <= this.seekTargetTime + 0.05;
    const acceptThisKeyframe =
      packet.keyframe && (packet.isIdr || idrWaitElapsed || isTargetCra);
    // Starved (few packets scanned) means we're waiting on the network,
    // not on a distant keyframe — extend to the hard ceiling instead of
    // feeding the decoder a non-keyframe and painting black.
    const starved =
      this.seekKeyframeScanned < MoviPlayer.SEEK_KEYFRAME_MIN_SCAN;
    const timedOut =
      elapsed >
      (starved
        ? MoviPlayer.KEYFRAME_SEEK_HARD_TIMEOUT
        : MoviPlayer.KEYFRAME_SEEK_TIMEOUT);
    if (timedOut) {
      Logger.warn(
        TAG,
        `Keyframe seek timeout after ${elapsed.toFixed(0)}ms (scanned=${this.seekKeyframeScanned}, starved=${starved}), accepting any frame`,
      );
      this.seekingToKeyframe = false;
      return true;
    }
    if (!acceptThisKeyframe) {
      // Not yet: skip non-keyframes, and skip CRA keyframes while still
      // within the short IDR-wait window (hoping a true IDR is near).
      if (packet.keyframe) this.seekCraSeen++;
      return false;
    }
    // Found a keyframe to restart on (IDR, or a CRA after the wait).
    this.seekingToKeyframe = false;
    Logger.debug(
      TAG,
      `Found ${packet.isIdr ? "IDR" : "CRA"} keyframe after seek (craSkipped=${this.seekCraSeen}), resuming normal playback`,
    );
    this.seekCraSeen = 0;
    return true;
  }

  /**
   * Hand queued audio to the decoder while it has room and the decoded
   * cushion is under target. Held entirely while a seek waits for its first
   * video frame — notifySeekCompletion decides where the clock starts and
   * trims the head of this queue to match.
   */
  private feedAudio(limits: {
    maxAudioQueue: number;
    maxAudioBuffered: number;
  }): void {
    if (this.audioQueue.length === 0) return;
    if (
      this.waitingForVideoSync &&
      this.trackManager.getActiveVideoTrack() &&
      // A seek past the last frame has no picture to wait for.
      !this.videoFinished()
    ) {
      return;
    }
    // The new decoder of an audio track switch is still being configured; a
    // packet handed to it now would be lost. The queue keeps them.
    if (this._audioDecoderConfiguring) return;

    // Audio the browser will not let us play (muted autoplay with a
    // suspended context) is decoded and dropped. With no cushion to fill,
    // nothing would stop the decoder taking the whole queue as fast as the
    // demuxer can supply it; pace it to the clock instead, the way the
    // split-audio pump does.
    const paceLimit = this.audioRenderer.isDroppingAudio()
      ? this.clock.getTime() + 0.25
      : Number.POSITIVE_INFINITY;

    // Software codecs (TrueHD/MLP/DTS) on the legacy main-thread decoder go
    // in as one batch per feed — their access units are tiny, so the
    // per-packet WASM round-trip, not the decode itself, is what starves the
    // renderer. Nothing reaches the decoder until the batch is submitted, so
    // its size is bounded by the cushion still missing, in media time.
    if (this.audioDecoder.canBatch()) {
      const buffered = this.audioRenderer.getBufferedDuration();
      if (buffered > limits.maxAudioBuffered) return;
      const room = limits.maxAudioBuffered - buffered;
      const batch: Packet[] = [];
      let first = Number.NaN;
      while (this.audioQueue.length > 0) {
        const head = this.audioQueue.peek()!;
        if (head.timestamp > paceLimit) break;
        if (batch.length > 0 && head.timestamp - first > room) break;
        if (batch.length === 0) first = head.timestamp;
        batch.push(this.audioQueue.shift()!);
      }
      if (batch.length > 0) {
        this.submitAudioPackets(batch);
        for (const packet of batch) this.noteAudioFed(packet);
      }
      return;
    }

    while (this.audioQueue.length > 0) {
      if (this.audioDecoder.queueSize > limits.maxAudioQueue) return;
      if (this.audioRenderer.getBufferedDuration() > limits.maxAudioBuffered) {
        return;
      }
      const head = this.audioQueue.peek()!;
      if (head.timestamp > paceLimit) return;
      const packet = this.audioQueue.shift()!;
      // Decode audio even when muted. AudioRenderer keeps gain at 0 so
      // it stays silent, but the audio clock advances normally — without
      // this, unmute starts the audio timeline at wherever the demuxer
      // is (~1-3s ahead of presentation due to video buffer), and the
      // picture has to jump forward to chase it.
      this.audioDecoder.decode(packet.data, packet.timestamp, packet.keyframe);
      this.noteAudioFed(packet);
    }
  }

  /** The seek bookkeeping that hangs off audio reaching the seek target. */
  private noteAudioFed(packet: Packet): void {
    if (this.switchTraceActive) {
      this.traceAudioSwitch(
        "first-audio-fed",
        { pts: packet.timestamp, clock: this.clock.getTime() },
        true,
      );
    }
    if (this.seekTargetTime === -1 || packet.timestamp < this.seekTargetTime) {
      return;
    }
    Logger.debug(
      TAG,
      `Audio reached seek target: ${packet.timestamp.toFixed(3)}s (target: ${this.seekTargetTime.toFixed(3)}s)`,
    );
    const hasVideo =
      !!this.trackManager.getActiveVideoTrack() && !this.videoFinished();
    if (!hasVideo) {
      this.notifySeekCompletion(packet.timestamp);
    }
    // Retire it once audio is past: the guard exists to stop
    // already-scheduled audio being decoded a second time, and
    // there is none left behind this packet.
    //
    // Only safe to do here when VIDEO is not reading the same
    // field. On an ordinary seek it is — the pre-target frame
    // filter is this value — and the video side clears it when a
    // frame passes. During a video-only catch-up video has its own
    // gate (_videoResumeTarget) and deliberately leaves this one
    // armed for audio's sake, so nothing would ever clear it: the
    // branch above then logged for every audio packet, forever.
    if (this._videoResumeTarget !== -1 || !hasVideo) {
      this.seekTargetTime = -1;
    }
  }

  /** Turn the loop on or off. Looping itself is the element's `ended` handler. */
  setLoop(on: boolean): void {
    if (this._loopEnabled === on) return;
    this._loopEnabled = on;
    Logger.debug(TAG, `Loop ${on ? "enabled" : "disabled"}`);
  }

  isLoopEnabled(): boolean {
    return this._loopEnabled;
  }

  /**
   * The sound as levels, for drawing — `bars` bands, each 0..1, or null when
   * there is nothing playing to read. Used by the cover-art view's dotted
   * meter; any host can draw its own from the same numbers.
   */
  getAudioLevels(bars: number): Float32Array | null {
    if (this.disableAudio) return null;
    return this.audioRenderer?.getLevels?.(bars) ?? null;
  }

  /** How many times this source has looped, from 0. */
  getLoopCount(): number {
    return this._loopCount;
  }

  /** Counted once per replay-from-ended, whether the viewer pressed play or the
   *  element looped; a page watching `loop` should not have to care which. */
  private noteLoopTurn(): void {
    this._loopCount++;
    this.emit("loop", { count: this._loopCount });
    Logger.debug(TAG, `Loop: pass ${this._loopCount}`);
  }

  /**
   * Handle playback ended
   */
  private handleEnded(): void {
    Logger.info(TAG, "Playback ended");

    // Release WakeLock when playback ends
    this.releaseWakeLock();

    this.clock.pause();
    if (!this.disableAudio) {
      this.audioRenderer.pause();
    }

    // Stop video presentation loop
    if (this.videoRenderer) {
      this.videoRenderer.stopPresentationLoop();
    }

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Snap time to end. Drop the keyframe-jump offset so getCurrentTime()
    // reports the true duration — otherwise open-GOP sources (where the
    // first decodable IDR is ~2s in) report end ~2s short of duration.
    //
    // Audio-only caveat: VBR MP3 / OGG / similar containers expose a
    // bitrate-derived duration that's typically overestimated by a few
    // seconds vs. the actual decoded sample count. Snapping to that
    // inflated duration makes the time-display jump forward at EOF and
    // makes the source look like it ended ~4s short of "done." For
    // audio-only sources, prefer the real last-scheduled audio media
    // time and update mediaInfo.duration so the seek bar matches.
    if (this.mediaInfo) {
      this.seekKeyframeOffset = 0;
      const hasVideo = !!this.trackManager?.getActiveVideoTrack?.();
      const audioEnd = this.audioRenderer.getMaxScheduledMediaTime?.() ?? 0;
      const useAudioEnd = !hasVideo && audioEnd > 0;
      const endTime = useAudioEnd ? audioEnd : this.mediaInfo.duration;
      if (useAudioEnd && Math.abs(audioEnd - this.mediaInfo.duration) > 0.1) {
        // Correct the cached duration so getDuration() and the timeline
        // both show the real value instead of the metadata estimate.
        this.mediaInfo.duration = audioEnd;
        this.clock.setDuration(audioEnd + this.startTime);
        this.emit("durationChange", audioEnd);
      }
      this.clock.seek(endTime + this.startTime);
      this.emit("timeUpdate", endTime);
    }

    this.stateManager.setState("ended");
    this.emit("ended", undefined);
  }

  /**
   * Seek to timestamp
   */
  private seekSessionId = 0;
  // The seek session whose completion is currently armed (waitingForVideoSync).
  // notifySeekCompletion bails when this no longer matches seekSessionId, so a
  // superseded seek's late frame/timeout can't stomp state or consume intent.
  private seekArmedSessionId = 0;
  // The session a live seek() is actually driving. Everything else that bumps
  // seekSessionId — an in-place rendition swap, a subtitle prefetch, a recovery
  // re-seek — does so only to INVALIDATE whatever seek is in flight, and leaves
  // this alone. That difference is how a seek walking away from its own
  // supersession can tell "a newer seek owns the state machine now" from
  // "nobody does" (see abandonSupersededSeek).
  private _liveSeekSession = -1;
  private wasPlayingBeforeSeek = false;

  // True while an internal seek with no real interruption is in flight: the
  // initial poster seek(0), first play, and replay-from-ended. These route
  // through the full seek pipeline (flush + demuxer.seek + keyframe wait) so
  // the state machine briefly enters "seeking"/"buffering" even though, from
  // the user's view, nothing is loading. The UI reads this to keep the loading
  // spinner hidden during that window. Set via seek()'s suppressSpinner opt,
  // cleared on seek completion (notifySeekCompletion).
  suppressSeekSpinner = false;

  private getSeekStreamIndex(): number {
    if (this._audioOnly) return -1;
    return this.trackManager.getActiveVideoTrack()?.id ?? -1;
  }

  /**
  /**
   * The failure the source will not come back from, if there has been one.
   *
   * An expired or revoked link answers every subsequent byte range the same
   * way, so HttpSource latches the refusal and re-throws it on every read
   * without touching the network again. That latch is the only honest signal
   * that the video is over — the demuxer cannot supply one, because a read
   * that FAILED and a read that reached the end of the file both reach C as
   * "no bytes".
   */
  getSourceFailure(): Error | null {
    return (
      (
        this.source as { getFatalError?: () => Error | null } | null
      )?.getFatalError?.() ?? null
    );
  }

  /**
   * What the server called this source, from a request it had already made.
   *
   * Asked after an open has failed, to tell the one case the URL cannot: a
   * manifest served from a path with no extension. Empty for a source that
   * never saw an HTTP header — a file, an adapter, a stream already playing.
   */
  getSourceContentType(): string {
    return (
      (
        this.source as { getContentType?: () => string } | null
      )?.getContentType?.() ?? ""
    );
  }

  /** The same question for a separately-fetched audio rendition, which has a
   *  source of its own and therefore an expiry of its own. A split stream's
   *  two URLs are signed together and die together, but the audio is the one
   *  read on a tick of its own — see pumpSplitAudio. */
  getSplitAudioFailure(): Error | null {
    return this.audioSource?.getFatalError?.() ?? null;
  }

  /**
   * End playback on a failure nothing downstream can recover from.
   *
   * Pausing without this leaves the state machine in "buffering", which the
   * UI renders as a spinner that never resolves — the viewer is told the
   * video is loading when it is not coming at all.
   */
  failFatally(error: Error): void {
    if (this.stateManager.getState() === "error") return;
    Logger.error(TAG, `Fatal playback failure: ${error.message}`);
    this.pause();
    this.stateManager.setState("error");
    this.emit("error", error);
  }

  async seek(
    seconds: number,
    opts?: {
      suppressSpinner?: boolean;
      preservePlaying?: boolean;
      /**
       * Machinery, not a request: rendering the first frame, priming a poster,
       * re-anchoring after a context loss. `seeking`/`seeked` stay quiet for
       * these — a media element repositioning itself internally says nothing
       * either, because those events answer for what a page asked for.
       */
      internal?: boolean;
    },
  ): Promise<void> {
    this._seekIsInternal = opts?.internal ?? false;
    // A seek rebuilds the picture at its target; there is nothing left to catch
    // up to the clock that was held.
    this.endVideoCatchUp();

    if (this.streamWrapper) {
      return this.streamWrapper.seek(seconds);
    }

    // Split audio-only: seek ONLY the separate audio demuxer + clock; never
    // touch the main (video) demuxer whose body we're skipping, and never wait
    // for a video-sync that will never come (flush decoder, reset renderer,
    // re-seek the audio demuxer, restart the audio loop).
    if (this._audioOnly && this.audioDemuxer) {
      const t = Math.max(0, Math.min(seconds, this.getDuration() || seconds));
      this.stopAudioLoop();
      let guard = 0;
      while (this.audioDemuxInFlight && guard++ < 200) {
        await new Promise((r) => setTimeout(r, 5));
      }
      this.audioDecoder.flush();
      this.audioRenderer.reset();
      try {
        // Seek in the audio source's own PTS baseline (may differ from video's).
        this._splitAudioSkipBefore = -1;
        await this.audioDemuxer.seek(t + this._splitAudioStartTime);
      } catch (e) {
        Logger.warn(
          TAG,
          `Split audio-only seek failed: ${(e as any)?.message ?? e}`,
        );
      }
      this._splitAudioEof = false;
      this.splitAudioQueue.clear();
      this._lastSplitAudioPts = t;
      this.seekTargetTime = -1;
      this.clock.seek(t + this.startTime);
      this.seekKeyframeOffset = 0;
      this.resetEof(t + this.startTime);
      // Honor a resume intent, mirroring what the video path does in
      // notifySeekCompletion. play()'s first-play (and replay) branch sets
      // wasPlayingBeforeSeek before calling seek(0); in audio-only there are no
      // video frames to decode, so that completion callback NEVER fires and the
      // transition to "playing" would otherwise never happen — autoplay on an
      // auto-advanced track silently stalls in "ready" (audio loop never
      // starts, context never resumes) until a manual play. Drive it here.
      // Also covers an already-rolling state (a live user scrub while playing).
      const shouldResume =
        this.wasPlayingBeforeSeek ||
        this.wasPlayingBeforeRebuffer ||
        this.stateManager.is("playing") ||
        this.stateManager.is("buffering");
      if (shouldResume) {
        this.wasPlayingBeforeSeek = false;
        this.wasPlayingBeforeRebuffer = false;
        if (this._playStartTime === 0) {
          this._playStartTime = performance.now();
        }
        if (!this.stateManager.is("playing")) {
          this.stateManager.setState("playing");
        }
        this.clock.start();
        // Split audio-only runs playback entirely from here — play()'s body,
        // and with it the one call that starts the renderer, is never reached.
        // Nothing is being presented either way; what this starts is the
        // caption clock, without which subtitles turned on in audio-only sit
        // there for the whole track (see setPictureSuspended).
        this.videoRenderer?.startPresentationLoop();
        // Resume the (auto-suspended) context so audio is audible. Fire-and-
        // forget like the video path — the shared context was already unlocked
        // by the previous track, so this wakes it without a fresh gesture.
        if (!this.disableAudio && !this.audioRenderer.isAudioPlaying()) {
          this.audioRenderer.play();
        }
        this.startAudioLoop();
      }
      if (!this._seekIsInternal) this.emit("seeking", t);
      this.emit("timeUpdate", t);
      this.emit("seekcomplete", t);
      if (!this._seekIsInternal) this.emit("seeked", t);
      return;
    }

    // A genuine user seek (no opt) clears any leftover suppression so its
    // spinner shows; play()-initiated seeks pass suppressSpinner to hide it.
    this.suppressSeekSpinner = opts?.suppressSpinner ?? false;
    // preservePlaying: a corrective seek (e.g. rate change) that must NOT flip
    // the play/pause state. If we were playing — including mid-flight from a
    // prior corrective seek (state "seeking"/"buffering") — keep the resume
    // intent so completion lands back in "playing", never "paused".
    if (opts?.preservePlaying) {
      const s = this.stateManager.getState();
      if (s !== "paused" && s !== "ended") {
        this.wasPlayingBeforeSeek = true;
      }
    }

    const currentState = this.stateManager.getState();
    Logger.info(
      TAG,
      `seek(${seconds.toFixed(2)}): state=${currentState}, waitingForVideoSync=${this.waitingForVideoSync}, demuxInFlight=${this.demuxInFlight}, seekSessionId=${this.seekSessionId}`,
    );

    // Safety check - though PlayerState now permits it
    if (!this.stateManager.canSeek()) {
      Logger.warn(TAG, `seek blocked: canSeek=false, state=${currentState}`);
      return;
    }

    // A source that has permanently refused will refuse every byte this seek
    // asks for too. Seeking anyway spends the whole deadline waiting for a
    // frame that cannot be decoded, forces completion without one, and lands
    // in "buffering" — where the element's stuck watchdog seeks forward and
    // starts the same round again. A log of an expired link shows exactly
    // that: 587s → 591s → 597s, the timeline creeping under a spinner that
    // never resolves. The source is dead; say so instead of walking the
    // playhead through it.
    const preSeekFailure = this.getSourceFailure();
    if (preSeekFailure) {
      Logger.error(
        TAG,
        `seek(${seconds.toFixed(2)}) refused: the source has failed permanently`,
      );
      this.failFatally(preSeekFailure);
      return;
    }

    if (!this.demuxer) {
      throw new Error("Demuxer not initialized");
    }

    // Stop pause-time buffering — seek invalidates queued packets
    this.stopPauseBuffering();

    // Track intent: if we were playing (or already seeking but originally playing), we want to resume
    // During buffering, preserve the pre-buffering play/pause intent.
    // Don't clobber an explicit pre-seek resume intent (e.g. the replay path
    // sets wasPlayingBeforeSeek=true before calling seek(0) from the "ended"
    // state — "ended" isn't "playing", so re-deriving here would wrongly reset
    // it to false and seek completion would land paused instead of replaying).
    if (currentState !== "seeking" && !this.wasPlayingBeforeSeek) {
      this.wasPlayingBeforeSeek =
        currentState === "playing" ||
        (currentState === "buffering" && this.wasPlayingBeforeRebuffer);
    }

    // A seek that lands paused keeps the whole window (see holdWindow): the
    // decode from its keyframe to the target reads well past bytes the play
    // that follows will want again. A seek that plays on holds only its
    // keyframe. By intent, not by state, so a run of arrow-key seeks while
    // paused — each arriving in "seeking" — keeps holding too.
    if (this.source instanceof HttpSource) {
      if (!this.wasPlayingBeforeSeek) {
        this.source.holdWindow();
      } else {
        this.source.releaseWindowAfterNextRead();
      }
    }

    // Pause clock so UI time doesn't advance during seek while in loading state
    this.clock.pause();

    // Drop the keyframe-jump offset from the previous seek; it gets
    // re-measured when this seek completes.
    this.seekKeyframeOffset = 0;

    const mySessionId = ++this.seekSessionId;
    // Claim the session: from here until this seek finishes or is superseded,
    // a seek — not a swap, not a prefetch — owns the state machine.
    this._liveSeekSession = mySessionId;
    this._lastSeekAt = performance.now();
    // Retire the ABR's buffer baseline with it. A seek restarts the buffered
    // range at the new playhead, so the next tick would compare a fresh ~2s
    // against the tens of seconds measured before the seek and read a massive
    // DRAIN — the ground-truth signal that the rung can't be sustained. The
    // absolute-low half of that check is already held off for 12s after a seek
    // for exactly this reason; the draining half only had the 4s
    // postSeekSettling window, so scrubbing around dropped the quality a few
    // seconds after the user stopped, on a link that was carrying the rung
    // perfectly. Zeroing it makes the next tick establish a post-seek baseline
    // instead (draining requires a positive previous reading), so a real drain
    // is still caught one tick later. The in-place rendition swap already does
    // the same thing for the same reason.
    this._lastBufferAhead = 0;
    this.stateManager.setState("seeking");
    if (!this._seekIsInternal) this.emit("seeking", seconds);

    // Re-anchor the buffer bar's START to the target NOW, not after the
    // (blocking, potentially multi-second) demuxer.seek below. The scrubber
    // handle jumps to the target the instant the user releases, so leaving the
    // range anchored at the old position strands the buffered segment far
    // behind the handle — or, once the handle passes it, collapses the segment
    // to zero width. Either way the user sees "no buffer". Anchored here the
    // segment sits under the handle and grows forward as bytes actually land.
    // UI-only field (getBufferedRangeStart has no other consumer); the
    // lastBufferedTime monotonic clamp is deliberately left to reset after the
    // demuxer lands so ABR's bufferAhead isn't zeroed mid-seek.
    this.bufferedRangeStart = seconds;

    // CRITICAL: Cancel any running processLoop immediately to prevent WASM async conflicts
    // This must happen before waiting for demuxInFlight, otherwise processLoop may start new async operations
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    try {
      // If demuxing is in flight, wait for it to avoid WASM/Asyncify corruption
      // We loop but also check session ID to abort early if a new seek started
      // Also reset demuxInFlight if this seek is superseded
      if (this.demuxInFlight) {
        let retries = 0;
        while (this.demuxInFlight && retries < 100) {
          if (this.seekSessionId !== mySessionId) {
            // This seek was superseded, reset demuxInFlight to allow new seek to proceed
            this.demuxInFlight = false;
            return this.abandonSupersededSeek(mySessionId);
          }
          await new Promise((r) => setTimeout(r, 10));
          retries++;
        }
      }

      if (this.seekSessionId !== mySessionId)
        return this.abandonSupersededSeek(mySessionId);

      // Discard, do not drain (mpv resets its decoders on seek). Draining a
      // hardware decoder emits every queued frame into a free output surface,
      // and a renderer holding them all — presentation loop stopped for a
      // stall — never frees one: the seek then sat out the flush timeout. The
      // old position's frames are not wanted anyway. The audio decoder needs
      // no such option: it is software (the worker bumps its generation, the
      // WASM flush drops its state), and neither waits on a drain.
      // Flush decoders
      Logger.info(TAG, `seek: flushing video decoder...`);
      await this.videoDecoder.flush({ discard: true });
      // Let go the instant the await returns: a flush is not quick, and a second
      // seek arriving inside that window would otherwise run its own teardown
      // while this one is still parked (the only session check used to be after
      // all of it, so both seeks performed the whole teardown, interleaved).
      if (this.seekSessionId !== mySessionId)
        return this.abandonSupersededSeek(mySessionId);
      Logger.info(TAG, `seek: flushing audio decoder...`);
      await this.audioDecoder.flush();
      if (this.seekSessionId !== mySessionId)
        return this.abandonSupersededSeek(mySessionId);
      // Drop the host subtitle renderer's pending state — its cues are for the
      // position we're leaving; fresh packets stream in after the seek.
      if (this._customSubtitleRenderer) {
        try {
          this._customSubtitleRenderer.clear();
        } catch {
          /* ignore */
        }
      }
      Logger.info(TAG, `seek: decoders flushed`);

      // Clear video frame queue to prevent old frames from being displayed
      if (this.videoRenderer) {
        this.videoRenderer.clearQueue();
      }

      // Flush audio renderer (clears buffers)
      this.audioRenderer.reset();

      if (this.seekSessionId !== mySessionId)
        return this.abandonSupersededSeek(mySessionId);

      // Declare the next landing read as a seek before FFmpeg touches the
      // source. Stateful HTTP sources can then replace the abandoned primary
      // stream immediately instead of spending the first reads on one-off
      // metadata requests while the old position still consumes bandwidth.
      let expectedSeekOffset: number | undefined;
      const mediaSpan = (this.mediaInfo?.duration ?? 0) + this.startTime;
      if (this.fileSize > 0 && mediaSpan > 0) {
        const ratio = Math.max(
          0,
          Math.min(1, (seconds + this.startTime) / mediaSpan),
        );
        expectedSeekOffset = Math.round(this.fileSize * ratio);
      }
      this.source?.hintSeek?.(expectedSeekOffset);

      // Seek relative to start time (time 0 in UI = startTime in media)
      const seekStreamIndex = this.getSeekStreamIndex();
      Logger.info(
        TAG,
        `seek: demuxer.seek(${(seconds + this.startTime).toFixed(2)}, stream=${seekStreamIndex}) starting...`,
      );
      await this.demuxer.seek(seconds + this.startTime, 1, seekStreamIndex);
      // Seek the split (separate-URL) audio demuxer to the same target. Stop the
      // audio loop and let any in-flight read settle first — a concurrent
      // readFrame + seek on the (separate) audio WASM module would corrupt it.
      if (this.audioDemuxer) {
        this.stopAudioLoop();
        let guard = 0;
        while (this.audioDemuxInFlight && guard++ < 200) {
          await new Promise((r) => setTimeout(r, 5));
        }
        try {
          // Seek in the audio source's own PTS baseline (may differ from video's).
          // Retire any filter armed by the PREVIOUS seek — this one will arm its
          // own on completion, and a stale cutoff would silently eat the head of
          // the new position's audio.
          this._splitAudioSkipBefore = -1;
          await this.audioDemuxer.seek(seconds + this._splitAudioStartTime);
        } catch (e) {
          Logger.warn(
            TAG,
            `Split audio seek failed: ${(e as any)?.message ?? e}`,
          );
        }
        this._splitAudioEof = false;
        this.splitAudioQueue.clear();
        // Re-baseline the decode-lead gate to the seek target so it doesn't
        // think audio is already seconds ahead (or behind) the new playhead.
        this._lastSplitAudioPts = seconds;
      }
      Logger.info(TAG, `seek: demuxer.seek done`);
      this.clock.seek(seconds + this.startTime);

      // Reset EOF flag after seek - we're now at a new position
      this.resetEof(seconds + this.startTime);
      // A seek re-aligns the audio source too, so the automatic-recovery budget
      // starts fresh — a failure burst earlier in the file shouldn't leave a
      // later stretch permanently silent.
      this._audioRecoveries = 0;

      // Buffered region restarts from the new position; drop the
      // monotonic clamp so the bar can shrink to reflect the new range,
      // and re-anchor the range's START to the seek target so the bar grows
      // forward from where the user clicked instead of being painted from 0.
      //
      // …unless the seek landed INSIDE what was already buffered. Those bytes
      // are still in the window, and re-deriving the end from the new
      // playhead is a linear byte-to-time guess: on a VBR file (8K AV1 is
      // very VBR) the heavier stretch between the old playhead and the new
      // one makes the guess come out short, and a click near the end of the
      // buffer pulled the bar's end BACK toward the handle. The clamp keeps
      // the end where it was; getBufferedTime still drops it the moment the
      // window itself moves back (see _bufferedLatchBytes).
      const landedInsideBuffer =
        this.lastBufferedTime > 0 && seconds < this.lastBufferedTime;
      if (!landedInsideBuffer) this.lastBufferedTime = 0;
      this.bufferedRangeStart = seconds;

      // Mark that we need to skip to keyframe after seek
      // This prevents decoder errors from non-keyframe packets after seek
      this.seekingToKeyframe = true;
      this.seekingToKeyframeStartTime = performance.now();
      this.seekKeyframeScanned = 0;
      this.seekCraSeen = 0;

      // IMPORTANT: Set seek target time for accurate seek positioning
      // FFmpeg seeks to the nearest keyframe BEFORE the target time,
      // so packets will have timestamps earlier than 'seconds'.
      // We need to skip audio packets before target and decode (but not display) video frames.
      // Normalize target time against startTime offset
      this.seekTargetTime = seconds + this.startTime;
      this._videoResumeTarget = -1; // a real seek supersedes a video-only catch-up
      // …and it supersedes an audio track switch's rebuild: the seek target
      // filters the audio from here on.
      this._audioSwitching = false;
      this._audioStartAlign = false;
      this.waitingForVideoSync = true;
      // Arm the read-ahead cap + hard-timeout watchdog for this seek so a
      // never-arriving first frame can't run away downloading / hang forever.
      this.seekSyncArmedAt = performance.now();
      this.seekDemuxAheadTime = this.seekTargetTime;
      // Tag which seek session armed this completion. notifySeekCompletion
      // bails if a newer seek has since superseded this one, so a stale (e.g.
      // coalesced/rapid-seek) completion can't run the resume/paused branch and
      // consume wasPlayingBeforeSeek out from under the live seek — which
      // intermittently left rapid seeks stuck paused.
      this.seekArmedSessionId = mySessionId;
      // Everything queued was read for the position we just left.
      this.clearPacketQueues();

      // Enable post-seek throttling to prevent overwhelming low-end devices
      // BUT skip throttling when seeking within already-buffered data — the bytes
      // are already local so aggressive bursting won't cause network stalls.
      const seekInBufferedRange = this.isSeekTargetBuffered(seconds);
      if (seekInBufferedRange) {
        this.justSeeked = false;
        Logger.info(
          TAG,
          "Seek within buffered range — skipping post-seek throttle",
        );
      } else {
        this.justSeeked = true;
      }
      this.seekTime = performance.now();

      if (this.seekSessionId !== mySessionId)
        return this.abandonSupersededSeek(mySessionId);

      // Start processing loop to find and decode the target frame/packet.
      // notifySeekCompletion will be called once the first valid frame is received.
      Logger.info(
        TAG,
        `seek: starting processLoop, waitingForVideoSync=${this.waitingForVideoSync}, state=${this.stateManager.getState()}`,
      );
      this.processLoop();

      // Ensure the video renderer loop is running to actually draw frames as they arrive
      if (this.videoRenderer) {
        this.videoRenderer.startPresentationLoop();
      }

      // Safety timeout: force seek completion if frames don't arrive in time.
      // Shorter timeout for buffered seeks since data is already local.
      //
      // The deadline is a floor, not a budget. It used to be a flat 1500ms for
      // a buffered seek, and on 4K AV1 with a long GOP the decoder simply needs
      // longer than that to walk from the keyframe to the target — it was still
      // producing frames when the deadline cut it off. What followed was worse
      // than waiting: a forced completion with no frame lands in buffering,
      // black-frame recovery then seeks AGAIN two seconds further on, and the
      // sound is left a couple of seconds ahead of the picture. Both of the
      // logs this came from show exactly that chain.
      //
      // So the deadline only fires once the decoder has gone QUIET for a
      // moment. Frames still arriving push it out, up to a hard cap, because a
      // decoder producing frames nobody wants forever is its own failure.
      // …and none of that reasoning applies while the tab is hidden, where
      // video decode is skipped on purpose. There the deadline is not waiting
      // for a slow decoder, it is waiting for one that was never asked to run:
      // the frame cannot arrive, so the full 1500ms is spent before the next
      // track can start. Measured on a background auto-advance — "Seek timeout
      // after 1501ms (no frame decoded at all)". Complete on the next tick
      // instead; the audio is the playback there and it is ready now. PiP is
      // excluded: the picture is on screen and IS being decoded.
      const noPictureComing = this.isBackgrounded && !this.isPiPActive;
      const seekTimeoutMs = noPictureComing
        ? 0
        : seekInBufferedRange
          ? 1500
          : 3000;
      const seekStartedAt = performance.now();
      this._seekFrameProgressAt = 0;
      let seekTimeout: ReturnType<typeof setTimeout>;
      const onSeekDeadline = () => {
        if (this.seekSessionId !== mySessionId || !this.waitingForVideoSync)
          return;
        const now = performance.now();
        const sinceFrame = now - this._seekFrameProgressAt;
        const elapsed = now - seekStartedAt;
        if (
          this._seekFrameProgressAt > 0 &&
          sinceFrame < MoviPlayer.SEEK_PROGRESS_IDLE_MS &&
          elapsed < MoviPlayer.SEEK_PROGRESS_CAP_MS
        ) {
          seekTimeout = setTimeout(
            onSeekDeadline,
            MoviPlayer.SEEK_PROGRESS_IDLE_MS - sinceFrame,
          );
          return;
        }
        // The source can die mid-seek — the refusal that latches it may land
        // between seek() and this deadline. Forcing completion then buffers on
        // bytes that will never arrive, so check before pretending the seek
        // merely ran slow.
        const midSeekFailure = this.getSourceFailure();
        if (midSeekFailure && this._seekFrameProgressAt === 0) {
          Logger.error(
            TAG,
            `Seek to ${seconds}s produced no frame because the source failed: ${midSeekFailure.message}`,
          );
          this.waitingForVideoSync = false;
          this.failFatally(midSeekFailure);
          return;
        }
        Logger.warn(
          TAG,
          `Seek timeout after ${Math.round(elapsed)}ms (${
            this._seekFrameProgressAt > 0
              ? `${Math.round(sinceFrame)}ms since the last decoded frame`
              : "no frame decoded at all"
          }), forcing completion at ${seconds}s`,
        );
        this.notifySeekCompletion(seconds + this.startTime, true);
      };
      seekTimeout = setTimeout(onSeekDeadline, seekTimeoutMs);

      // Clear timeout if seek completes or is superseded
      const clearSeekTimeout = () => {
        clearTimeout(seekTimeout);
        this.off("seeked", clearSeekTimeout);
      };
      this.on("seeked", clearSeekTimeout);

      Logger.info(TAG, `Seek initiated to ${seconds}s, waiting for sync...`);
    } catch (error) {
      // Reset seeking flag on error
      this.seekingToKeyframe = false;

      if (this.seekSessionId === mySessionId) {
        this.stateManager.setState("error");
        this.emit("error", error as Error);
      }
      throw error;
    }
  }

  /**
   * A seek that was superseded mid-flight, letting go.
   *
   * If a NEWER SEEK took the session there is nothing to do: it set "seeking"
   * itself and its own completion will resolve it. The other case is the one
   * this exists for. An in-place rendition swap, a subtitle prefetch and the
   * network-recovery re-seek all bump seekSessionId purely to invalidate an
   * in-flight seek — none of them is a seek, and none of them finishes what
   * this one started. What it leaves behind is a player in "seeking" with a
   * paused clock, a stopped split-audio pump, and (past the arming point)
   * waitingForVideoSync raised for a session that can never complete, so every
   * frame that arrives afterwards just re-enters notifySeekCompletion's
   * stale-session branch and bails.
   *
   * Read off the reported session: the network came back, the recovery seek
   * went out, the ABR swap that had been stuck on the dead link completed
   * half a second later and took the session — and the player sat frozen under
   * a spinner, first frame decoded and on screen, until the viewer dragged the
   * scrubber by hand. That manual seek was doing what this does here.
   */
  private abandonSupersededSeek(mySessionId: number): void {
    // Drop our arming first, whoever owns the session now: left set, it is a
    // completion nothing will ever fire.
    if (this.seekArmedSessionId === mySessionId) {
      this.waitingForVideoSync = false;
      this.seekingToKeyframe = false;
    }
    // A backstop, not a race. Whatever took the session gets its chance first:
    // the rendition swap resolves the state as its last act, and the subtitle
    // prefetch and the recovery re-seek run resumes of their own. Only if the
    // player is STILL sitting in "seeking" a moment later did nobody, and only
    // then does this step in.
    setTimeout(() => {
      if (this._destroyed) return;
      this.resumeAfterOrphanedSeek("a non-seek operation");
    }, MoviPlayer.ORPHANED_SEEK_BACKSTOP_MS);
  }

  /**
   * Hand the pipeline back to playback after the seek that owned it was taken
   * over by something that is not a seek. Called from both ends of that race:
   * the seek itself when it notices (abandonSupersededSeek), and the operation
   * that took the session — the in-place rendition swap — when the seek was
   * already past its last check and cannot. Whichever gets there first, the
   * other finds the state resolved and does nothing.
   */
  private resumeAfterOrphanedSeek(takenBy: string): void {
    // A live seek holds the session — it owns the resume.
    if (this._liveSeekSession === this.seekSessionId) return;
    if (!this.stateManager.is("seeking")) return;
    const resume = this.wasPlayingBeforeSeek || this.wasPlayingBeforeRebuffer;
    this.wasPlayingBeforeSeek = false;
    this.wasPlayingBeforeRebuffer = false;
    this.waitingForVideoSync = false;
    this.seekingToKeyframe = false;
    Logger.info(
      TAG,
      `seek superseded by ${takenBy} — resolving the seeking state (${
        resume ? "resuming" : "staying paused"
      })`,
    );
    this.stateManager.setState("paused");
    // The seek stopped the split-audio pump before seeking its demuxer and
    // never reached the line that restarts it.
    this.startAudioLoop();
    this.emit("seeked", Math.max(0, this.clock.getTime() - this.startTime));
    if (resume) {
      void this.play().catch((err) => {
        Logger.error(TAG, "Failed to resume after a superseded seek:", err);
      });
    } else {
      this.startPauseBuffering();
    }
  }

  /**
   * Check if seek target time falls within the already-buffered byte range.
   * Uses linear byte→time estimation (same as getBufferedTime).
   */
  private isSeekTargetBuffered(seekSeconds: number): boolean {
    if (!this.mediaInfo || !this.source || this.fileSize <= 0) return false;
    const duration = this.mediaInfo.duration;
    if (duration <= 0) return false;

    if (this.source instanceof FileSource) return true;

    if (this.source instanceof HttpSource) {
      // Entire file is in memory — every seek is local
      if (this.source.isFullyCached()) return true;

      const bufferStartBytes = this.source.getBufferStart();
      const bufferEndBytes = this.source.getBufferedEnd();
      // Convert seek target to estimated byte offset
      const seekRatio = Math.min(
        1,
        (seekSeconds + this.startTime) / (duration + this.startTime),
      );
      const seekByteEstimate = seekRatio * this.fileSize;
      // Check if estimated byte position is within buffered window (with margin for keyframe before)
      const margin = this.fileSize * 0.02; // 2% margin for keyframe before target
      return (
        seekByteEstimate >= bufferStartBytes - margin &&
        seekByteEstimate <= bufferEndBytes
      );
    }

    // For other sources with getBufferedEnd
    if ("getBufferedEnd" in this.source) {
      const bufferEndBytes = (this.source as any).getBufferedEnd();
      if (bufferEndBytes > 0) {
        const seekRatio = Math.min(
          1,
          (seekSeconds + this.startTime) / (duration + this.startTime),
        );
        const seekByteEstimate = seekRatio * this.fileSize;
        return seekByteEstimate <= bufferEndBytes;
      }
    }

    return false;
  }

  /**
   * Initialize WebGL context for thumbnail rendering
   */

  /**
   * Generates a preview frame for the given time using C-based FFmpeg software decoding.
   * Fast and doesn't block main playback.
   */
  /**
   * Generates a preview frame for the given time using C for demuxing and WebCodecs for decoding.
   */
  async getPreviewFrame(
    time: number,
    view?: VRView | null,
    /**
     * Wait for a generation already in flight instead of returning null.
     *
     * The pipeline is a single decoder, so only one frame can be made at a
     * time, and a second caller is turned away. That is RIGHT for the seek bar:
     * a hover wants the frame for where the pointer is NOW, and a queue of
     * stale positions is worse than a dropped one.
     *
     * It is wrong for anything asking for a fixed list of times. The chapter
     * strip asks for one frame per chapter in a loop, and one preview already
     * running — a keyframe fetch is 2MB, which is seconds on a phone — turned
     * every one of those calls away instantly. Sixteen chapters resolved to
     * null in a few milliseconds and the panel came out empty, with the count
     * printed over it.
     */
    queue = false,
  ): Promise<Blob | null> {
    if (this._audioOnly) return null; // Data-saver: never decode video for previews
    if (!this.previewsAllowed()) return null; // Disabled, or source too large for a 2nd WASM context
    // Adaptive streams: use the manifest's own thumbnail track via Shaka
    // (DASH-IF tiled thumbnails / HLS image playlists). Returns null when the
    // manifest has no thumbnail track, so the preview just stays hidden — far
    // cheaper than the FFmpeg path, which can't byte-range-seek a stream.
    if (this.streamWrapper)
      return (this.streamWrapper as any).getThumbnailBlob?.(time) ?? null;
    if (this.previewInitGaveUp) return null; // Init failed repeatedly — stop retrying (and re-loading WASM)
    // Already made this one (see previewCache). Answered before the in-flight
    // lock below, so a pointer moving back over ground it has already covered
    // gets its frame at once — even while another one is being decoded, which
    // during a scrub is most of the time.
    const key = this.previewKey(time, view);
    if (key !== null) {
      const cached = this.previewCache.get(key);
      if (cached) return cached;
    }
    // Pictures the source came with beat pictures we have to make: a crop out
    // of a mosaic the browser has already fetched, with no seek, no decode and
    // no second WASM module behind it. Answered before the in-flight lock too,
    // because nothing here is in flight — a storyboard has no single decoder
    // to queue behind. A 360 view is the exception: those frames are
    // reprojected per angle, which a flat tile cannot be.
    if (this.storyboardSource && !view) {
      const board = await this.ensureStoryboard();
      const tile = board?.tileAt(time) ?? null;
      if (tile) {
        const blob = await this.cropStoryboardTile(tile);
        if (blob) {
          if (key !== null) this.rememberPreview(key, blob);
          return blob;
        }
      }
    }
    if (this.isPreviewGenerating) {
      if (!queue) return null; // Busy — the hover path would rather have nothing
      // Wait it out, then take our turn. Re-entered rather than looped: by the
      // time this resolves another caller may have started, and the same rule
      // applies to them.
      try {
        await this.previewInFlight;
      } catch {
        /* the other caller's failure is not ours */
      }
      return this.getPreviewFrame(time, view, true);
    }
    // Audio-only sources have no video track to thumbnail. Bail early
    // so a hover on the seek bar doesn't trigger a "Thumbnail bindings
    // or renderer not available" error every time.
    if (!this.trackManager.getActiveVideoTrack()) return null;
    this.isPreviewGenerating = true;
    // The signal waiters block on. Its value is never read — a waiter takes its
    // own turn afterwards rather than sharing this frame, which is a different
    // time anyway.
    let releaseInFlight: () => void = () => {};
    this.previewInFlight = new Promise<Blob | null>((resolve) => {
      releaseInFlight = () => resolve(null);
    });

    try {
      // Initialize thumbnail pipeline if needed
      if (!this.thumbnailBindings) {
        if (this.previewInitPromise) {
          Logger.debug(TAG, "Waiting for existing preview initialization...");
          try {
            await this.previewInitPromise;
          } catch {
            // Init failed, clear promise so retry can work
            this.previewInitPromise = null;
          }
        }
        // If still no bindings (init failed or promise was cleared), retry —
        // but cap attempts so a persistent failure doesn't re-load a fresh WASM
        // module on every seek-bar hover.
        if (!this.thumbnailBindings) {
          if (++this.previewInitAttempts > 3) {
            this.previewInitGaveUp = true;
            Logger.warn(
              TAG,
              "Thumbnail pipeline init failed repeatedly — disabling previews.",
            );
            return null;
          }
          Logger.debug(TAG, "Initializing thumbnail pipeline (retry)...");
          this.previewInitPromise = this.initPreviewPipeline();
          try {
            await this.previewInitPromise;
          } catch {
            this.previewInitPromise = null;
          }
        }
      }

      if (!this.thumbnailBindings || !this.thumbnailRenderer) {
        Logger.warn(TAG, "Thumbnail bindings or renderer not available");
        return null;
      }

      // 360°: reproject the equirect keyframe to the current viewing angle so
      // the seek-bar preview matches what's on screen. Must be set BEFORE the
      // decode/render below — draw() happens synchronously inside the WebCodecs
      // output callback. Null (2D sources) keeps the flat passthrough path.
      this.thumbnailRenderer.setProjection(view ?? null);

      // Read keyframe from thumbnailer
      // Convert time to media time (PTS) by adding startTime
      const packetSize = await this.thumbnailBindings.readKeyframe(time);
      Logger.debug(
        TAG,
        `Thumbnail readKeyframe(${time.toFixed(2)}s): size=${packetSize}`,
      );

      if (packetSize <= 0) {
        // Suppress warning for expected errors like aborted reads (-6) or generic errors during rapid seeking
        if (packetSize !== -6) {
          Logger.warn(TAG, `Thumbnail read failed or empty: ${packetSize}`);
        }
        return null;
      }

      const timestamp = this.previewPacketPts();

      // The seek has just named the keyframe this position belongs to. If that
      // keyframe has already been decoded, this hover's picture is that
      // picture — no decode, no encode, and no guess about GOP length.
      //
      // Only outside precise mode and outside 360: both of those make the
      // frame depend on more than which keyframe it is (the walk forward to
      // the hovered moment, and the angle it is reprojected to).
      if (!this.precisePreviews && !view) {
        const kfKey = this.keyframeKey(timestamp);
        const seen = kfKey === null ? null : this.previewByKeyframe.get(kfKey);
        if (seen) {
          if (key !== null) this.rememberPreview(key, seen);
          return seen;
        }
      }

      const dataPtr = this.thumbnailBindings.getPacketData();

      Logger.debug(
        TAG,
        `Thumbnail packet: pts=${timestamp.toFixed(2)}s, ptr=${dataPtr}, size=${packetSize}`,
      );

      if (!dataPtr) {
        Logger.warn(TAG, "Thumbnail packet data pointer is null");
        return null;
      }

      // Get packet data from the ISOLATED thumbnail module (not main module!)
      const packetData = this.thumbnailBindings.getPacketDataCopy(packetSize);
      if (!packetData) {
        Logger.warn(TAG, "Failed to copy thumbnail packet data");
        return null;
      }

      // 1. Try WebCodecs (Hardware) through Renderer
      let rendered = false;

      // Precise mode walks from the keyframe to the frame the pointer is
      // actually on. The packets are collected FIRST and decoded as one run,
      // because the decoder has to be flushed to get a frame out and a flush
      // ends the run: Chrome answers the next delta with "A key frame is
      // required after configure() or flush()".
      //
      // Unbounded, on purpose. It used to stop at 120 frames or 900ms and
      // keep whatever it had reached, which on the long-GOP sources this mode
      // exists for is the keyframe again — precise previews that quietly
      // stopped being precise exactly where the imprecision was worst. In
      // this mode the answer is the frame under the pointer; the walk ends
      // when it gets there, at EOF, or on a read that fails.
      const run: Array<{ data: Uint8Array; pts: number; key: boolean }> = [
        { data: packetData, pts: timestamp, key: true },
      ];
      if (this.precisePreviews && timestamp < time - 0.02) {
        // Packets arrive in DECODE order, and with B-frames that is not
        // presentation order: a packet whose pts is past the pointer can
        // arrive while the frames AT the pointer are still to come. Measured
        // on a 1080p25 H.264 file with a B-pyramid, four packets in:
        //
        //   pts 0.000  0.040  0.080  0.200  0.120  0.160  0.320  0.240
        //
        // Stopping at the first `pts >= time` therefore stopped at 0.200 for
        // a hover at 0.160 — before 0.120 and 0.160 had been read at all —
        // and the card showed whatever the run happened to contain, which is
        // not the frame the seek then lands on. It is exactly this file's
        // "the preview and the frame disagree", and only this file's, because
        // most encodes deliver pts in order.
        //
        // The reader answers that with the packet's DECODE timestamp, which
        // rises with every packet in the order they arrive. The frame the
        // pointer is on has dts <= its own pts, so reading until dts reaches
        // the pointer is guaranteed to have read it — and everything it
        // references, whose dts is earlier still.
        //
        // A WASM build that predates this reports no dts (NaN). There the
        // walk keeps going for a short window past the first pts that passes
        // the pointer instead: the reorder depth is small (2–4 in practice,
        // this file included) and the frames are small, so a dozen is
        // generous and costs a few milliseconds.
        const REORDER_TAIL = 12;
        let tail = -1;
        for (;;) {
          const size = await this.thumbnailBindings.readNextPacket();
          if (size <= 0) break; // EOF, or a read that went wrong
          const pts = this.previewPacketPts();
          const rawDts = this.thumbnailBindings.getPacketDts?.() ?? Number.NaN;
          const dts = Number.isFinite(rawDts)
            ? rawDts - this.startTime
            : Number.NaN;
          const data = this.thumbnailBindings.getPacketDataCopy(size);
          if (!data) break;
          run.push({ data, pts, key: false });
          if (Number.isFinite(dts)) {
            if (dts >= time) break;
          } else {
            if (pts >= time && tail < 0) tail = 0;
            if (tail >= 0 && ++tail > REORDER_TAIL) break;
          }
        }
      }

      try {
        rendered = await this.thumbnailRenderer!.decodeSequenceAndRender(
          run,
          time,
        );
        if (run.length > 1) {
          Logger.debug(
            TAG,
            `Precise preview: decoded ${run.length} frames from the keyframe at ` +
              `${timestamp.toFixed(2)}s up to ${time.toFixed(2)}s`,
          );
        }
      } catch (e) {
        Logger.warn(TAG, "Thumbnail WebCodecs decode failed", e);
      }

      // The walk left the demuxer holding the LAST packet it read, and the
      // software path below decodes whatever the context is holding. A delta
      // on its own decodes to nothing, so put the keyframe back before handing
      // over — the software fallback then shows the keyframe, which is what it
      // showed before this mode existed.
      if (!rendered && run.length > 1) {
        try {
          await this.thumbnailBindings.readKeyframe(time);
        } catch {
          /* the fallback reports its own failure */
        }
      }

      /* REMOVED OLD LOGIC START
              const videoTrack = this.mediaInfo?.tracks?.find(
                (t) => t.type === "video",
              ) as VideoTrack | undefined;
              const aspect =
                videoTrack?.width && videoTrack?.height
                  ? videoTrack.width / videoTrack.height
                  : 16 / 9;
              const width = 320;
              const height = Math.round(width / aspect);

              const rgba = this.thumbnailBindings!.decodeCurrentPacket(
                width,
                height,
              );

              if (rgba && rgba.length > 0) {
                if (!this.thumbnailCanvas) {
                  if (typeof OffscreenCanvas !== "undefined") {
                    this.thumbnailCanvas = new OffscreenCanvas(width, height);
                  } else {
                    this.thumbnailCanvas = document.createElement("canvas");
                    this.thumbnailCanvas.width = width;
                    this.thumbnailCanvas.height = height;
                  }
                  this.thumbnailContext = this.thumbnailCanvas.getContext(
                    "2d",
                    { alpha: false, willReadFrequently: true },
                  ) as any;
                }

                if (
                  this.thumbnailCanvas!.width !== width ||
                  this.thumbnailCanvas!.height !== height
                ) {
                  this.thumbnailCanvas!.width = width;
                  this.thumbnailCanvas!.height = height;
                }

                // Draw software pixels
                const imageData = new ImageData(
                  new Uint8ClampedArray(rgba),
                  width,
                  height,
                );
                this.thumbnailContext!.putImageData(imageData, 0, 0);

                // Convert to Blob
                if (this.thumbnailCanvas instanceof OffscreenCanvas) {
                  (this.thumbnailCanvas as OffscreenCanvas)
                    .convertToBlob({ type: "image/jpeg", quality: 0.7 })
                    .then((blob) => {
                      // Free C-side RGB buffer after blob creation
                      this.thumbnailBindings?.clearBuffer();
                      resolve(blob);
                    });
                } else {
                  (this.thumbnailCanvas as HTMLCanvasElement).toBlob(
                    (blob) => {
                      // Free C-side RGB buffer after blob creation
                      this.thumbnailBindings?.clearBuffer();
                      resolve(blob);
                    },
                    "image/jpeg",
                    0.7,
                  );
                }
              } else {
                Logger.warn(TAG, "Software fallback returned no data");
                resolve(null);
              }
            } catch (e) {
              Logger.error(TAG, "Software fallback exception", e);
              resolve(null);
            }
          }
        }, 500); // Fast timeout for fallback

        this.thumbnailDecoder?.setOnFrame((frame) => {
          if (resolved) {
            frame.close();
            return;
          }

          Logger.debug(
            TAG,
            `Thumbnail frame received: ${frame.codedWidth}x${frame.codedHeight}`,
          );

          // 3. Render VideoFrame to Canvas using WebGL (with HDR support)
          const videoTrack = this.mediaInfo?.tracks?.find(
            (t) => t.type === "video",
          ) as VideoTrack | undefined;
          const rotation = videoTrack?.rotation || 0;
          const isRotated = rotation % 180 !== 0;

          // Use display dimensions
          const frameW = frame.displayWidth;
          const frameH = frame.displayHeight;
          const canvasW = isRotated ? frameH : frameW;
          const canvasH = isRotated ? frameW : frameH;

          // Create canvas if needed
          if (!this.thumbnailCanvas) {
            if (typeof OffscreenCanvas !== "undefined") {
              this.thumbnailCanvas = new OffscreenCanvas(canvasW, canvasH);
            } else {
              this.thumbnailCanvas = document.createElement("canvas");
              this.thumbnailCanvas.width = canvasW;
              this.thumbnailCanvas.height = canvasH;
            }

            // Try to initialize WebGL with HDR support
            const colorSpace = this.detectThumbnailHDRColorSpace();
            const webglInitialized = this.initThumbnailWebGL(
              this.thumbnailCanvas,
              colorSpace,
            );

            // Fallback to 2D if WebGL fails
            if (!webglInitialized) {
              this.thumbnailContext = this.thumbnailCanvas.getContext("2d", {
                alpha: false,
                willReadFrequently: true,
              }) as any;
            }
          }

          // Resize canvas if dimensions changed
          if (
            this.thumbnailCanvas.width !== canvasW ||
            this.thumbnailCanvas.height !== canvasH
          ) {
            this.thumbnailCanvas.width = canvasW;
            this.thumbnailCanvas.height = canvasH;

            // Re-initialize WebGL if it was being used
            if (this.thumbnailGL) {
              const colorSpace = this.detectThumbnailHDRColorSpace();
              this.initThumbnailWebGL(this.thumbnailCanvas, colorSpace);
            }
          }

          // When rotated, ensure 2D context exists (WebGL path doesn't handle rotation)
          if (rotation !== 0 && !this.thumbnailContext && this.thumbnailCanvas) {
            this.thumbnailContext = this.thumbnailCanvas.getContext("2d", {
              alpha: false,
              willReadFrequently: true,
            }) as any;
          }

          // Render using WebGL if available (skip WebGL when rotated — 2D handles rotation)
          if (
            rotation === 0 &&
            this.thumbnailGL &&
            this.thumbnailGLProgram &&
            this.thumbnailGLTexture &&
            this.thumbnailGLVao
          ) {
            try {
              const gl = this.thumbnailGL;

              // Setup viewport
              gl.viewport(0, 0, canvasW, canvasH);
              gl.clearColor(0, 0, 0, 1);
              gl.clear(gl.COLOR_BUFFER_BIT);

              // Bind program and VAO
              gl.useProgram(this.thumbnailGLProgram);
              gl.bindVertexArray(this.thumbnailGLVao);

              // Upload frame to texture
              gl.activeTexture(gl.TEXTURE0);
              gl.bindTexture(gl.TEXTURE_2D, this.thumbnailGLTexture);
              gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                frame,
              );

              // Draw
              gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

              Logger.debug(
                TAG,
                `Thumbnail rendered with WebGL (HDR: ${this.thumbnailHDREnabled})`,
              );
            } catch (e) {
              Logger.warn(
                TAG,
                "WebGL thumbnail rendering failed, falling back to 2D",
                e,
              );
              // Fallback to 2D rendering
              if (this.thumbnailContext) {
                if (rotation !== 0) {
                  this.thumbnailContext.save();
                  this.thumbnailContext.translate(canvasW / 2, canvasH / 2);
                  this.thumbnailContext.rotate((rotation * Math.PI) / 180);
                  this.thumbnailContext.drawImage(
                    frame,
                    -frameW / 2,
                    -frameH / 2,
                    frameW,
                    frameH,
                  );
                  this.thumbnailContext.restore();
                } else {
                  this.thumbnailContext.drawImage(frame, 0, 0, frameW, frameH);
                }
              }
            }
          } else {
            // Use 2D canvas as fallback
            if (rotation !== 0 && this.thumbnailContext) {
              this.thumbnailContext.save();
              this.thumbnailContext.translate(canvasW / 2, canvasH / 2);
              this.thumbnailContext.rotate((rotation * Math.PI) / 180);
              this.thumbnailContext.drawImage(
                frame,
                -frameW / 2,
                -frameH / 2,
                frameW,
                frameH,
              );
              this.thumbnailContext.restore();
            } else {
              this.thumbnailContext?.drawImage(frame, 0, 0, frameW, frameH);
            }
          }

          frame.close();
          resolved = true;
          clearTimeout(timeout);

          // 4. Convert to Blob
          if (this.thumbnailCanvas instanceof OffscreenCanvas) {
            (this.thumbnailCanvas as OffscreenCanvas)
              .convertToBlob({ type: "image/jpeg", quality: 0.7 })
              .then((blob) => {
                Logger.debug(
                  TAG,
                  `Thumbnail blob created: ${blob?.size} bytes`,
                );
                // Free C-side RGB buffer (if software fallback was used)
                this.thumbnailBindings?.clearBuffer();
                resolve(blob);
              });
          } else {
            (this.thumbnailCanvas as HTMLCanvasElement).toBlob(
              (blob) => {
                Logger.debug(
                  TAG,
                  `Thumbnail blob created: ${blob?.size} bytes`,
                );
                // Free C-side RGB buffer (if software fallback was used)
                this.thumbnailBindings?.clearBuffer();
                resolve(blob);
              },
              "image/jpeg",
              0.7,
            );
          }
        });

      REMOVED OLD LOGIC END */

      // 2. Fallback to Software Decoding
      if (!rendered && this.previewSoftwareTooBig()) {
        this.previewInitGaveUp = true;
        Logger.warn(
          TAG,
          "The hardware preview decoder gave up on a frame too big to decode in " +
            "software without stalling the page — previews off for this source",
        );
        // Not here: this call still holds the bindings, and the finally below
        // reaches for them again. See the WASM use-after-destroy this pipeline
        // has already been bitten by.
        setTimeout(() => this.destroyPreviewPipeline(), 0);
        return null;
      }
      if (!rendered) {
        try {
          // The size the preview is SHOWN at, not the size the source is in.
          // See previewShape — this is where the 8K hang was.
          const videoTrack = this.trackManager.getActiveVideoTrack();
          const shrunk = videoTrack
            ? MoviPlayer.previewShape(videoTrack.width, videoTrack.height)
            : { width: 320, height: 180 };
          const width = shrunk.width;
          const height = shrunk.height;

          const rgba = this.thumbnailBindings!.decodeCurrentPacket(
            width,
            height,
          );
          if (rgba && rgba.length > 0) {
            this.thumbnailRenderer!.render(rgba, width, height);
            this.thumbnailBindings!.clearBuffer();
            rendered = true;
          } else {
            Logger.warn(TAG, "Software thumbnail decoder returned no data");
          }
        } catch (e) {
          Logger.error(TAG, "Software thumbnail fallback exception", e);
        }
      }

      if (rendered) {
        const blob = await this.encodePreviewBlob(
          this.thumbnailRenderer!.getCanvas() as
            OffscreenCanvas | HTMLCanvasElement,
        );
        if (blob) {
          if (key !== null) this.rememberPreview(key, blob);
          // File it under its keyframe too, so the rest of this GOP is free.
          // Precise mode's frames are NOT their keyframe, and a 360 preview is
          // one angle of it, so neither may be reused this way.
          if (!this.precisePreviews && !view) {
            this.rememberKeyframePreview(timestamp, blob);
          }
        }
        return blob;
      }

      return null;
    } catch (e) {
      Logger.warn(TAG, "Preview generation failed", e);
      return null;
    } finally {
      this.isPreviewGenerating = false;
      this.previewInFlight = null;
      releaseInFlight();
      // Let the ThumbnailHttpSource keep its 2MB window for a while yet.
      //
      // Dropping it here — after every single frame — threw away the block the
      // fetch had just paid for, and a scrub is a run of hovers a fraction of
      // a second apart that land INSIDE that same block: measured on a 1.5MB/s
      // link, hovers at 100.8s and 101.6s of an un-downloaded stretch both sat
      // inside 114.9-117.0MB, and the second one re-fetched all 2MB of it
      // (1.65s) because the first one's copy had already been discarded.
      // Clear it once the scrub is over instead.
      this.scheduleThumbBufferClear();
    }
  }

  /**
   * Generate timeline thumbnails at regular intervals
   * @param count Number of thumbnails to generate (default 8)
   * @param onProgress Callback for each generated thumbnail
   * @returns Array of { time, blob } objects
   */
  async generateTimeline(
    count: number = 8,
    onProgress?: (
      index: number,
      total: number,
      blob: Blob,
      time: number,
    ) => void,
  ): Promise<Array<{ time: number; blob: Blob }>> {
    const duration = this.mediaInfo?.duration ?? 0;
    if (duration <= 0) return [];

    const results: Array<{ time: number; blob: Blob }> = [];
    const interval = duration / (count + 1); // Avoid first/last frames

    for (let i = 1; i <= count; i++) {
      const time = interval * i;
      const blob = await this.getPreviewFrame(time);
      if (blob) {
        results.push({ time, blob });
        onProgress?.(i, count, blob, time);
      }
    }

    return results;
  }

  /**
   * The rung to decode seek previews from, or null when there is no ladder to
   * choose from (a single file — there is nothing cheaper to read).
   *
   * Lowest rung that still has some detail: a preview is a ~160px-wide still,
   * so anything above ~240p is pixels nobody sees, paid for in bytes and in
   * decode time on the machine already decoding playback. Below 240p the
   * picture starts to read as mush at 2x DPR, so that is the floor — and if
   * the ladder's smallest rung is lower than that, it is still the cheapest
   * thing on offer and wins by default.
   *
   * …but never ABOVE the rung being played. That floor is about how a preview
   * LOOKS, and it only earns its cost while the picture beside it is better
   * still. A player that opened on 144p did so because the link could not carry
   * more, and pulling a 240p stream alongside it to draw hover stills is the
   * one machine on the one link spending more on the preview than on the video.
   * There the cheapest rung is also the honest one: a still can hardly be
   * blurrier than the picture it is previewing.
   */
  private pickPreviewRendition(): {
    url: string;
    label: string;
    height?: number;
  } | null {
    const rungs = this._dashRenditions.filter((r) => r.url);
    if (rungs.length < 2) return null;
    const bySize = rungs
      .slice()
      .sort((a, b) => (a.height || 0) - (b.height || 0));
    const pick = bySize.find((r) => (r.height || 0) >= 240) || bySize[0];
    // What is actually streaming, by url — the ladder is the only place a
    // rendition's height is recorded.
    const playingHeight =
      this._dashRenditions.find((r) => r.url === this._activeDashRendition)
        ?.height || 0;
    if (playingHeight > 0 && (pick.height || 0) > playingHeight) {
      // Tallest rung that is no taller than the picture. Falls back to the
      // smallest when even that is above it, which is the cheapest read there
      // is and the closest thing to "the same as playback" on offer.
      return (
        [...bySize].reverse().find((r) => (r.height || 0) <= playingHeight) ||
        bySize[0]
      );
    }
    return pick;
  }

  /**
   * Arm the deferred preview warm-up, and keep re-arming it until playback has
   * actually settled.
   *
   * The delay exists to keep the second WASM module + WebCodecs decoder out of
   * the first seconds of PLAYBACK. It used to be a single timer started when
   * load() finished, which quietly assumes play() follows immediately — and on
   * a local file it does not. A FileSource preload reads 20×2MB before play()
   * is even reachable, so on an 11 GB MKV the 12s grace was already spent by
   * the time the first frame went up: the warm-up landed ~4.5s into playback,
   * stood a second isolated WASM instance up, re-opened the same 11 GB file
   * through the same main-thread Asyncify reads, and the audio cushion the
   * (all-software) decoder was holding collapsed into a stall that then made
   * no progress at all for six seconds, until MoviElement's stuck watchdog
   * seeked out of it.
   *
   * So measure the grace against playback, not load, and never start the
   * warm-up while the pipeline is already struggling — buffering and seeking
   * are precisely when the competing decode is least affordable. A source that
   * is simply sitting paused is not competing with anything, so it still warms
   * on schedule; if the user scrubs before any of that, the seek path lazy-inits
   * on demand (initPreviewPipeline is idempotent).
   */
  private schedulePreviewWarm(delayMs: number): void {
    if (this._previewWarmTimer) return;
    if (!this.previewsAllowed()) return;
    // A source with a storyboard has no use for the decode pipeline, and that
    // pipeline is the expensive half of previews: a second WASM module and its
    // own FFmpeg context, warmed in the background for previews that will be
    // crops out of a JPEG. The lazy path is still there if the board turns out
    // not to cover a position.
    if (this.storyboardSource) return;
    this._previewWarmTimer = setTimeout(() => {
      this._previewWarmTimer = null;
      if (
        this._destroyed ||
        this.previewInitPromise ||
        this.thumbnailBindings
      ) {
        return;
      }
      const state = this.stateManager.getState();
      const busy =
        state === "loading" || state === "seeking" || state === "buffering";
      const playbackYoung =
        this._playStartTime > 0 &&
        performance.now() - this._playStartTime <
          MoviPlayer.PREVIEW_WARM_DELAY_MS;
      if (busy || playbackYoung) {
        this.schedulePreviewWarm(MoviPlayer.PREVIEW_WARM_RETRY_MS);
        return;
      }
      this.previewInitPromise = this.initPreviewPipeline().catch((e) => {
        Logger.warn(TAG, "Preview pipeline init failed (non-critical)", e);
        this.previewInitPromise = null;
      });
    }, delayMs);
  }

  /** Goes at the preview rung before previews are drawn from the picture's own
   *  file instead — see initPreviewPipeline. */
  private static readonly PREVIEW_RUNG_TRIES = 2;
  private _previewRungFailures = 0;

  /**
   * Build the preview pipeline — off the small rung when there is one, and off
   * the rendition being played when that rung will not open.
   *
   * The rung is a separate file, and a separate file can fail where the one
   * playing does not: another host (a ladder's small rungs are often on a
   * second CDN), a header that host never sends, a link that has expired. The
   * rung was the only thing ever tried, so every retry — three, from the hover
   * path — went at the same failing file, and then previews were switched off
   * for the rest of the video while the picture itself played on fine. So: the
   * rung twice, and then the file already on screen, which is known to open.
   */
  private async initPreviewPipeline(): Promise<void> {
    const gen = this._previewGeneration;
    const rung =
      this._previewRungFailures < MoviPlayer.PREVIEW_RUNG_TRIES
        ? this.pickPreviewRendition()
        : null;
    try {
      await this.buildPreviewPipeline(rung);
    } catch (e) {
      if (!rung) throw e;
      this.abandonPreviewBuild();
      const failures = ++this._previewRungFailures;
      Logger.warn(
        TAG,
        `Preview rung ${rung.label || rung.height + "p"} did not open (${failures}/${MoviPlayer.PREVIEW_RUNG_TRIES})` +
          (failures >= MoviPlayer.PREVIEW_RUNG_TRIES
            ? " — previews come from the playing rendition"
            : ""),
        e,
      );
      if (this._destroyed || gen !== this._previewGeneration) return;
      await this.initPreviewPipeline();
    }
  }

  /** What a build that threw left half-made: nothing of it is published. */
  private abandonPreviewBuild(): void {
    if (this.thumbnailBindingsPending) {
      try {
        this.thumbnailBindingsPending.destroy();
      } catch {}
      this.thumbnailBindingsPending = null;
    }
    if (this.thumbnailRenderer && !this.thumbnailBindings) {
      try {
        this.thumbnailRenderer.destroy();
      } catch {}
      this.thumbnailRenderer = null;
    }
    if (this.thumbnailSource && this.thumbnailSource !== this.source) {
      try {
        this.thumbnailSource.close();
      } catch {}
    }
    this.thumbnailSource = null;
    this.releaseSharedThumbModule();
  }

  private async buildPreviewPipeline(
    previewRung: { url: string; label: string; height?: number } | null,
  ) {
    if (this.thumbnailBindings) return; // Already initialized
    // Everything below allocates — an isolated WASM module and FFmpeg context,
    // a WebCodecs decoder, a WebGL context — and it does so across long awaits
    // (module load, network open). destroy() or a load() of a new source can
    // land inside any of them, and both run destroyPreviewPipeline() before
    // this returns: whatever is built after that point is built onto a
    // pipeline nobody owns and nobody will release. Stop at each await.
    const gen = this._previewGeneration;
    const superseded = () => this._destroyed || gen !== this._previewGeneration;

    Logger.debug(TAG, "Initializing thumbnail pipeline...");
    // Use a NEW isolated WASM module instance for thumbnails
    // This prevents onReadRequest handler conflicts with main playback
    let module: Awaited<ReturnType<typeof loadWasmModuleNew>>;
    if (sharedThumbnailModule && !sharedThumbnailModuleInUse) {
      module = sharedThumbnailModule;
      sharedThumbnailModuleInUse = true;
      this._usingSharedThumbModule = true;
      Logger.debug(TAG, "Reusing the shared thumbnail WASM module");
    } else {
      module = await loadWasmModuleNew({
        wasmBinary: this.config.wasmBinary,
      });
      if (!sharedThumbnailModule) {
        // First one becomes the shared instance every later video reuses.
        sharedThumbnailModule = module;
        sharedThumbnailModuleInUse = true;
        this._usingSharedThumbModule = true;
      }
    }
    Logger.debug(TAG, "Thumbnail WASM module ready");
    if (superseded()) {
      this.releaseSharedThumbModule();
      return;
    }

    // Encrypted playback: reuse the main EncryptedHttpSource for thumbnails.
    // A 2nd EncryptedHttpSource spins up an independent ECDH handshake +
    // token-signed GETs, which the server treats as concurrent sessions;
    // observed server behavior is 206 responses with truncated/empty
    // bodies (seen as "Stream ended before block N" errors) when both
    // instances fetch overlapping ranges. Sharing the main source also
    // makes thumbnail reads free once the block is in the main source's
    // block cache — no extra network at all for near-playhead previews.
    const sourceConfig = this.config.source;
    const isEncrypted =
      sourceConfig &&
      typeof sourceConfig !== "string" &&
      (sourceConfig as any).type === "encrypted";
    // The rung would not open, so this is the fallback — and on a ladder the
    // file on screen is the ACTIVE rendition, not config.source: an in-place
    // switch changes the first and never the second. No borrow either way,
    // for the same reason as the rung branch below.
    const playingRendition =
      !previewRung && this._previewRungFailures >= MoviPlayer.PREVIEW_RUNG_TRIES
        ? this._activeDashRendition
        : "";
    // HLS demuxer fallback: the media is a concatenated segment stream, not the
    // .m3u8 playlist in config.source — opening that URL as media would fail.
    // Reuse the SegmentStreamSource: its read() is offset-explicit (safe to
    // share with the thumbnail demuxer) and its segment cache is shared too.
    if (this.source instanceof SegmentStreamSource) {
      this.thumbnailSource = this.source;
    }
    // Custom user-supplied adapter — we can't safely spin up a second reader
    // (we don't know the underlying protocol), so reuse the main source.
    // The user's read() must tolerate interleaved offsets in this case.
    else if (this.config.sourceAdapter && this.source) {
      this.thumbnailSource = this.source;
    } else if (isEncrypted && this.source) {
      this.thumbnailSource = this.source;
    } else if (playingRendition) {
      Logger.debug(
        TAG,
        "Thumbnail source: the playing rendition (preview rung failed)",
      );
      this.thumbnailSource = new ThumbnailHttpSource(
        playingRendition,
        (sourceConfig &&
        typeof sourceConfig !== "string" &&
        "headers" in sourceConfig
          ? sourceConfig.headers
          : undefined) || {},
        null,
      );
    } else if (previewRung) {
      // A ladder is available, so preview off a SMALL rung instead of whatever
      // the player is streaming. A hover thumbnail is ~160 CSS px wide; pulling
      // and decoding a 4K keyframe to fill it costs ~50x the pixels it can
      // show, and every one of those decodes lands on the same machine that is
      // busy decoding playback. The rung is also a fraction of the bytes, so
      // the seek-scrub reads stop competing with the playback stream.
      //
      // No borrow source here: a different rendition is a different file, so
      // the main source's cached bytes are not ours to read.
      Logger.debug(
        TAG,
        `Thumbnail source: using ${previewRung.label || previewRung.height + "p"} rung instead of the playing rendition`,
      );
      this.thumbnailSource = new ThumbnailHttpSource(
        previewRung.url,
        (sourceConfig &&
        typeof sourceConfig !== "string" &&
        "headers" in sourceConfig
          ? sourceConfig.headers
          : undefined) || {},
        null,
      );
    } else {
      // Plain HTTP / URL sources: use a dedicated ThumbnailHttpSource that
      // borrows (read-only) from the main source's metadata LRU +
      // sliding-window buffer, only fetching on miss.
      const borrowSource =
        this.source &&
        typeof (this.source as any).peekMetadata === "function" &&
        typeof (this.source as any).peekRange === "function"
          ? (this.source as any)
          : null;
      if (typeof sourceConfig === "string") {
        this.thumbnailSource = new ThumbnailHttpSource(
          sourceConfig,
          {},
          borrowSource,
        );
      } else if (sourceConfig && "url" in sourceConfig && sourceConfig.url) {
        this.thumbnailSource = new ThumbnailHttpSource(
          sourceConfig.url,
          sourceConfig.headers || {},
          borrowSource,
        );
      } else if (sourceConfig) {
        // File source. A second FileSource over the same File, sharing the main
        // one's LRU — but explicitly a SECONDARY reader: no preload sweep of its
        // own, and no cache-clearing on close. Both of those were costing a
        // whole extra read of the file, which is free on an SSD and very much
        // not on a Drive-backed virtual file. See FileSource.markSecondary.
        const thumbSource = await this.createSource(sourceConfig);
        if (thumbSource instanceof FileSource) thumbSource.markSecondary();
        this.thumbnailSource = thumbSource;
      } else if (this.source) {
        // No SourceConfig (custom adapter path) — fall back to main source.
        this.thumbnailSource = this.source;
      } else {
        throw new Error("No source available for thumbnail pipeline");
      }
      // Reuse the size the main source already resolved — a dedicated
      // ThumbnailHttpSource can't probe it on a non-range server (HEAD strips
      // Content-Length, the 200 GET may be chunked), which used to fail init.
      if (
        this.fileSize > 0 &&
        this.thumbnailSource &&
        "seedSize" in this.thumbnailSource &&
        typeof (this.thumbnailSource as { seedSize?: unknown }).seedSize ===
          "function"
      ) {
        (this.thumbnailSource as { seedSize: (n: number) => void }).seedSize(
          this.fileSize,
        );
      }
    }

    const fileSize = await this.thumbnailSource.getSize();
    Logger.debug(TAG, `Thumbnail source created, file size: ${fileSize}`);
    // Sizing a fresh reader is a network round trip of its own.
    if (superseded()) {
      if (this.thumbnailSource !== this.source) {
        try {
          this.thumbnailSource.close();
        } catch {}
      }
      this.thumbnailSource = null;
      this.releaseSharedThumbModule();
      return;
    }

    // Create thumbnail bindings
    // Held locally until the pipeline can actually make a frame.
    //
    // Published here, it read as "initialised" from the moment it existed —
    // and it exists two awaits before it is usable (create, then open, both
    // over the network). A preview asked for inside that window skipped the
    // wait-for-init branch, because bindings were set, and fell through to the
    // availability check, where the renderer was still missing: "Thumbnail
    // bindings or renderer not available", returned null, 182 times in one
    // session. The chapter strip asks for one frame per chapter in a tight
    // loop, so a panel opened in that window came out completely empty.
    const bindings = new ThumbnailBindings(module);
    this.thumbnailBindingsPending = bindings;

    const dataAdapter = {
      read: async (offset: number, size: number): Promise<Uint8Array> => {
        if (!this.thumbnailSource) throw new Error("No thumbnail source");
        const buffer = await this.thumbnailSource.read(offset, size);
        return new Uint8Array(buffer);
      },
      getSize: async (): Promise<number> => {
        if (!this.thumbnailSource) throw new Error("No thumbnail source");
        return this.thumbnailSource.getSize();
      },
    };
    bindings.setDataSource(dataAdapter);

    const created = await bindings.create(fileSize);
    Logger.debug(TAG, `Thumbnail context create result: ${created}`);
    if (!created) throw new Error("Failed to create thumbnail context");

    const opened = await bindings.open();
    Logger.debug(TAG, `Thumbnail context open result: ${opened}`);
    if (!opened) throw new Error("Failed to open thumbnail media");

    // Opening reads over the network — the same race as above, and this side
    // of it holds an FFmpeg context. Hand it back before returning.
    if (superseded()) {
      try {
        bindings.destroy();
      } catch {}
      this.thumbnailBindingsPending = null;
      this.releaseSharedThumbModule();
      return;
    }

    // Initialize Renderer
    this.thumbnailRenderer = new ThumbnailRenderer();

    let videoTrack = this.trackManager.getActiveVideoTrack();
    if (!videoTrack) {
      const tracks = this.trackManager.getVideoTracks();
      if (tracks.length > 0) videoTrack = tracks[0];
    }

    // Reading a different rendition means the main track describes the wrong
    // file — different dimensions, possibly a different codec, and certainly
    // different extradata. Take the picture's shape from the preview demuxer's
    // OWN stream info in that case; the main track stays the fallback for the
    // ordinary same-file path (and if the preview's info is unreadable).
    const previewInfo = previewRung ? bindings.getStreamInfo() : null;
    const shape = previewInfo?.width
      ? {
          width: previewInfo.width,
          height: previewInfo.height,
          rotation: previewInfo.rotation || 0,
          colorPrimaries: previewInfo.colorPrimaries,
          colorTransfer: previewInfo.colorTransfer,
          codec: previewInfo.codecName,
          profile: previewInfo.profile,
          level: previewInfo.level,
          extradata: bindings.getExtradata(),
        }
      : videoTrack
        ? {
            width: videoTrack.width,
            height: videoTrack.height,
            rotation: videoTrack.rotation || 0,
            colorPrimaries: videoTrack.colorPrimaries,
            colorTransfer: videoTrack.colorTransfer,
            codec: videoTrack.codec,
            profile: videoTrack.profile,
            level: videoTrack.level,
            extradata: this.demuxer?.getExtradata(videoTrack.id) ?? null,
          }
        : null;

    if (shape) {
      // Initialize renderer dimensions and HDR settings
      // The canvas is a preview surface, so it is preview-sized: a WebGL
      // surface at 8K is 132MB to allocate and to read back, for a picture
      // that is 480px wide. The draw scales the frame on the GPU on its way
      // in, which is cheaper than doing it afterwards as well.
      const canvasShape = MoviPlayer.previewShape(shape.width, shape.height);
      this.thumbnailRenderer.initialize({
        width: canvasShape.width,
        height: canvasShape.height,
        rotation: shape.rotation,
        colorPrimaries: shape.colorPrimaries,
        colorTransfer: shape.colorTransfer,
        hdrEnabled: this.thumbnailHDREnabled,
      });

      // Configure internal VideoDecoder
      const extradata = shape.extradata;

      Logger.debug(
        TAG,
        `Configuring thumbnail decoder with track: ${shape.codec} ${shape.width}x${shape.height}, extradata: ${extradata ? extradata.length : 0} bytes`,
      );
      const configured = await this.thumbnailRenderer.configureDecoder(
        shape.codec,
        extradata, // can be null
        shape.width,
        shape.height,
        shape.profile,
        shape.level,
      );

      if (!configured) {
        // The software fallback decodes the frame WHOLE, in WASM, on this
        // thread — the scaler can hand back a small picture but the decode
        // itself is the source's own size. At 8K that is most of a second per
        // hover with everything else stopped, which is the seek bar hanging
        // the player while the keyboard seeks fine. Past the budget there is
        // no version of this worth having: no preview is better than a frozen
        // bar, and the bar still seeks.
        if (
          shape.width * shape.height >
          MoviPlayer.PREVIEW_SOFTWARE_MAX_PIXELS
        ) {
          this.previewInitGaveUp = true;
          Logger.warn(
            TAG,
            `No hardware path for ${shape.codec} at ${shape.width}x${shape.height}, ` +
              "and software decode at that size would stall the page — previews off for this source",
          );
          // Everything this got as far as building — the second WASM context,
          // its own reader, the WebGL surface — is for a pipeline that is not
          // going to be used. It is never published, so teardown is the only
          // thing that can still reach it.
          this.destroyPreviewPipeline();
          return;
        }
        Logger.warn(
          TAG,
          "Failed to configure thumbnail VideoDecoder, will use software fallback",
        );
      }
    } else {
      Logger.warn(TAG, "No video track found for thumbnail renderer");
    }

    // Published last, and only now: from here a caller that finds bindings set
    // can rely on there being a renderer behind them. Until this line it is
    // reachable only through thumbnailBindingsPending, which is teardown's
    // business and nobody else's.
    this.thumbnailBindings = bindings;
    this.thumbnailBindingsPending = null;

    Logger.debug(TAG, "Thumbnail pipeline initialized successfully");
  }

  /** Hand the shared thumbnail module back, if this player holds it. */
  private releaseSharedThumbModule(): void {
    if (!this._usingSharedThumbModule) return;
    this._usingSharedThumbModule = false;
    sharedThumbnailModuleInUse = false;
    // A read or seek left in flight belongs to the context being torn down;
    // the next video's bindings must not inherit it.
    try {
      const m = sharedThumbnailModule as unknown as {
        _pendingSeek?: unknown;
      } | null;
      if (m && m._pendingSeek) m._pendingSeek = null;
    } catch {
      /* nothing to clear */
    }
  }

  /**
   * Is the source playing without a duration anybody could find?
   *
   * True only once the media is actually open — during a load the duration is
   * legitimately unknown and the UI should stay blank, not pretend the file is
   * endless. Drives the seek bar's live-edge rendering and hides the 0:00 that
   * would otherwise sit where a total ought to be.
   */
  hasUnknownDuration(): boolean {
    if (!this.mediaInfo) return false;
    if (this.mediaInfo.duration > 0) return false;
    const state = this.stateManager.getState();
    return state !== "idle" && state !== "loading" && state !== "error";
  }

  /**
   * Try once more for a missing duration, with playback already running.
   *
   * The scan inside open() has a load waiting on it, so it is capped in the
   * single seconds and gives up having read a few percent of anything but a
   * small file — a 291MB Matroska got 14MB in before its second was up. Off
   * the load path there is nothing to hold up, so the same pass can be given
   * the time it actually needs.
   *
   * It cannot run on the playing context: movi_scan_duration reads that
   * context to EOF and then seeks it back, which would take every packet out
   * of the demuxer's mouth. So it opens its own, over its own reader, exactly
   * as the preview pipeline does — and for the same reason.
   */
  private scheduleDurationRescan(): void {
    if (this._durationRescanDone || this._durationRescanTimer) return;
    if (this._destroyed || this.streamWrapper) return;
    // No SourceConfig means a caller-supplied adapter: we don't know how to
    // build a second reader for it, and sharing the one playback is using
    // would interleave a whole-file sweep into its reads.
    if (!this.config.source) return;

    this._durationRescanTimer = setTimeout(() => {
      this._durationRescanTimer = null;
      void this.rescanDurationInBackground();
    }, MoviPlayer.DURATION_RESCAN_DELAY_MS);
  }

  private async rescanDurationInBackground(): Promise<void> {
    if (this._durationRescanDone || this._destroyed) return;
    this._durationRescanDone = true; // one attempt per source, win or lose

    const sourceConfig = this.config.source;
    if (!sourceConfig || !this.source) return;

    const budgetMs = Demuxer.durationRescanBudgetMs(
      this.source.getKey(),
      this.fileSize,
    );
    if (budgetMs === null) {
      Logger.debug(TAG, "Duration rescan: source isn't worth a full pass");
      return;
    }

    // The generation this attempt belongs to. Everything below is a long await
    // over a reader we own, and a load() of a new source (or destroy()) can
    // land inside any of them — the result would then be the OLD file's
    // duration, published over the new one's.
    const gen = this._previewGeneration;
    const superseded = () => this._destroyed || gen !== this._previewGeneration;

    let scanSource: SourceAdapter | null = null;
    let bindings: WasmBindings | null = null;
    try {
      const cfg =
        typeof sourceConfig === "string"
          ? ({ type: "url", url: sourceConfig } as SourceConfig)
          : sourceConfig;
      scanSource = await this.createSource(cfg);
      // A second reader over the same File: no preload sweep of its own, and
      // no cache-clearing on close. See FileSource.markSecondary.
      if (scanSource instanceof FileSource) scanSource.markSecondary();
      if (superseded()) return;

      const module = await loadWasmModuleNew({
        wasmBinary: this.config.wasmBinary,
      });
      if (superseded()) return;

      bindings = new WasmBindings(module);
      if (!bindings.create()) throw new Error("Failed to create scan context");
      bindings.setDataSource({
        read: async (offset: number, size: number): Promise<Uint8Array> =>
          new Uint8Array(await scanSource!.read(offset, size)),
        getSize: async (): Promise<number> => scanSource!.getSize(),
      });
      await bindings.open();
      if (superseded()) return;

      Logger.info(
        TAG,
        `Duration rescan: scanning in the background (budget ${Math.round(budgetMs / 1000)}s)`,
      );
      const started = performance.now();
      const scanned = await bindings.scanDuration(budgetMs);
      const elapsed = Math.round(performance.now() - started);
      if (superseded()) return;

      if (!(scanned > 0)) {
        Logger.warn(TAG, `Duration rescan found nothing usable (${elapsed}ms)`);
        return;
      }
      if (!this.mediaInfo || this.mediaInfo.duration > 0) return;

      Logger.info(TAG, `Duration rescan recovered ${scanned}s (${elapsed}ms)`);
      this.mediaInfo.duration = scanned;
      this.clock.setDuration(scanned + this.startTime);
      this.emit("durationChange", scanned);
    } catch (e) {
      Logger.warn(TAG, "Duration rescan failed (non-critical)", e);
    } finally {
      try {
        bindings?.destroy();
      } catch {}
      try {
        scanSource?.close();
      } catch {}
    }
  }

  /**
   * Drop the preview reader's fetch window once hovering has stopped, so the
   * 2MB it holds isn't kept for the rest of the session — but not between two
   * hovers of the same scrub, which is what it exists for.
   */
  private scheduleThumbBufferClear(): void {
    if (this._thumbBufferIdleTimer) clearTimeout(this._thumbBufferIdleTimer);
    this._thumbBufferIdleTimer = setTimeout(() => {
      this._thumbBufferIdleTimer = null;
      const src = this.thumbnailSource as { clearBuffer?: () => void } | null;
      if (src && typeof src.clearBuffer === "function") src.clearBuffer();
    }, MoviPlayer.THUMB_BUFFER_IDLE_MS);
  }

  /**
   * The seek bar is done asking: stop downloading the rest of the preview
   * reader's fetch window, keeping the bytes that have arrived.
   *
   * The window keeps streaming after its frame is made so a scrub's next hover
   * finds its bytes already here — worth it only while the pointer is still
   * travelling. The caller is the one that knows: the player sees requests, and
   * on a fetching source the seek bar deliberately holds those back for up to
   * 1.5s mid-drag, so a quiet spell here is not a pointer at rest. Ignored
   * while a frame is being made; its own reads need the window.
   */
  stopPreviewFill(): void {
    if (this.isPreviewGenerating) return;
    const src = this.thumbnailSource as { stopFill?: () => void } | null;
    src?.stopFill?.();
  }

  private destroyPreviewPipeline() {
    this._previewGeneration++;
    if (this._durationRescanTimer) {
      clearTimeout(this._durationRescanTimer);
      this._durationRescanTimer = null;
    }
    if (this._thumbBufferIdleTimer) {
      clearTimeout(this._thumbBufferIdleTimer);
      this._thumbBufferIdleTimer = null;
    }
    this.releaseSharedThumbModule();
    // A build that was still in flight holds a context too, and an init that
    // threw between creating it and publishing it leaves it here.
    if (this.thumbnailBindingsPending) {
      try {
        this.thumbnailBindingsPending.destroy();
      } catch {}
      this.thumbnailBindingsPending = null;
    }
    if (this.thumbnailBindings) {
      try {
        this.thumbnailBindings.destroy();
      } catch {}
    }

    if (this.thumbnailRenderer) {
      this.thumbnailRenderer.destroy();
      this.thumbnailRenderer = null;
    }

    // Only a reader of our own. The encrypted / HLS / custom-adapter paths
    // deliberately share the MAIN source, and closing that here would pull it
    // out from under playback (or, from destroy(), from the close that follows).
    if (this.thumbnailSource && this.thumbnailSource !== this.source) {
      try {
        this.thumbnailSource.close();
      } catch {}
    }
    this.thumbnailSource = null;
    this.previewInitPromise = null;
    // A new pipeline is a new chance for the rung — the next source's ladder
    // is somebody else's files.
    this._previewRungFailures = 0;
  }

  /**
   * Get all tracks
   */
  getTracks(): Track[] {
    return this.trackManager.getTracks();
  }

  /**
   * DASH-fallback video Representations for the demuxer-mode quality menu
   * (best-first), and the one currently playing. Empty unless force-demuxing.
   */
  getDashRenditions(): {
    url: string;
    label: string;
    id: string;
    bandwidth?: number;
  }[] {
    return this._dashRenditions;
  }
  getActiveDashRendition(): string {
    return this._activeDashRendition;
  }

  /**
   * Externally supply the video renditions (with bitrate) for the ABR — used by
   * the premuxed multi-source path, which owns the quality list in the element.
   *
   * `activeUrl` seeds which rendition is *currently* playing. This matters: the
   * ABR compares its pick against `_activeDashRendition`, and until a swap sets
   * that it's "". With it empty the ABR can't recognise the file already on
   * screen, so it "switches" to the identical rendition — a pointless in-place
   * swap that reseeks the video and desyncs it against the still-running split
   * audio. Seed it once (only when unset, so a real swap's value isn't clobbered
   * by a later menu re-render passing the unchanged element src).
   */
  setDashRenditions(
    renditions: {
      url: string;
      label: string;
      id: string;
      bandwidth?: number;
      height?: number;
      codec?: string;
    }[],
    activeUrl?: string,
  ): void {
    // NOTE: the device decode cap is deliberately NOT reset here — it lives at
    // module level and must persist across sources (a device that can't decode
    // 8K can't decode it for the next video either).
    this._dashRenditions = renditions;
    // Ask the device about the big rungs now, while nothing is riding on the
    // answer, so the ABR never has to learn a ceiling by stuttering into it.
    void this.screenRungsForDecodeCapability(renditions);
    if (activeUrl && !this._activeDashRendition) {
      this._activeDashRendition = activeUrl;
    }
  }

  /** Current network throughput estimate (bytes/s). Hosts can persist this and
   *  re-seed the next video (a fresh player) so the ABR sizes the starting
   *  quality from a real number instead of climbing up from a cold estimate. */
  getNetworkThroughputBps(): number {
    return this._lastThroughputBps;
  }

  /** Seed the throughput estimate (bytes/s) before playback measures its own.
   *  Only applied while no live measurement exists, so a real sample always
   *  wins. Lets a fresh video pick the right rung on the first ABR tick. */
  seedNetworkThroughputBps(bps: number): void {
    if (bps > 0 && this._lastThroughputBps <= 0) {
      this._lastThroughputBps = bps;
    }
  }

  /**
   * Fold the source's live download speed into the throughput estimate. Meant to
   * be called frequently (every UI tick, ~250ms) — the ABR's own 4s tick is too
   * coarse to catch a small file that finishes downloading in under a second, so
   * a fully-cached video would otherwise leave the estimate stale/low and Auto,
   * thinking the link is slow, would sit stuck at the low starting rung.
   */
  sampleThroughput(): void {
    // `this.source` is null whenever a wrapper owns the networking (Shaka /
    // HLS / DASH), and it is null again after unload. The `?.()` below only
    // guards a MISSING METHOD, not a missing source — so the UI tick, which
    // calls this every ~250ms regardless of which pipeline is playing, threw
    // "Cannot read properties of null (reading 'getNetworkStats')" on every
    // HLS playback. Same shape at the three ABR call sites.
    const s = (
      this.source as {
        getNetworkStats?: () => { currentSpeed: number; lastSpeed?: number };
      } | null
    )?.getNetworkStats?.();
    const raw = s?.lastSpeed ?? s?.currentSpeed ?? 0;
    if (raw > 0) {
      this._lastThroughputBps =
        this._lastThroughputBps > 0
          ? this._lastThroughputBps * 0.7 + raw * 0.3
          : raw;
    }
  }

  /**
   * Get video tracks
   */
  getVideoTracks(): VideoTrack[] {
    return this.trackManager.getVideoTracks();
  }

  /**
   * Get audio tracks
   */
  getAudioTracks(): AudioTrack[] {
    return this.trackManager.getAudioTracks();
  }

  /**
   * Get subtitle tracks
   */
  getSubtitleTracks(): SubtitleTrack[] {
    return this.trackManager.getSubtitleTracks();
  }

  /**
   * Select audio track
   */
  selectAudioTrack(trackId: number): boolean {
    return this.trackManager.selectAudioTrack(trackId);
    // Note: change event listeners above will reconfigure decoder
  }

  /**
   * Route audio output to a specific device (AudioContext.setSinkId).
   * "" → system default. Returns false when unsupported / device gone.
   */
  setAudioOutputDevice(deviceId: string): Promise<boolean> {
    return this.audioRenderer.setSinkId(deviceId);
  }

  /** Current audio output device id ("" = system default). */
  getAudioOutputDevice(): string {
    return this.audioRenderer.getSinkId();
  }

  /**
   * Select subtitle track
   */
  async selectSubtitleTrack(trackId: number | null): Promise<boolean> {
    Logger.info(TAG, `selectSubtitleTrack called: trackId=${trackId}`);
    const result = this.trackManager.selectSubtitleTrack(trackId);
    Logger.debug(TAG, `TrackManager.selectSubtitleTrack returned: ${result}`);

    // Track changed — invalidate any prefetched cue list so the next
    // setSubtitleDelay re-scans the new stream.
    if (this.prefetchedSubtitleStream !== trackId) {
      this.prefetchedSubtitleStream = null;
    }

    // Clear subtitles when track is deselected
    if (trackId === null) {
      Logger.info(TAG, "Disabling subtitles");
      if (this.videoRenderer) {
        this.videoRenderer.clearSubtitles();
        Logger.debug(TAG, "Cleared subtitles from video renderer");
      }
      if (this.subtitleDecoder) {
        this.subtitleDecoder.close();
        Logger.debug(TAG, "Closed subtitle decoder");
      }
      if (this._customSubtitleRenderer) {
        try {
          this._customSubtitleRenderer.clear();
        } catch {
          /* ignore */
        }
      }
      this._releaseCustomRenderer();
      return result;
    }

    // A host renderer owns subtitles — reset it and configure for the new track,
    // skipping the internal decoder path entirely.
    const picked = this.trackManager.getActiveSubtitleTrack();
    if (this._customRendererFor(picked) && !this.streamWrapper) {
      try {
        this._customSubtitleRenderer!.clear();
      } catch {
        /* ignore */
      }
      await this._configureCustomSubtitleRenderer();
      return result;
    }
    // The renderer was showing the track before this one (an ASS track, and
    // now it is an SRT one that stays with the internal decoder): stop it.
    this._releaseCustomRenderer();

    // Adaptive streams: Shaka already applied the text-track selection (via the
    // trackManager → streamWrapper wiring) and renders cues itself. There's no
    // FFmpeg demuxer / subtitle decoder to configure, so stop here.
    if (this.streamWrapper) {
      return result;
    }

    // Configure decoder for new subtitle track
    if (this.demuxer && this.subtitleDecoder) {
      const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
      Logger.info(
        TAG,
        `Configuring subtitle decoder for track: id=${subtitleTrack?.id}, codec=${subtitleTrack?.codec}, type=${subtitleTrack?.subtitleType}`,
      );

      if (subtitleTrack) {
        // Close previous decoder before configuring new one (helps with track switching)
        Logger.debug(
          TAG,
          "Closing previous subtitle decoder before switching tracks",
        );
        this.subtitleDecoder.close();

        // Set bindings first (required for configure)
        const bindings = this.demuxer.getBindings();
        if (bindings) {
          Logger.debug(TAG, "Setting bindings on subtitle decoder");
          this.subtitleDecoder.setBindings(bindings, false);
        } else {
          Logger.warn(TAG, "No bindings available from demuxer!");
        }

        const extradata =
          this.demuxer.getExtradata(subtitleTrack.id) ?? undefined;
        Logger.debug(
          TAG,
          `Configuring subtitle decoder: extradata=${extradata?.length || 0} bytes`,
        );
        const configured = await this.subtitleDecoder.configure(
          subtitleTrack,
          extradata,
        );
        Logger.info(
          TAG,
          `Subtitle decoder configuration result: ${configured}`,
        );

        if (configured) {
          // Set up subtitle cue callback
          Logger.debug(TAG, "Setting up subtitle cue callback");
          this.subtitleDecoder.setOnCue((cue) => {
            Logger.debug(
              TAG,
              `Subtitle cue callback triggered: "${cue.text?.substring(0, 30)}..." (${cue.start.toFixed(2)}s - ${cue.end.toFixed(2)}s)`,
            );
            if (this.videoRenderer) {
              Logger.debug(TAG, "Setting subtitle cue on video renderer");
              this.videoRenderer.setSubtitleCues([cue]);
            } else {
              Logger.warn(TAG, "Subtitle cue callback: videoRenderer is null!");
            }
          });

          // TODO: Seek to re-read subtitle packets causes playback disruption
          // const currentTime = this.getCurrentTime();
          // Logger.debug(TAG, `Seeking to ${currentTime.toFixed(2)}s to pick up subtitle packets`);
          // this.seek(currentTime).catch(() => {});

          // If a non-zero subtitle delay is already configured (e.g. set
          // before the track was selected, or persisted via attribute),
          // prefetch the full cue list now so the renderer has
          // out-of-order cues available immediately.
          if (
            this.videoRenderer &&
            this.videoRenderer.getSubtitleDelay() !== 0
          ) {
            void this.prefetchActiveSubtitleStream();
          }
        } else {
          Logger.warn(
            TAG,
            `Could not configure subtitle decoder for track ${subtitleTrack.id} (${subtitleTrack.codec}) - codec may not be available in WASM build`,
          );
          // If decoder configuration failed, deselect the track since we can't decode it
          this.trackManager.selectSubtitleTrack(-1);
          return false;
        }
      } else {
        Logger.warn(
          TAG,
          `No active subtitle track found after selecting trackId ${trackId}`,
        );
      }
    } else {
      Logger.warn(
        TAG,
        `Cannot configure subtitle decoder: demuxer=${!!this.demuxer}, subtitleDecoder=${!!this.subtitleDecoder}`,
      );
    }

    return result;
  }

  /**
   * Get current playback time
   */
  getCurrentTime(): number {
    if (this.streamWrapper) {
      return this.streamWrapper.getCurrentTime();
    }
    // Subtract seekKeyframeOffset so the timeline reports the user-requested
    // time after a seek instead of where the decoder actually landed (which
    // can be seconds later on long-GOP containers like .ts). Offset is reset
    // on every new seek and only ever non-negative.
    return Math.max(
      0,
      this.clock.getTime() - this.startTime - this.seekKeyframeOffset,
    );
  }

  /**
   * After a `postertime` seek has painted the poster frame on the canvas,
   * reset only the CLOCK/playhead bookkeeping back to the start — WITHOUT
   * flushing the decoder, re-seeking the demuxer, or clearing the renderer
   * queue. That keeps the poster frame (from ~postertime) visible on the
   * canvas while the seek bar/getCurrentTime() read 0, and lets the first
   * play() start cleanly from the beginning (play()'s first-play branch
   * re-seeks the demuxer to 0 itself). Pure time-math; touches no media state.
   */
  resetClockToStartForPoster(): void {
    if (this.streamWrapper) return; // HLS owns its own timeline
    this.clock.seek(this.startTime); // paused → pausedTime = startTime
    this.seekKeyframeOffset = 0; // so getCurrentTime() === 0
    this.seekTargetTime = -1; // clear any lingering pre-target frame-drop filter
    this._videoResumeTarget = -1;
    this.waitingForVideoSync = false; // no stale seek-completion armed
    this._playStartTime = 0; // keep first-play branch eligible
    this._primingAudio = false;
    this.clearPacketQueues(); // poster-era packets are stale; play() re-seeks
    // The poster seek advanced HttpSource's monotonic buffered-end to ~poster
    // time; reset it (as a real seek does) so the buffer bar starts from 0
    // instead of showing a false prebuffer at the poster timestamp.
    this.lastBufferedTime = 0;
    this.bufferedRangeStart = 0;
    this.emit("timeUpdate", this.getCurrentTime()); // snap seek bar to 00:00
  }

  /**
   * Get duration
   */
  getDuration(): number {
    if (this.streamWrapper) {
      return this.streamWrapper.getDuration();
    }
    return this.mediaInfo?.duration ?? 0;
  }

  /**
   * Get LRU cache statistics
   */
  getCacheStats(): {
    utilization: number;
    sizeBytes: number;
    maxSizeBytes: number;
    entryCount: number;
  } {
    return {
      utilization: this.cache.getUtilization(),
      sizeBytes: this.cache.getSize(),
      maxSizeBytes: this.cache.getMaxSize(),
      entryCount: this.cache.getEntryCount(),
    };
  }

  /**
   * Get cached time ranges for visualization
   * Converts cached byte ranges to time ranges
   * @returns Array of {start, end} time ranges in seconds
   */
  getCachedTimeRanges(): Array<{ start: number; end: number }> {
    if (!this.source || !this.mediaInfo || this.fileSize <= 0) {
      return [];
    }

    const sourceKey = this.source.getKey();
    const byteRanges = this.cache.getCachedRanges(sourceKey);
    const duration = this.mediaInfo.duration;

    if (duration <= 0) {
      return [];
    }

    // Convert byte ranges to time ranges using linear estimation
    const timeRanges: Array<{ start: number; end: number }> = [];

    for (const range of byteRanges) {
      const startRatio = range.offset / this.fileSize;
      const endRatio = (range.offset + range.length) / this.fileSize;

      const start = Math.max(0, Math.min(duration, startRatio * duration));
      const end = Math.max(0, Math.min(duration, endRatio * duration));

      if (end > start) {
        timeRanges.push({ start, end });
      }
    }

    return timeRanges;
  }

  /**
   * Get current state
   */
  getState(): PlayerState {
    if (this.streamWrapper) {
      return this.streamWrapper.getState();
    }
    return this.stateManager.getState();
  }

  /**
   * Intended playback state, independent of transient interruptions.
   *
   * The raw state flips to "buffering"/"seeking" while the user is still
   * mid-playback (network stall, internal seek), which would otherwise make
   * the UI's play/pause icon flicker to "play" even though the user never
   * paused. This returns true whenever playback is meant to be running —
   * actually "playing", or interrupted by a buffer/seek that we entered
   * from a playing state (tracked via wasPlayingBeforeRebuffer/Seek). Use
   * this to drive the play/pause icon so it stays stable through stalls.
   */
  isPlaybackIntended(): boolean {
    const state = this.getState();
    if (state === "playing") return true;
    if (
      (state === "buffering" || state === "seeking") &&
      (this.wasPlayingBeforeRebuffer || this.wasPlayingBeforeSeek)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Get media info
   */
  /**
   * Load an encrypted video source
   * Reconfigures the player with an EncryptedHttpSource
   */
  async loadEncrypted(config: {
    videoUrl: string;
    tokenUrl: string;
    videoId: string;
    fingerprint: string;
    sessionToken: string;
    tokenRefreshInterval?: number;
    onAuthFailed?: (reason: string) => void;
  }): Promise<void> {
    this.config.source = {
      type: "encrypted",
      encrypted: config,
    };
    await this.load();
  }

  getMediaInfo(): MediaInfo | null {
    return this.mediaInfo;
  }

  getContentDispositionFilename(): string | null {
    if (this.source instanceof HttpSource) {
      return this.source.getContentDispositionFilename();
    }
    return null;
  }

  getMetadataTitle(): string | null {
    return this.mediaInfo?.metadata?.title ?? null;
  }

  /**
   * Get HLS video element (DRM mode) for direct DOM insertion
   */
  getHLSVideoElement(): HTMLVideoElement | null {
    return this.streamWrapper?.getVideoElement() ?? null;
  }

  /** Chapters supplied by the host, which win over anything in the container.
   *  Null = none supplied, so the container's own chapters are used. */
  private _externalChapters: Array<{
    title: string;
    start: number;
    end?: number;
    image?: string;
  }> | null = null;

  /**
   * Get chapters: the host's list if it supplied one, otherwise the media's
   * own (MKV/MP4 chapter atoms, read by the demuxer).
   *
   * Ends are filled in HERE rather than when the list is set, because a host
   * typically has its chapters before the media is open — at which point the
   * duration is still 0 and the last chapter would be left ending where it
   * starts, i.e. zero-length.
   */
  getChapters(): Array<{
    title: string;
    start: number;
    end: number;
    image?: string;
  }> {
    const own = this._externalChapters;
    if (!own) return this.mediaInfo?.chapters ?? [];
    const duration = this.getDuration();
    return own.map((c, i) => ({
      title: c.title,
      start: c.start,
      image: c.image,
      end:
        Number.isFinite(c.end as number) && (c.end as number) > c.start
          ? (c.end as number)
          : i < own.length - 1
            ? own[i + 1].start
            : duration > c.start
              ? duration
              : c.start,
    }));
  }

  /**
   * Supply chapters from outside the media file. Most streaming sources carry
   * them nowhere near the bytes — YouTube keeps them in the watch page, a CMS
   * in its own database — so a player that can only read container chapters
   * can't show them for the sources that use them most.
   *
   * Ends are derived where omitted: a chapter runs until the next one starts,
   * and the last to the end of the media. Pass null (or an empty list) to drop
   * back to the container's own chapters.
   */
  setChapters(
    list:
      | Array<{ title: string; start: number; end?: number; image?: string }>
      | null
      | undefined,
  ): void {
    if (!list || list.length === 0) {
      this._externalChapters = null;
      return;
    }
    const sorted = list
      .filter((c) => Number.isFinite(c.start) && c.start >= 0)
      .map((c) => ({
        title: String(c.title ?? ""),
        start: Number(c.start),
        end: c.end,
        // Carried verbatim. An empty string is dropped rather than passed on,
        // so a tile falls back to a decoded frame instead of rendering a
        // broken image for a field the host left blank.
        image: c.image ? String(c.image) : undefined,
      }))
      .sort((a, b) => a.start - b.start);
    this._externalChapters = sorted.length ? sorted : null;
  }

  resizeCanvas(width: number, height: number): void {
    if (this.streamWrapper) {
      // The active stream wrapper owns the shared canvas — resize only its
      // renderer. The main videoRenderer isn't the active renderer here and,
      // crucially, only the wrapper's canvasRenderer receives setVideoRotation,
      // so the main one stays at 0°. Resizing it too would re-run its
      // (unrotated) resize on the SAME canvas and clobber the wrapper's
      // rotation-aware styles (position/transform/dimension-swap) — the video
      // reverts to un-rotated on any resize after a rotate.
      this.streamWrapper.resizeCanvas(width, height);
    } else if (this.videoRenderer) {
      this.videoRenderer.resize(width, height);
    }
    // A resize often coincides with a fullscreen / orientation / PiP change —
    // a good moment to recover a wake lock that dropped or whose first request
    // failed. Idempotent: no-op when already held / not playing / page hidden.
    this.ensureWakeLock();
  }

  /**
   * Set HDR enabled state
   */
  setHDREnabled(enabled: boolean): void {
    this.thumbnailHDREnabled = enabled;
    if (this.videoRenderer && (this.videoRenderer as any).setHDREnabled) {
      (this.videoRenderer as any).setHDREnabled(enabled);
    }

    if (this.thumbnailRenderer) {
      this.thumbnailRenderer.setHDREnabled(enabled);
    }

    // For non-Chromium browsers with tone mapping shader, just update the uniform
    // No need to recreate the entire context
    /* Manual WebGL update logic removed */
  }

  /**
   * Check if current media is HDR
   */
  isHDRSupported(): boolean {
    if (this.videoRenderer && (this.videoRenderer as any).isHDRSupported) {
      return (this.videoRenderer as any).isHDRSupported();
    }
    return false;
  }

  /**
   * Set subtitle overlay element for HTML-based subtitle rendering
   */
  setSubtitleOverlay(overlay: HTMLElement | null): void {
    if (this.videoRenderer) {
      this.videoRenderer.setSubtitleOverlay(overlay);
    }
    // The element registers its renderer before it hands over the overlay, so
    // this is where a renderer registered at creation finds somewhere to draw.
    this._mountCustomRenderer();
  }

  // The layer a host subtitle renderer draws in: a sibling just under the text
  // overlay, which the cue path shows, hides and rewrites as it likes.
  private _subtitleLayer: HTMLElement | null = null;

  private _mountCustomRenderer(): void {
    const renderer = this._customSubtitleRenderer;
    const overlay = this.videoRenderer?.getSubtitleOverlay?.() ?? null;
    const parent = overlay?.parentNode;
    if (!renderer?.mount || !overlay || !parent) return;
    let layer = this._subtitleLayer;
    if (!layer || layer.parentNode !== parent) {
      layer?.remove();
      layer = document.createElement("div");
      layer.className = "movi-subtitle-renderer-layer";
      layer.style.cssText =
        "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:4;";
      parent.insertBefore(layer, overlay);
      this._subtitleLayer = layer;
    }
    try {
      renderer.mount(layer);
    } catch {
      /* ignore */
    }
  }

  /**
   * Set extra bottom padding for subtitles when controls are visible
   */
  /** See CanvasRenderer.subtitleReservePx. */
  getSubtitleReserve(): number {
    return this.videoRenderer?.subtitleReservePx() ?? 0;
  }

  /** Hold the caption still while the viewer drags it. */
  setSubtitleHeld(held: boolean): void {
    this.videoRenderer?.setSubtitleHeld(held);
  }

  setSubtitleControlsPadding(padding: number): void {
    if (this.videoRenderer) {
      this.videoRenderer.setSubtitleControlsPadding(padding);
    }
  }

  /**
   * Rotate video 90 degrees clockwise
   */
  rotateVideo(): number {
    // Adaptive streams render via the wrapper's OWN CanvasRenderer on the
    // shared canvas — MoviPlayer's own videoRenderer never gets frames for a
    // stream, so its containerWidth stays 0 and rotate90() there is a silent
    // no-op (the button/shortcut appeared to do nothing / not center). Route
    // to the wrapper instead, same as setVideoRotation().
    if (this.streamWrapper) {
      return (this.streamWrapper as any).rotateVideo?.() ?? 0;
    }
    if (this.videoRenderer) {
      return this.videoRenderer.rotate90();
    }
    return 0;
  }

  /**
   * The currently-displayed picture, or null — a decoded VideoFrame, or the
   * <video> element on the MSE paths. Fallback capture source for snapshots
   * when the WebGL canvas reads back blank; both are drawImage sources.
   */
  getCurrentVideoFrame(): RenderSource | null {
    return this.videoRenderer?.getCurrentFrame() ?? null;
  }

  /**
   * Get current video rotation
   */
  getVideoRotation(): number {
    if (this.streamWrapper) {
      return (this.streamWrapper as any).getVideoRotation?.() ?? 0;
    }
    return this.videoRenderer?.getRotation() ?? 0;
  }

  setVideoRotation(deg: number): void {
    this.videoRenderer?.setManualRotation(deg);
    // Adaptive streams draw through the wrapper's OWN CanvasRenderer on the same
    // canvas; without routing the rotation there too, its per-frame resize()
    // resets the canvas to an un-rotated 100% box and clobbers the centering
    // (the video ends up rotated but pinned to one side). Mirrors setFitMode.
    (this.streamWrapper as any)?.setVideoRotation?.(deg);
  }

  setFitMode(mode: "contain" | "cover" | "fill" | "zoom" | "control"): void {
    if (this.streamWrapper) {
      this.streamWrapper.setFitMode(mode);
    }
    if (this.videoRenderer) {
      this.videoRenderer.setFitMode(mode);
    }
  }

  setLetterboxColor(r: number, g: number, b: number): void {
    if (this.videoRenderer) {
      this.videoRenderer.setLetterboxColor(r, g, b);
    }
  }

  // ───────────────────────── 360° VR ─────────────────────────

  /** Enable/disable 360° equirectangular projection on the video renderer. */
  setVR360(enabled: boolean): void {
    this.videoRenderer?.setVR360(enabled);
  }

  isVR360Enabled(): boolean {
    return this.videoRenderer?.isVR360Enabled() ?? false;
  }

  /** Live 360° camera + projection snapshot for reprojecting seek-bar previews
   *  to the current view. Null when not in 360. */
  getVR360View(): VRView | null {
    return this.videoRenderer?.getVRView() ?? null;
  }

  /** Select the VR projection/layout: half = VR180, fisheye = equidistant
   *  fisheye, stereoSbs = side-by-side stereo (left eye), stereographic =
   *  little-planet. */
  setVRProjection(
    half: boolean,
    fisheye = false,
    stereoSbs = false,
    stereographic = false,
  ): void {
    this.videoRenderer?.setVRProjection(
      half,
      fisheye,
      stereoSbs,
      stereographic,
    );
  }

  /** Pan the 360° camera by a pointer drag (CSS px) over a viewport of
   *  viewportPx CSS height. */
  nudgeVR360(dx: number, dy: number, viewportPx: number): void {
    this.videoRenderer?.nudgeVR360(dx, dy, viewportPx);
  }

  /** Zoom the 360° camera (delta>0 zooms out, e.g. wheel deltaY). */
  zoomVR360(delta: number): void {
    this.videoRenderer?.zoomVR360(delta);
  }

  /** Recentre the 360° camera. */
  resetVRView(): void {
    this.videoRenderer?.resetVRView();
  }

  /** Paint a still poster image onto the canvas (so a custom `poster` shows in
   *  360° before playback, since a poster URL skips the initial decode). */
  renderPosterImage(image: CanvasImageSource): void {
    this.videoRenderer?.renderPosterImage(image);
  }

  /**
   * Set playback rate
   */
  setPlaybackRate(rate: number): void {
    if (this.streamWrapper) {
      this.streamWrapper.setPlaybackRate(rate);
    }

    // Idempotent: a re-application of the SAME rate has nothing to do, and
    // doing it anyway is actively harmful. The element sets its `playbackrate`
    // attribute AND calls updatePlaybackRate(), so every user speed change
    // arrives here twice. The first pass re-anchors AudioRenderer (drops the
    // scheduled old-rate sources, pulls scheduledTime to `now`) — which leaves
    // the buffer legitimately empty for a moment. The second pass then read
    // that as "no healthy audio anchor" and took the corrective-seek path:
    // full decoder flush, HEVC decoder recreate, frame-queue clear. That is
    // the second-plus freeze on every speed change.
    if (this.clock.getPlaybackRate() === rate) {
      this._pendingRate = 0; // asked to go back to where it already is
      return;
    }

    // Stamp the change so the stall detector can tell an underrun caused by our
    // own audio re-anchor from a genuine one (see SELF_INFLICTED_STALL_WINDOW_MS).
    this._lastRateChangeAt = performance.now();

    const savedTime = this.getCurrentTime();
    // Only the corrective seek's purpose (undoing the audio read-ahead pivot)
    // applies when playback is actually rolling. At load time the rate is
    // restored from settings while the player sits in "ready"/"paused" — a
    // corrective seek then would (via preservePlaying) latch a resume intent
    // and auto-start playback. Gate it to active playback only.
    const playingNow =
      this.stateManager.getState() === "playing" ||
      this.stateManager.getState() === "buffering";

    // Snapshot the audio anchor BEFORE anything is re-anchored below. This must
    // not move: AudioRenderer.setPlaybackRate() stops the scheduled old-rate
    // sources and pulls scheduledTime back to `now`, and hasHealthyBuffer()
    // reads exactly those two fields (activeSources empty + zero buffer ahead)
    // — so asking afterwards ALWAYS answers "unhealthy", and the corrective
    // seek below fired on every single rate change, which is the freeze this
    // guard exists to prevent. Read it while the pre-change audio state is
    // still intact.
    const audioAnchored = this.hasHealthyAudioAnchor();
    // Is there sound whose read-ahead a rate change could pivot? With none (a
    // video-only file, a track that has ended, audio the browser will not play)
    // there is nothing for the corrective seek to undo.
    const audioPlayable = this.audioIsPlayable();

    // Sound that cannot carry the change yet: hold it and let the pipeline
    // fill, rather than take the stop. Applied from processLoop the moment the
    // cushion exists, or after RATE_PREPARE_MAX_MS regardless — which is the
    // path taken today. Coming back DOWN is held the same way: the question is
    // only ever what the audio is holding, not which way the rate moves.
    if (
      !this._applyingPendingRate &&
      this.stateManager.getState() === "playing" &&
      audioPlayable &&
      !audioAnchored &&
      !this.audioDemuxer &&
      !this.isLinearPlayback()
    ) {
      if (this._pendingRate !== rate) {
        this._pendingRate = rate;
        this._pendingRateSince = performance.now();
        Logger.info(
          TAG,
          `Speed ${rate}x: the audio cannot carry it yet — filling first`,
        );
      }
      return;
    }
    this._pendingRate = 0;

    this.clock.setPlaybackRate(rate);

    // Update audio renderer playback rate
    if (this.audioRenderer) {
      this.audioRenderer.setPlaybackRate(rate);
    }

    // Update video renderer playback rate
    if (this.videoRenderer) {
      this.videoRenderer.setPlaybackRate(rate);
    }
    // Tell the decoder the rate: it only screens out crash-inducing tiny
    // show_existing_frame packets at non-1x (at 1x they decode fine and
    // dropping them breaks the reference chain → later keyframe reject).
    if (this.videoDecoder) {
      this.videoDecoder.setPlaybackRate(rate);
    }

    // No decoder flushes on rate change. Flushing the audio decoder drops
    // its read-ahead queue, so the next chunk arrives with whatever mediaTime
    // the demuxer has progressed to (often a second or more ahead) — that
    // audio leap then strands the video decoder behind, causing either
    // pixelation (no video flush) or a multi-second freeze (with flush, on
    // low-end hardware or Open GOP AV1). Letting buffered packets keep
    // flowing means the audible transition is just whatever output buffer
    // the AudioContext has — small with latencyHint="interactive" — and
    // the new rate is applied to subsequent stretcher output naturally.

    // Corrective seek to the saved position so the audio clock can't pivot to
    // the demuxer read-ahead mediaTime (the "jumps ahead on rate change" bug).
    // preservePlaying keeps the play/pause state across it; the seek-session
    // guard keeps rapid rate changes from a superseded completion landing
    // paused. Only when actually playing — see playingNow above.
    // Linear (non-seekable) playback can't do the corrective seek — the
    // keyframe before savedTime is usually behind the sliding window and the
    // read would fail (seek timeout → buffering). Skip it; the worst case is a
    // brief read-ahead pivot on rate change, far better than a stalled seek.
    //
    // Also skip it when a healthy audio clock is already anchoring playback:
    // AudioRenderer.setPlaybackRate() carries the change in place (stops the
    // stale old-rate sources, takes their buffers back, reschedules them at the
    // new rate behind what is playing) so the pivot is already prevented
    // WITHOUT a seek. The seek is a
    // re-prime of the whole demux→decode→render pipeline — invisible spinner,
    // but a brief frame hitch. Dropping it here makes the common case (audio
    // playing, buffer healthy) as seek-free as a native <video> rate change.
    // The seek stays as the fallback for video-only / unhealthy-audio playback,
    // where nothing else re-anchors the clock.
    if (
      playingNow &&
      !this.isLinearPlayback() &&
      !audioAnchored &&
      audioPlayable
    ) {
      this.seek(savedTime, {
        suppressSpinner: true,
        preservePlaying: true,
      }).catch(() => {});
    }
  }

  /**
   * Hand a held speed change back to setPlaybackRate once the audio can carry
   * it, or once waiting has gone on long enough. Called every tick; a no-op when
   * nothing is held.
   */
  private maybeApplyPendingRate(): void {
    const rate = this._pendingRate;
    if (!rate) return;
    const stillFilling =
      this.stateManager.getState() === "playing" &&
      this.audioIsPlayable() &&
      !this.hasHealthyAudioAnchor() &&
      performance.now() - this._pendingRateSince <
        MoviPlayer.RATE_PREPARE_MAX_MS;
    if (stillFilling) return;
    this._applyingPendingRate = true;
    try {
      this.setPlaybackRate(rate);
    } finally {
      this._applyingPendingRate = false;
      this._pendingRate = 0;
    }
  }

  /**
   * True when a healthy audio clock is currently anchoring playback, so the
   * corrective seek in setPlaybackRate() is redundant (the audio pipeline
   * re-anchors the rate change in place). Used to keep rate changes seek-free
   * — and therefore native-video-smooth — in the common case.
   */
  private hasHealthyAudioAnchor(): boolean {
    // This returned a flat `false` — no machine ever skipped the corrective
    // seek — and the reason it did was real at the time: AudioRenderer's
    // re-anchor DROPPED the scheduled audio, which left the demuxer parked at
    // its read-ahead position, and the next chunk to arrive read as an
    // underrun and pivoted the whole clock onto that read-ahead media time
    // ("Pivot global clock if we underrun"). 1.5-3.6s of the film skipped on
    // every speed change. The seek was what rewound the demuxer back.
    //
    // That premise is gone. AudioRenderer.setPlaybackRate now TAKES BACK the
    // audio scheduled ahead — the unstarted sources are stopped and their
    // original pre-stretch buffers pushed to the front of the pending queue,
    // re-stretched at the new tempo, rescheduled behind the chunk still
    // playing — and the segment it leaves behind keeps the old rate it was
    // written with, so the clock cannot leap to the read-ahead. No media is dropped, so
    // there is no hole for an underrun to pivot on, and the span the seek went
    // back to fetch is the span the renderer is still holding.
    //
    // What the seek costs, meanwhile, is the whole stop: the demux loop
    // cancelled, the read in flight waited out, the audio decoder flushed, the
    // renderer reset (which throws away exactly the audio just reclaimed) and
    // a backwards demuxer seek — with the picture living off its queue for all
    // of it. That is "2x hone se pehle thodi der ko ruk jaata hai", and on the
    // prepare path it is at its worst, because that path exists precisely for
    // pipelines with nothing to spare.
    //
    // So ask the renderer whether the reclaim is actually available, rather
    // than assuming either way. Thin or cold audio still takes the seek.
    return this.audioRenderer?.canCarryRateChange?.() ?? false;
  }

  /**
   * Pause/resume the video source's background prefetch for audio-only mode.
   * Only used for split sources, where this.source is video-only and the audio
   * streams independently.
   */
  private setVideoSourcePrefetchPaused(paused: boolean): void {
    const src = this.source as unknown as {
      setPrefetchThrottle?: (v: boolean) => void;
    } | null;
    src?.setPrefetchThrottle?.(paused);
  }

  /**
   * Stand up a WASM-decoded split (separate-URL) audio track: a SECOND Demuxer
   * (isolated WASM module) over the audio URL, feeding the shared audioDecoder →
   * audioRenderer. Mirrors the muxed configure path; the AudioRenderer is already
   * clock-master so sync/volume/rate need no extra wiring. Best-effort — on
   * failure it clears the demuxer so playback continues video-only.
   */
  /**
   * Turn HLS segmented-WebVTT subtitle renditions into external subtitle
   * tracks: fetch every segment, concatenate into one presentation-timed VTT
   * (via buildVttFromSegments), and hand back blob-URL tracks. Renditions with
   * no cues are skipped.
   */
  private async buildHlsSubtitleTracks(
    renditions: HlsSubtitleRendition[],
    headers?: Record<string, string>,
  ): Promise<SubtitleSourceEntry[]> {
    const out: SubtitleSourceEntry[] = [];
    for (const r of renditions) {
      // A rendition is one request PER SEGMENT — dozens of them, fired at once
      // and none of them cancellable, which made this the largest single source
      // of traffic outliving a torn-down player. The signal goes on every one,
      // and the loop stops between renditions too so a long list doesn't start
      // a fresh batch after teardown.
      if (this._lifetimeAbort.signal.aborted) break;
      try {
        const texts = await Promise.all(
          r.segments.map((s) =>
            fetch(s.url, {
              ...(headers ? { headers } : {}),
              signal: this.lifetimeSignal,
            })
              .then((res) => (res.ok ? res.text() : ""))
              .catch(() => ""),
          ),
        );
        const vtt = buildVttFromSegments(texts);
        if (!vtt.includes("-->")) continue; // no cues parsed
        const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
        out.push({ url, lang: r.lang, label: r.label, format: "vtt" });
      } catch (e) {
        Logger.warn(TAG, `HLS subtitle build failed for ${r.lang}`, e);
      }
    }
    return out;
  }

  private async setupSplitAudio(source: string | SourceAdapter): Promise<void> {
    try {
      if (typeof source === "string") {
        Logger.info(TAG, `Split audio (WASM) setup: ${source}`);
        this.audioSource = await this.createSource({
          type: "url",
          url: source,
          headers: this.config.headers,
        });
        // A smaller opening request for audio. 4MB of AAC is four minutes
        // nobody needs yet, and it is fetched during startup where the wait is
        // the viewer's — measured at 2.8s on an ordinary link. The streaming
        // loop after the first range is unchanged, so nothing under-buffers.
        (
          this.audioSource as unknown as {
            setFirstRangeBytes?: (n: number) => void;
          }
        )?.setFirstRangeBytes?.(1_000_000);
      } else {
        // Pre-built adapter (e.g. an HLS audio rendition's segment stream).
        Logger.info(TAG, `Split audio (WASM) setup: ${source.getKey()}`);
        this.audioSource = source;
      }
      // Isolated WASM instance (3rd arg): a second demuxer MUST NOT share the
      // main module's global read callback — same isolation the thumbnail/cover
      // pipelines use.
      this.audioDemuxer = new Demuxer(
        this.audioSource,
        this.config.wasmBinary,
        true,
      );
      const audioInfo = await this.audioDemuxer.open();
      const aTrack = this.audioDemuxer.getAudioTracks()[0];
      if (!aTrack) {
        Logger.warn(TAG, "Split audio: no audio track in separate source");
        this.audioDemuxer = null;
        this.audioSource = null;
        return;
      }
      this._splitAudioTrackId = aTrack.id;
      // Everything above ran alongside the video demuxer. THIS is the one line
      // that needs it — the video's PTS baseline — so wait for it here rather
      // than making the whole audio open wait.
      if (this._videoInfoReady) await this._videoInfoReady;
      if (this._destroyed) return;
      // Align this source's PTS baseline with the video's. Use mediaInfo.startTime
      // (already resolved) rather than this.startTime, which isn't set yet on the
      // initial-load call path.
      this._splitAudioStartTime = audioInfo?.startTime || 0;
      this._splitAudioPtsDelta =
        (this.mediaInfo?.startTime || 0) - this._splitAudioStartTime;
      if (this._splitAudioPtsDelta !== 0) {
        Logger.info(
          TAG,
          `Split audio PTS baseline ${this._splitAudioStartTime.toFixed(3)}s vs video ${(this.mediaInfo?.startTime || 0).toFixed(3)}s — shifting audio by ${this._splitAudioPtsDelta.toFixed(3)}s`,
        );
      }
      const extradata = this.audioDemuxer.getExtradata(aTrack.id) ?? undefined;
      const bindings = this.audioDemuxer.getBindings();
      if (bindings) this.audioDecoder.setBindings(bindings);
      const configured = await this.audioDecoder.configure(aTrack, extradata);
      if (!configured) {
        Logger.warn(TAG, "Split audio: decoder configure failed");
        this.audioDemuxer = null;
        this.audioSource = null;
        return;
      }
      // Same as the muxed path above: the rate has to reach the renderer
      // before the context exists. This is the path a split (separate-URL)
      // audio stream takes, which is what every YouTube-style source uses.
      this.audioRenderer.configure(aTrack.sampleRate, aTrack.channels);
      await this.audioRenderer.init();
      const sourceCh = aTrack.channels ?? 2;
      const maxCh = this.audioRenderer.getMaxChannelCount();
      if (sourceCh > 2 && maxCh >= sourceCh) {
        this.audioDecoder.setDownmix(false);
        this.audioRenderer.setOutputChannelCount(sourceCh);
      } else {
        this.audioDecoder.setDownmix(true);
        this.audioRenderer.setOutputChannelCount(2);
      }
      this._splitAudioEof = false;
      this.splitAudioQueue.clear();
      // A source of its own, so a clean slate for its failures too.
      this._splitAudioDead = false;
      this._splitAudioErrorSince = 0;
      this._lastSplitAudioPts = 0;
      // Sync the freshly-opened audio demuxer to where the player ACTUALLY is.
      // This setup is async: a recovery recreate's resume-seek (or any seek that
      // lands while it's still in flight) moves the video but can't seek an
      // audio demuxer that doesn't exist yet. Without this the audio starts at 0
      // and runs tens of seconds behind — which the desync detector then
      // "fixes" by dragging the VIDEO backwards to meet it.
      const playhead = this.getCurrentTime();
      if (playhead > 0.5) {
        try {
          await this.audioDemuxer.seek(playhead + this._splitAudioStartTime);
          Logger.info(
            TAG,
            `Split audio synced to playhead ${playhead.toFixed(1)}s after setup`,
          );
        } catch {
          /* best-effort — the next seek/resync corrects it */
        }
      }
      Logger.info(
        TAG,
        `Split audio (WASM) ready: ${aTrack.codec} ${aTrack.sampleRate}Hz ${aTrack.channels}ch`,
      );
    } catch (e) {
      Logger.error(
        TAG,
        `Split audio setup failed: ${(e as any)?.message ?? e}`,
      );
      try {
        this.audioDemuxer?.close();
      } catch {}
      try {
        this.audioSource?.close();
      } catch {}
      this.audioDemuxer = null;
      this.splitAudioQueue.clear();
      this.audioSource = null;
      // A stall/timeout opening the audio demuxer is usually transient — the
      // video's opening burst monopolised the link and the audio's first-bytes
      // read starved out ("Timeout at 0"). Once the video buffer fills and the
      // link frees up, a retry gets through. Bounded so a genuinely dead audio
      // URL doesn't loop. Without this the video played on permanently silent.
      const transient =
        typeof source === "string" &&
        /timeout|stall|network|failed to fetch|incomplete/i.test(
          String((e as any)?.message ?? ""),
        );
      if (
        transient &&
        this._splitAudioRetries < MoviPlayer.MAX_SPLIT_AUDIO_RETRIES
      ) {
        this._splitAudioRetries++;
        const delay = 1500 * this._splitAudioRetries;
        Logger.warn(
          TAG,
          `Split audio open stalled — retry ${this._splitAudioRetries}/${MoviPlayer.MAX_SPLIT_AUDIO_RETRIES} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        if (this._destroyed) return;
        await this.setupSplitAudio(source);
      }
    }
  }

  /**
   * Audio demux pump for split audio — sibling to processLoop but reads only the
   * separate audio demuxer and feeds the shared audioDecoder. Own in-flight guard
   * (separate WASM module, so independent of the video demuxInFlight critical
   * section). Bounded lead so it doesn't fetch the whole audio file ahead.
   */
  // One decode pass of the split-audio demuxer. Returns false when the loop
  // should stop (no demuxer / EOF / not playing), true to keep going. Does NOT
  // schedule the next tick — the caller owns cadence: the rAF wrapper in the
  // foreground, the un-throttled background Worker timer when hidden (rAF is
  // throttled in background, which is exactly what stalled audio there).
  private async pumpSplitAudio(): Promise<boolean> {
    if (!this.audioDemuxer || this._splitAudioDead) return false;
    if (this._splitAudioEof && this.splitAudioQueue.length === 0) return false;
    const state = this.stateManager.getState();
    if (
      state !== "playing" &&
      state !== "buffering" &&
      !this.waitingForVideoSync
    ) {
      return false;
    }
    if (this.audioDemuxInFlight) return true;

    // Hold audio while the video is still hunting its first keyframe after a
    // seek/first-play. The AudioRenderer plays buffers the instant they're
    // decoded (even before the clock starts), so decoding here would let audio
    // run ahead during the ~2s sync window — the clock then snaps to an audio
    // position seconds past the video, which never catches up (perpetual
    // "buffers empty" stall loop). The muxed path holds audio the same way, in
    // audioQueue. Held, not unread: the packets wait in splitAudioQueue.
    //
    // Never in audio-only: there's no video being shown to sync to, so holding
    // audio for a video keyframe just starves it — worst on a seek into a
    // not-yet-buffered region, where the video can't produce that frame for
    // seconds and the audio (often fully cached) goes silent for no reason.
    const holdForVideo =
      !this._audioOnly &&
      this.waitingForVideoSync &&
      !!this.trackManager.getActiveVideoTrack();

    // Hold a few seconds of lead (scaled with rate); the audio bitrate is tiny
    // so the time-cushion costs almost no bytes. The same seconds serve as the
    // queue's readahead.
    const rate = Math.max(0.25, this.clock.getPlaybackRate());
    const bufferedTarget = 5 * (rate < 1 ? 1 / rate : Math.min(2, rate));

    if (!holdForVideo) this.feedSplitAudio(bufferedTarget);
    if (this._splitAudioEof) return true; // keep ticking until the queue drains

    const demuxer = this.audioDemuxer;
    this.audioDemuxInFlight = true;
    try {
      const sliceStart = performance.now();
      while (
        !this._splitAudioEof &&
        this.audioDemuxer === demuxer &&
        this.splitAudioQueue.bytes < MoviPlayer.MAX_QUEUE_BYTES &&
        (this.splitAudioQueue.length === 0 ||
          this.splitAudioQueue.forwardSeconds() < bufferedTarget) &&
        performance.now() - sliceStart < MoviPlayer.READ_SLICE_MS
      ) {
        const pkt = await demuxer.readPacket();
        if (!pkt) {
          // No bytes is either the end of the track or a source that has
          // stopped answering — they reach C as the same thing. Ask, the way
          // the muxed loop asks (see getSourceFailure), or an expired audio
          // URL passes for a finished one and the film plays on in silence.
          const failure = this.getSplitAudioFailure();
          if (failure) throw failure;
          this._splitAudioEof = true;
          break;
        }
        // A packet arrived, so whatever went wrong before was a moment, not
        // the end of the road.
        this._splitAudioErrorSince = 0;
        if (
          this._splitAudioTrackId !== -1 &&
          pkt.streamIndex !== this._splitAudioTrackId
        ) {
          continue;
        }
        // Shift a separately-timed audio rendition onto the video's PTS timeline
        // (delta is 0 when they share a baseline), so decode timestamps, the
        // seek-target filter (video-PTS scale) and the clock all agree.
        this.splitAudioQueue.push({
          ...pkt,
          timestamp: pkt.timestamp + this._splitAudioPtsDelta,
        });
        if (!holdForVideo) this.feedSplitAudio(bufferedTarget);
      }
    } catch (e) {
      const message = (e as any)?.message ?? String(e);
      // A bad packet is worth stepping over: the next read usually works, and
      // this loop's whole job is to keep the sound coming. A source that has
      // stopped answering is not that. It fails every read the same way, and
      // this pump runs on the animation frame — so the same warning went out
      // sixty times a second, for ever, while the viewer watched a picture
      // with no sound and no reason given. (Measured on a signed URL that
      // began answering 403 mid-playback: 777 identical lines and counting.)
      //
      // So: ask the source whether this is a fact about the URL, and failing
      // that, give the track a few seconds to produce ONE packet. Neither
      // answer is recoverable here — the link has to be re-issued, which is
      // the embedding page's business, and it can only do that if it is told.
      const failure = this.getSplitAudioFailure();
      const stuckFor = this._splitAudioErrorSince
        ? performance.now() - this._splitAudioErrorSince
        : 0;
      if (!this._splitAudioErrorSince) {
        this._splitAudioErrorSince = performance.now();
        Logger.warn(TAG, `Split audio demux error: ${message}`);
      }
      if (failure || stuckFor >= MoviPlayer.SPLIT_AUDIO_GIVE_UP_MS) {
        this._splitAudioDead = true;
        this.failFatally(
          failure ??
            new Error(
              `Audio track stopped reading after ${(stuckFor / 1000).toFixed(1)}s: ${message}`,
            ),
        );
      }
    } finally {
      this.audioDemuxInFlight = false;
    }

    return (
      !this._splitAudioDead &&
      (!this._splitAudioEof || this.splitAudioQueue.length > 0)
    );
  }

  private feedSplitAudio(bufferedTarget: number): void {
    // Bound the audio decode lead against the CLOCK, not the AudioRenderer
    // buffer. While the AudioContext is suspended (Safari muted-autoplay) the
    // buffer-duration reading is unreliable, so a buffer-only gate let audio
    // race far ahead of the wall-clock-rolling video and land seconds/minutes
    // out of sync on unmute. Gating on how far the last decoded PTS is past the
    // playhead keeps audio close to the video in every state. Crucially, while
    // audio is being DROPPED (muted with a suspended context — autoplay
    // blocked, before any gesture) keep the lead tiny: that renderer advances
    // its media clock to the lead edge, so a big lead becomes exactly that much
    // A/V drift the instant the user unmutes. A small lead makes unmute land on
    // the playhead. A muted-but-RUNNING context schedules audio like any other,
    // so it gets the full smooth-buffer lead — starving it there was making
    // muted playback stall in a loop while the same file played smoothly with
    // sound.
    const lead = this.audioRenderer.isDroppingAudio() ? 0.25 : bufferedTarget;
    const mediaNow = Math.max(0, this.clock.getTime() - this.startTime);
    while (
      this.splitAudioQueue.length > 0 &&
      this.audioDecoder.queueSize <= 40 &&
      this.audioRenderer.getBufferedDuration() < bufferedTarget &&
      this._lastSplitAudioPts - mediaNow <= lead
    ) {
      const pkt = this.splitAudioQueue.shift()!;
      const pts = pkt.timestamp;
      // Skip packets before an in-flight seek target (mirror the video path).
      if (this.seekTargetTime !== -1 && pts < this.seekTargetTime) {
        continue;
      }
      // …and keep skipping past completion, up to where the seek actually
      // resumed (see _splitAudioSkipBefore). Cleared by the first packet that
      // reaches it, so it costs one comparison per packet afterwards.
      if (this._splitAudioSkipBefore >= 0) {
        if (pts < this._splitAudioSkipBefore) continue;
        this._splitAudioSkipBefore = -1;
      }
      this.audioDecoder.decode(pkt.data, pts, pkt.keyframe);
      // Track the last PTS 0-based (content time) to match the lead gate,
      // which compares against `mediaNow` (clock − startTime).
      this._lastSplitAudioPts = pts - this.startTime;
    }
  }

  /** True once the split-audio demuxer has hit EOF and the renderer has played
   *  out its buffered tail — i.e. the track is actually finished. Mirrors the
   *  main processLoop's audioPlayedOut check. */
  private isSplitAudioPlayedOut(): boolean {
    const currentTime = this.clock.getTime();
    const duration = this.mediaInfo?.duration ?? 0;
    const maxScheduled = this.audioRenderer.getMaxScheduledMediaTime();
    const reachedEnd =
      duration > 0 && currentTime >= duration + this.startTime - 0.25;
    const playedOut = maxScheduled > 0 && currentTime >= maxScheduled - 0.1;
    return playedOut || reachedEnd || duration === 0;
  }

  /** When the main processLoop (which normally emits "ended") is parked, the
   *  split-audio path must detect end-of-track itself — else a finished track
   *  never fires "ended" and the host can't auto-advance. Emits once the
   *  demuxer hit EOF (not a pause/stop) and the tail has drained. Returns true
   *  when it ended. Safe from both the rAF loop and the background timer.
   *
   *  Two ways the main loop is parked, and only the first was covered:
   *
   *    audio-only — there is no video pipeline to run.
   *
   *    BACKGROUNDED — rAF is throttled to nothing and video decode is skipped
   *    on purpose, so the background timer runs the audio pump and nothing
   *    else. A video watched with the tab hidden therefore played its audio
   *    to the very end and then simply stopped: no EOF, no "ended", no
   *    auto-advance, and the queue sat there until the viewer came back and
   *    the main loop resumed. Read off a real session's log — audio draining
   *    3901ms → 650ms while hidden, then "EOF reached / Playback ended" only
   *    after "Foreground recovery". PiP is excluded because the video IS being
   *    shown there, so the main loop is running and owns the transition. */
  private maybeEndSplitAudio(): boolean {
    const mainLoopParked =
      this._audioOnly || (this.isBackgrounded && !this.isPiPActive);
    if (
      mainLoopParked &&
      this._splitAudioEof &&
      this.splitAudioQueue.length === 0 &&
      (this.stateManager.is("playing") || this.stateManager.is("buffering")) &&
      this.isSplitAudioPlayedOut()
    ) {
      this.handleEnded();
      return true;
    }
    return false;
  }

  private audioProcessLoop = async () => {
    const keepGoing = await this.pumpSplitAudio();
    if (keepGoing) {
      this.audioAnimationFrameId = requestAnimationFrame(this.audioProcessLoop);
      return;
    }
    // The pump stopped. If it's because the demuxer hit EOF (audio-only), keep
    // ticking until the buffered tail drains, then end — otherwise it stopped
    // for a pause/state change and we just idle.
    if (
      (this._audioOnly || (this.isBackgrounded && !this.isPiPActive)) &&
      this._splitAudioEof &&
      (this.stateManager.is("playing") || this.stateManager.is("buffering"))
    ) {
      this.audioAnimationFrameId = this.maybeEndSplitAudio()
        ? null
        : requestAnimationFrame(this.audioProcessLoop);
      return;
    }
    this.audioAnimationFrameId = null;
  };

  private startAudioLoop(): void {
    if (!this.audioDemuxer || this.audioAnimationFrameId !== null) return;
    this.audioAnimationFrameId = requestAnimationFrame(this.audioProcessLoop);
  }

  private stopAudioLoop(): void {
    if (this.audioAnimationFrameId !== null) {
      cancelAnimationFrame(this.audioAnimationFrameId);
      this.audioAnimationFrameId = null;
    }
  }

  /**
   * The audio decoder gave up — every packet is being rejected and playback has
   * gone silent. That's usually a stream the decoder is out of STEP with rather
   * than one it can't decode (an in-place rendition swap, a demuxer replaced
   * under the pump, a decoder reset that left the packet stream mid-frame): the
   * proof is that a manual seek brings the audio straight back, because seeking
   * re-aligns the source and flushes the breaker.
   *
   * So do that automatically, without touching the video: stop the pump, flush,
   * re-seek the audio source to the playhead, resume. Bounded — if it doesn't
   * take after a few tries the source really is undecodable and the player stays
   * silent rather than seeking in a loop.
   */
  private async recoverBrokenAudio(): Promise<void> {
    if (this._destroyed || this._audioRecoveryInFlight) return;
    // On an encrypted source there is nothing to re-align to: the audio track
    // gets no clear lead of its own (the packager's lead covers the video), so
    // the first packet fails and so will every one after it.
    //
    // Go SILENT rather than stopping. The video's clear lead is real playback
    // and worth showing; ending it here would throw away the whole point of
    // getting this far. What must not continue is the waiting — audio empty,
    // video bound to it, the stall detector nudging a seek, forever. Cutting
    // audio out of the picture entirely is what unblocks the video, and the
    // stop then comes from the video decoder when ITS clear lead runs out.
    if (this._sourceIsEncrypted) {
      if (this._encryptedAudioSilenced) return;
      this._encryptedAudioSilenced = true;
      Logger.warn(
        TAG,
        "Encrypted source: audio needs a licence — going silent so the clear video lead can still play",
      );
      this.disableAudio = true;
      try {
        this.audioRenderer.pause();
      } catch {
        /* nothing scheduled */
      }
      return;
    }
    if (this._audioRecoveries >= MoviPlayer.MAX_AUDIO_RECOVERIES) {
      Logger.warn(
        TAG,
        `Audio decode kept failing after ${this._audioRecoveries} re-alignments — leaving audio off`,
      );
      return;
    }
    this._audioRecoveryInFlight = true;
    this._audioRecoveries++;
    const playhead = this.getCurrentTime();
    Logger.info(
      TAG,
      `Audio decoder broken — re-aligning the audio source at ${playhead.toFixed(2)}s (attempt ${this._audioRecoveries})`,
    );
    try {
      if (this.audioDemuxer) {
        this.stopAudioLoop();
        let guard = 0;
        while (this.audioDemuxInFlight && guard++ < 200) {
          await new Promise((r) => setTimeout(r, 5));
        }
        // flush() clears the breaker as well as the codec's own state.
        await this.audioDecoder.flush();
        try {
          await this.audioDemuxer.seek(playhead + this._splitAudioStartTime);
        } catch (e) {
          Logger.warn(
            TAG,
            `Audio re-align seek failed: ${(e as any)?.message ?? e}`,
          );
        }
        this._splitAudioEof = false;
        this.splitAudioQueue.clear();
        this._lastSplitAudioPts = playhead;
        this.audioRenderer.reset();
        this.startAudioLoop();
      } else {
        // Muxed audio: the packets keep coming from the main demuxer, so a
        // flush alone re-arms the decoder at the next keyframe.
        await this.audioDecoder.flush();
        this.audioRenderer.reset();
      }
    } finally {
      this._audioRecoveryInFlight = false;
    }
  }

  /**
   * Hand a still-playing <audio> element to a successor player across a
   * rebuild. This pipeline decodes audio itself and owns no element, so there
   * is never one to pass — the method stays because callers reach it
   * duck-typed on whichever engine is live (NativeVideoWrapper does own one).
   */
  releaseNativeAudio(): HTMLAudioElement | null {
    return null;
  }

  /**
   * Take ownership of an <audio> element carried over from a previous engine
   * (the native fallback owns one). This pipeline has no use for it, so
   * "adopting" it means shutting it down — see below.
   */
  adoptNativeAudio(el: HTMLAudioElement): void {
    // The WASM pipeline no longer plays audio through a media element, so an
    // element handed over from a previous player has no owner here. Adopting it
    // would resurrect the second, independently-clocked audio path this class
    // deliberately dropped; ignoring it would leave it playing the OLD source
    // forever, since the hand-off drops the last reference to it. Stop it.
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch {
      /* noop */
    }
    const stashed = (el as any).__moviObjectUrl;
    if (stashed) {
      try {
        URL.revokeObjectURL(stashed);
      } catch {
        /* noop */
      }
    }
    delete (el as any).__moviObjectUrl;
    delete (el as any).__moviLogicalUrl;
  }

  /**
   * Get available audio language tracks (multi-language mode)
   */
  getAudioLangs(): { lang: string; label: string; active: boolean }[] {
    return this._audioTracks.map((t) => ({
      lang: t.lang,
      label: t.label,
      active: t.lang === this._activeAudioLang,
    }));
  }

  /**
   * Switch audio to another language/track through the SAME WASM split-audio
   * pipeline as the initial audio — NOT a native <audio> element. Native
   * <audio> stalls on the fragmented-MP4 audio files DASH ships (served as
   * video/mp4, readyState never settles), so instead we tear down the current
   * audio demuxer and stand up a fresh one for the new URL, re-seek it to the
   * current position, and resume. Position & play state are preserved.
   */
  async selectAudioLang(lang: string): Promise<boolean> {
    const track = this._audioTracks.find((t) => t.lang === lang);
    if (!track) {
      Logger.warn(TAG, `Audio track not found for lang: ${lang}`);
      return false;
    }
    if (lang === this._activeAudioLang && this.audioDemuxer) return true;

    const t = this.getCurrentTime();

    // --- PREP (old audio keeps playing): build + open + seek the new audio
    // demuxer on an isolated WASM module. The slow work (open = source measure,
    // plus the seek) happens here while the current language still plays, so the
    // silent window shrinks to a buffer flush. Switching LANGUAGE means the old
    // and new content differ, so the buffered old audio must be dropped — a
    // small gap is unavoidable (unlike a same-content bitrate switch). Bails
    // (staying on the current language) if the new one can't be prepared. ---
    let newSource: SourceAdapter | null = null;
    let newDemuxer: Demuxer | null = null;
    let aTrack: AudioTrack | undefined;
    let newAudioStart = 0;
    try {
      newSource =
        track.adapter ??
        (await this.createSource({
          type: "url",
          url: track.url,
          headers: this.config.headers,
        }));
      newDemuxer = new Demuxer(newSource, this.config.wasmBinary, true);
      const info = await newDemuxer.open();
      newAudioStart = info.startTime || 0;
      aTrack = newDemuxer.getAudioTracks()[0];
      if (!aTrack) throw new Error("no audio track in the selected language");
      await newDemuxer.seek(t + newAudioStart);
    } catch (e) {
      Logger.warn(
        TAG,
        `Audio switch prep failed for ${track.label}: ${(e as any)?.message ?? e}`,
      );
      try {
        newDemuxer?.close();
      } catch {}
      if (newSource && newSource !== track.adapter) {
        try {
          newSource.close();
        } catch {}
      }
      // A failed prep leaves the CURRENT language playing, whatever the source
      // shape. This used to hand single-file audio to a native <audio> element
      // instead — which meant the WASM pipeline suddenly ran its audio on a
      // second, independently-clocked media element: its own drift against the
      // canvas clock, its own volume path (no AudioContext, so no stable-volume
      // or >100% boost), and an element that outlived teardown often enough to
      // leave the previous video's audio playing under the next one. Inside the
      // WASM pipeline audio stays in the WASM pipeline; native audio belongs to
      // the native fallback surface, which owns its own <audio> deliberately.
      return false;
    }

    // --- ATOMIC SWAP: stop the audio pump, swap the demuxer/source, reconfigure
    // the audio decoder, drop the old buffer, resume. ---
    this._audioSwitchInProgress = true;
    this.stopAudioLoop();
    let guard = 0;
    while (this.audioDemuxInFlight && guard++ < 200) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const oldDemuxer = this.audioDemuxer;
    const oldSource = this.audioSource;

    this.audioDemuxer = newDemuxer;
    this.audioSource = newSource;
    this._splitAudioTrackId = aTrack.id;
    // Re-derive the PTS-baseline shift for the new audio source.
    this._splitAudioStartTime = newAudioStart;
    this._splitAudioPtsDelta = (this.mediaInfo?.startTime || 0) - newAudioStart;

    const bindings = newDemuxer.getBindings();
    if (bindings) this.audioDecoder.setBindings(bindings);
    const extradata = newDemuxer.getExtradata(aTrack.id) ?? undefined;
    await this.audioDecoder.flush();
    const configured = await this.audioDecoder.configure(aTrack, extradata);
    if (configured) {
      const sourceCh = aTrack.channels ?? 2;
      const maxCh = this.audioRenderer.getMaxChannelCount();
      if (sourceCh > 2 && maxCh >= sourceCh) {
        this.audioDecoder.setDownmix(false);
        this.audioRenderer.setOutputChannelCount(sourceCh);
      } else {
        this.audioDecoder.setDownmix(true);
        this.audioRenderer.setOutputChannelCount(2);
      }
    }
    this.audioRenderer.reset(); // drop the previous language's buffered audio
    this.disableAudio = false;
    this._activeAudioLang = lang;
    this._splitAudioEof = false;
    this.splitAudioQueue.clear();
    // Another language is another source: whatever the last one died of is
    // not this one's to carry.
    this._splitAudioDead = false;
    this._splitAudioErrorSince = 0;
    this._lastSplitAudioPts = t;
    // Restart the pump on the state AS IT IS NOW, and count a seek in flight
    // as live.
    //
    // This used to read the state from BEFORE the swap — before an open, a
    // seek and a decoder reconfigure, any of which can outlast the state that
    // was current when the switch was asked for. Restoring a remembered
    // language is the case that proves it: the element asks as the media
    // loads, so the answer was taken during the opening seek ("seeking", which
    // counted as neither playing nor buffering), the swap landed into a
    // playing player, and the pump was never started again. Nothing decoded a
    // single audio packet after that — the stall detector found the buffer
    // empty, buffering held the full fifteen seconds of the bound escape, and
    // playback resumed with audioReady=false. Measured on a dubbed video: 15s
    // silent, then a 2.6s desync seek to catch the sound up.
    //
    // Safe to start whenever: pumpSplitAudio has its own state guard and idles
    // if it should not be running.
    if (
      this.stateManager.is("playing") ||
      this.stateManager.is("buffering") ||
      this.waitingForVideoSync
    ) {
      if (!this.audioRenderer.isAudioPlaying()) this.audioRenderer.play();
      this.startAudioLoop();
    }
    this._audioSwitchInProgress = false;

    // Tear down the old audio pipeline (video untouched).
    try {
      oldDemuxer?.close();
    } catch {}
    if (oldSource && oldSource !== newSource) {
      try {
        oldSource.close();
      } catch {}
    }

    Logger.info(
      TAG,
      `Audio switched in-place (WASM) to: ${track.label} (${track.lang})`,
    );
    this.emit("audioTrackChange" as any, { lang, label: track.label });
    return true;
  }

  /**
   * Hand playback back to muxed (WASM) audio. Nothing to undo here — this
   * pipeline never leaves it — but the method stays because callers reach it
   * duck-typed on whichever engine is live, and the native fallback DOES have
   * an element to put down.
   */
  useMuxedAudio(): void {}

  /**
   * Whether a native <audio> element is carrying the audio. Never here — this
   * pipeline decodes it — but callers ask whichever engine is live, and the
   * native fallback answers true.
   */
  isNativeAudioActive(): boolean {
    return false;
  }

  hasNativeAudio(): boolean {
    return false;
  }

  /**
   * True if any audio path is active that the user can mute / volume-control.
   * Covers muxed (WASM) tracks, split (separate-URL) audio, and HLS streams
   * whose audio is muxed inside the stream wrapper's <video> element.
   */
  hasAudibleSource(): boolean {
    return (
      this._audioSwitchInProgress ||
      this._audioTracks.length > 0 ||
      this.trackManager.getAudioTracks().length > 0 ||
      this.audioDemuxer !== null ||
      this.streamWrapper !== null
    );
  }

  /**
   * True when audio plays through a native HTMLMediaElement — an adaptive
   * stream (HLS/DASH via the stream wrapper's <video>) — rather than the
   * AudioContext. Such audio can't be boosted above 100%
   * (HTMLMediaElement.volume caps at [0,1]), so the volume UI caps at 100%.
   */
  usesNativeAudio(): boolean {
    // Shaka plays through a media element, so its audio bypasses the WebAudio
    // gain node and can't be boosted past 100%. The WASM path always can.
    return this.streamWrapper !== null;
  }

  /**
   * True when playback runs through an adaptive-stream wrapper (HLS/DASH/Shaka)
   * rather than the WASM demux + canvas renderer. Such playback draws frames via
   * a separate stream-side CanvasRenderer, so the WASM renderer's 16x16 ambient
   * mirror is never populated — the ambient glow can't sample it and the control
   * is hidden.
   */
  isStreamPlayback(): boolean {
    return this.streamWrapper !== null;
  }

  /**
   * Whether seek-bar preview thumbnails are available for an adaptive stream —
   * they come from a manifest thumbnail track (DASH-IF tiled thumbnails / HLS
   * image playlists), which many streams simply don't carry. When false, the
   * Timeline control can't generate previews and is hidden.
   */
  streamHasThumbnails(): boolean {
    return !!(this.streamWrapper as any)?.hasThumbnails?.();
  }

  /** True for a live (dynamic) adaptive stream — drives the LIVE indicator. */
  isLiveStream(): boolean {
    // Shaka-only extras — undefined on the hls.js/dash.js fallback wrappers.
    return (this.streamWrapper as any)?.isLive?.() ?? false;
  }

  /** True when the active adaptive stream is audio-only (no video track). */
  isStreamAudioOnly(): boolean {
    return (this.streamWrapper as any)?.isAudioOnly?.() ?? false;
  }

  /** Live-edge time of a live stream (seekable range end). */
  getLiveEdge(): number {
    return (this.streamWrapper as any)?.getLiveEdge?.() ?? this.getDuration();
  }

  /** Start of a live stream's seekable (DVR) window. */
  getSeekRangeStart(): number {
    return (this.streamWrapper as any)?.getSeekRangeStart?.() ?? 0;
  }

  /** Jump to the live edge of a live stream. */
  seekToLive(): void {
    const edge = this.getLiveEdge();
    if (isFinite(edge) && edge > 0) this.streamWrapper?.seek(edge);
  }

  /**
   * Add an external subtitle track after the source has loaded.
   *
   * The config path (`config.subtitleTracks`) is read once, when the source is
   * opened — everything that arrives later, a file the viewer picked among it,
   * had no way in short of reloading the video. Nothing else needs to change:
   * selectSubtitleLang() already fetches the URL on demand, so a `blob:` from
   * a picked File loads exactly like a hosted `.srt` does.
   *
   * `lang` is the key the menu and selectSubtitleLang() address a track by, so
   * an entry with an existing lang replaces it rather than adding a duplicate
   * the viewer cannot tell apart.
   */
  addSubtitleTrack(entry: SubtitleSourceEntry): void {
    const at = this._subtitleTracks.findIndex((t) => t.lang === entry.lang);
    if (at >= 0) this._subtitleTracks[at] = entry;
    else this._subtitleTracks.push(entry);
    Logger.info(TAG, `External subtitle added: ${entry.label} (${entry.lang})`);
  }

  /**
   * Add cues to a subtitle track that is being generated rather than loaded —
   * speech recognition writing captions as it goes is what this is for.
   *
   * The first call for a `lang` creates the track (it appears in the subtitle
   * menu like any other); later calls extend it. Cues may arrive in any order —
   * a recogniser that jumps to wherever the viewer seeked, then fills in the
   * rest — and are kept sorted; one that duplicates a cue already there (same
   * text, starting within a tenth of a second) is ignored, so overlapping
   * windows do not print a line twice. Empty or zero-length cues are dropped.
   *
   * If the track is the one showing, the new cues are on screen on the next
   * subtitle tick.
   *
   * `pending: true` with no cues lists the track before anything is known —
   * speech recognition warming up — and getSubtitleLangs() reports it as
   * pending until its first cue lands (or `pending: false` says there will be
   * none).
   */
  appendSubtitleCues(
    lang: string,
    label: string,
    cues: SubtitleCue[],
    pending?: boolean,
  ): void {
    let list = this._generatedSubCues.get(lang);
    if (!list) {
      list = [];
      this._generatedSubCues.set(lang, list);
      this.addSubtitleTrack({ url: "", lang, label, format: "vtt" });
    }
    let added = 0;
    for (const cue of cues) {
      const text = cue.text?.trim();
      if (!text || !(cue.end > cue.start)) continue;
      const dupe = list.some(
        (c) => c.text === text && Math.abs(c.start - cue.start) < 0.1,
      );
      if (dupe) continue;
      // Binary search for the insertion point — lists run to thousands.
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].start <= cue.start) lo = mid + 1;
        else hi = mid;
      }
      list.splice(lo, 0, { start: cue.start, end: cue.end, text });
      added++;
    }
    if (added || pending === false) this._pendingSubLangs.delete(lang);
    else if (pending && list.length === 0) this._pendingSubLangs.add(lang);
    // The renderer remembers which index it last drew; an insertion ahead of it
    // shifts that index onto a different cue, so restart it rather than leave
    // the wrong line up.
    if (added && this._activeSubtitleLang === lang) {
      this.startExternalSubtitles();
    }
  }

  /**
   * Take a generated track (see appendSubtitleCues) out of the menu, cues and
   * all, switching subtitles off if it was showing. False if there is none.
   */
  removeSubtitleCues(lang: string): boolean {
    if (!this._generatedSubCues.has(lang)) return false;
    return this.removeSubtitleTrack(lang);
  }

  /**
   * Take an external subtitle track (see addSubtitleTrack) out of the list,
   * switching subtitles off if it was showing. False if there is none.
   */
  removeSubtitleTrack(lang: string): boolean {
    if (!this._subtitleTracks.some((t) => t.lang === lang)) return false;
    if (this._activeSubtitleLang === lang) {
      this.stopExternalSubtitles();
      this._externalSubCues = [];
      this._activeSubtitleLang = "";
      this._cueSink()?.clearSubtitles();
      this.emit("subtitleTrackChange" as any, { lang: null, label: null });
    }
    this._generatedSubCues.delete(lang);
    this._pendingSubLangs.delete(lang);
    this._subtitleTracks = this._subtitleTracks.filter((t) => t.lang !== lang);
    return true;
  }

  /**
   * Get available external subtitle tracks
   */
  getSubtitleLangs(): {
    lang: string;
    label: string;
    active: boolean;
    pending?: boolean;
  }[] {
    return this._subtitleTracks.map((t) => ({
      lang: t.lang,
      label: t.label,
      active: t.lang === this._activeSubtitleLang,
      ...(this._pendingSubLangs.has(t.lang) ? { pending: true } : {}),
    }));
  }

  /**
   * Select an external subtitle track by language.
   * Fetches the VTT/SRT file, parses cues, and starts rendering.
   * Pass empty string or null to disable.
   */
  async selectSubtitleLang(lang: string | null): Promise<boolean> {
    // Disable current external subtitles
    this.stopExternalSubtitles();
    // An external ASS file may be what the host renderer was showing; whatever
    // is picked now replaces it (an in-band ASS track reconfigures it itself).
    this._releaseCustomRenderer();

    if (!lang) {
      this._activeSubtitleLang = "";
      this._cueSink()?.clearSubtitles();
      this.emit("subtitleTrackChange" as any, { lang: null, label: null });
      return true;
    }

    const track = this._subtitleTracks.find((t) => t.lang === lang);
    if (!track) {
      Logger.warn(TAG, `Subtitle track not found for lang: ${lang}`);
      return false;
    }

    // A generated track has nothing to fetch: its cues are already here, and
    // still arriving.
    const generated = this._generatedSubCues.get(lang);
    if (generated) {
      this._cueSink()?.setSubtitleFormat("vtt");
      this._externalSubCues = generated;
      this._activeSubtitleLang = lang;
      this.selectSubtitleTrack(null);
      this.startExternalSubtitles();
      this.emit("subtitleTrackChange" as any, { lang, label: track.label });
      return true;
    }

    try {
      // Fetch subtitle file
      const res = await fetch(track.url, { signal: this.lifetimeSignal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      // Detect format
      const fmt =
        track.format ||
        (/\.(ttml|dfxp)(\?|#|$)/i.test(track.url)
          ? "ttml"
          : track.url.includes(".srt")
            ? "srt"
            : "vtt");

      // A script with styling goes to the host's ASS renderer when there is
      // one: the plain-text path below would show its override tags as text.
      const ass = this._customSubtitleRenderer;
      if (
        (fmt === "ass" || /\.(ass|ssa)(\?|#|$)/i.test(track.url)) &&
        ass?.loadExternal
      ) {
        this._cueSink()?.setSubtitleCues([]);
        this._externalSubCues = [];
        this._activeSubtitleLang = lang;
        // Muxed subtitles off, without the renderer release that does.
        this.trackManager.selectSubtitleTrack(null);
        await ass.loadExternal(text, undefined);
        Logger.info(TAG, `ASS subtitle loaded: ${track.label}`);
        this.emit("subtitleTrackChange" as any, { lang, label: track.label });
        return true;
      }

      // Tell the renderer which format we're using so it can toggle the
      // VTT-only backdrop styling. TTML renders like plain text (VTT path).
      this._cueSink()?.setSubtitleFormat(
        fmt === "ttml" || fmt === "ass" ? "vtt" : fmt,
      );

      // Parse into cues
      this._externalSubCues =
        fmt === "srt"
          ? this.parseSRT(text)
          : fmt === "ttml"
            ? this.parseTTML(text)
            : this.parseVTT(text);

      this._activeSubtitleLang = lang;

      // Disable muxed subtitles if active
      this.selectSubtitleTrack(null);

      // Start cue timer
      this.startExternalSubtitles();

      Logger.info(
        TAG,
        `Subtitle loaded: ${track.label} (${this._externalSubCues.length} cues)`,
      );
      this.emit("subtitleTrackChange" as any, { lang, label: track.label });
      return true;
    } catch (e) {
      Logger.error(TAG, `Failed to load subtitle: ${track.url}`, e);
      return false;
    }
  }

  /** Parse VTT text into SubtitleCue[] */
  private parseVTT(text: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const blocks = text.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(
          /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/,
        );
        if (match) {
          const start =
            +match[1] * 3600 + +match[2] * 60 + +match[3] + +match[4] / 1000;
          const end =
            +match[5] * 3600 + +match[6] * 60 + +match[7] + +match[8] / 1000;
          const cueText = lines
            .slice(i + 1)
            .join("\n")
            .trim();
          if (cueText) cues.push({ start, end, text: cueText });
          break;
        }
      }
    }
    return cues;
  }

  /** Parse SRT text into SubtitleCue[] */
  private parseSRT(text: string): SubtitleCue[] {
    // SRT has same timestamp format but with comma instead of dot — parseVTT handles both
    return this.parseVTT(text);
  }

  /**
   * Parse TTML (Timed Text Markup Language, application/ttml+xml — what DASH
   * streams commonly ship, e.g. GPAC test vectors) into SubtitleCue[]. Reads
   * each <p>'s begin/end (or begin + dur) timing and its text, turning <br/>
   * into newlines and dropping styling tags. Namespace-agnostic (matches by
   * localName) so both `<p>` and `<tt:p>` work.
   */
  private parseTTML(text: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(text, "application/xml");
    } catch {
      return cues;
    }
    if (doc.getElementsByTagName("parsererror").length > 0) return cues;

    // "01:02:03.500" / "01:02:03:12" (frames) / "5s" / "1500ms" / "2m" / "1h".
    const parseTime = (raw: string | null): number => {
      if (!raw) return NaN;
      const t = raw.trim();
      const off = t.match(/^([\d.]+)(ms|h|m|s|f)$/);
      if (off) {
        const v = parseFloat(off[1]);
        return off[2] === "h"
          ? v * 3600
          : off[2] === "m"
            ? v * 60
            : off[2] === "ms"
              ? v / 1000
              : off[2] === "f"
                ? v / 30 // frames — assume 30fps (no frameRate context here)
                : v; // "s"
      }
      const p = t.split(":");
      if (p.length >= 3) {
        let sec =
          (+p[0] || 0) * 3600 + (+p[1] || 0) * 60 + (parseFloat(p[2]) || 0);
        if (p.length === 4) sec += (+p[3] || 0) / 30; // HH:MM:SS:frames
        return sec;
      }
      return NaN;
    };

    const extractText = (el: Element): string => {
      let out = "";
      el.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) out += n.textContent || "";
        else if (n.nodeType === Node.ELEMENT_NODE) {
          if ((n as Element).localName.toLowerCase() === "br") out += "\n";
          else out += extractText(n as Element);
        }
      });
      return out;
    };

    const paras = Array.from(doc.getElementsByTagName("*")).filter(
      (el) => el.localName.toLowerCase() === "p",
    );
    for (const p of paras) {
      const start = parseTime(p.getAttribute("begin"));
      let end = parseTime(p.getAttribute("end"));
      if (isNaN(end)) {
        const dur = parseTime(p.getAttribute("dur"));
        if (!isNaN(dur) && !isNaN(start)) end = start + dur;
      }
      const cueText = extractText(p)
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .trim();
      if (cueText && !isNaN(start) && !isNaN(end) && end > start) {
        cues.push({ start, end, text: cueText });
      }
    }
    return cues;
  }

  /** Start rendering external subtitle cues based on playback time */
  private startExternalSubtitles(): void {
    this.stopExternalSubtitles();
    let lastIdx = -1;
    this._externalSubTimer = window.setInterval(() => {
      const sink = this._cueSink();
      if (!sink) return;
      const time = this.streamWrapper
        ? this.streamWrapper.getCurrentTime()
        : this.clock.getTime();
      // Find active cue
      const idx = this._externalSubCues.findIndex(
        (c) => time >= c.start && time <= c.end,
      );
      if (idx !== lastIdx) {
        lastIdx = idx;
        if (idx >= 0) {
          sink.setSubtitleCues([this._externalSubCues[idx]]);
        } else {
          sink.setSubtitleCues([]);
        }
      }
      // No presentation loop behind a stream engine to expire the cue.
      if (this.streamWrapper) sink.refreshSubtitles();
    }, 100); // 10Hz check — enough for subtitle timing
  }

  /** Where external subtitle cues are painted: the stream engine's own canvas
   *  renderer when one is playing, Movi's otherwise. */
  private _cueSink(): CanvasRenderer | null {
    return this.streamWrapper
      ? this.streamWrapper.getCanvasRenderer()
      : this.videoRenderer;
  }

  /** Stop external subtitle rendering */
  private stopExternalSubtitles(): void {
    if (this._externalSubTimer !== null) {
      clearInterval(this._externalSubTimer);
      this._externalSubTimer = null;
    }
  }

  /**
   * Get playback rate
   */
  getPlaybackRate(): number {
    if (this.streamWrapper) {
      return this.streamWrapper.getPlaybackRate();
    }
    return this.clock.getPlaybackRate();
  }

  /**
   * Set subtitle delay in seconds.
   * VLC/mpv convention: positive value = subtitles appear later than the
   * original cue timing, negative value = earlier. Useful when the subtitle
   * track is out of sync with the video due to different source releases or
   * frame-rate conversions.
   */
  setSubtitleDelay(seconds: number): void {
    this._subtitleDelaySec = seconds;
    if (this._customSubtitleRenderer) {
      try {
        this._customSubtitleRenderer.setDelay(seconds);
      } catch {
        /* ignore */
      }
    }
    this._cueSink()?.setSubtitleDelay(seconds);
    // Non-zero delay needs cues from stream positions the demuxer hasn't
    // necessarily reached yet (negative delay) or has already passed
    // (positive delay across a seek). Prefetch the full cue list once so
    // the renderer cache is authoritative regardless of demuxer position.
    // Zero delay falls back to the streaming path — no prefetch overhead.
    if (seconds !== 0) {
      void this.prefetchActiveSubtitleStream();
    }
  }

  /** Get current subtitle delay in seconds. */
  getSubtitleDelay(): number {
    return this.videoRenderer ? this.videoRenderer.getSubtitleDelay() : 0;
  }

  /**
   * Register a pluggable subtitle renderer (or clear it with null) — e.g. jassub
   * (libass-wasm) for full ASS/SSA styling. While set, the active embedded
   * subtitle stream is routed to it (configure/pushPacket/render/…) instead of
   * the internal decoder, and its cues are suppressed. See SubtitleRenderer.
   */
  setSubtitleRenderer(renderer: SubtitleRenderer | null): void {
    if (this._customSubtitleRenderer === renderer) return;
    this._customSubtitleRenderer = renderer;
    this._stopSubtitleRenderLoop();
    // NB: the player never destroys the renderer — the registrar owns its
    // lifecycle (the element re-applies the same instance to a fresh player on a
    // source change, so destroying it here would kill it mid-swap).
    // Handing over or back: drop the internal decoder's cues so the two paths
    // never draw at once.
    this.videoRenderer?.setSubtitleCues([]);
    if (renderer) {
      this._mountCustomRenderer();
      try {
        renderer.setDelay(this._subtitleDelaySec);
      } catch {
        /* ignore */
      }
      void this._configureCustomSubtitleRenderer();
      this._startSubtitleRenderLoop();
    }
  }

  /**
   * The host renderer, when it takes this track. A renderer that implements
   * `accepts` can leave some tracks (SRT beside ASS) to the internal decoder.
   */
  private _customRendererFor(
    track: SubtitleTrack | null | undefined,
  ): SubtitleRenderer | null {
    const r = this._customSubtitleRenderer;
    if (!r || !track) return null;
    return r.accepts && !r.accepts(track) ? null : r;
  }

  /** Tell the host renderer what it was showing is no longer its. */
  private _releaseCustomRenderer(): void {
    try {
      this._customSubtitleRenderer?.release?.();
    } catch {
      /* ignore */
    }
  }

  // The font attachments of the open file, named and fetched on demand. One per
  // demuxer: a new file has new attachments.
  private _fontCatalog: FontCatalog | null = null;
  private _fontCatalogFor: Demuxer | null = null;

  private _fontCatalogForOpenFile(): FontCatalog | null {
    const demuxer = this.demuxer;
    const source = this.source;
    if (!demuxer || !source) return null;
    if (this._fontCatalog && this._fontCatalogFor === demuxer)
      return this._fontCatalog;
    // Read through the same source the demuxer uses: a font is a ranged read
    // into the file, never a second download of it.
    this._fontCatalog = new FontCatalog(
      demuxer.getAttachments(),
      async (offset, length) =>
        new Uint8Array(await source.read(offset, length)),
    );
    this._fontCatalogFor = demuxer;
    return this._fontCatalog;
  }

  /** (Re)configure the custom renderer for the active subtitle track. */
  private async _configureCustomSubtitleRenderer(): Promise<void> {
    const track = this.trackManager.getActiveSubtitleTrack();
    const r = this._customRendererFor(track);
    if (!r || !track || !this.demuxer) return;
    const extradata = this.demuxer.getExtradata(track.id) ?? undefined;
    // The fonts the script's styles name, out of the container's attachments —
    // not all of them (see FontCatalog). A `\fn` later in the events is
    // fetched through the same catalog when its event arrives.
    const catalog = this._fontCatalogForOpenFile();
    let fonts: Uint8Array[] | undefined;
    try {
      r.setFontSource?.(catalog);
      if (catalog && catalog.count > 0 && extradata) {
        fonts = await catalog.fontsFor(styleFontNames(extradata));
      }
    } catch (e) {
      Logger.warn(
        TAG,
        "Embedded fonts could not be read; using the default font",
        e,
      );
    }
    try {
      await r.configure(track, extradata, fonts);
    } catch (e) {
      Logger.error(TAG, "Custom subtitle renderer configure failed", e);
    }
  }

  private _startSubtitleRenderLoop(): void {
    if (
      this._subtitleRenderRAF !== null ||
      typeof requestAnimationFrame === "undefined"
    ) {
      return;
    }
    const tick = () => {
      this._subtitleRenderRAF = null;
      const r = this._customSubtitleRenderer;
      if (!r) return;
      const vt = this.trackManager.getActiveVideoTrack();
      // Raw media time — the renderer applies its own offset via setDelay().
      try {
        void r.render(this.clock.getTime(), vt?.width || 0, vt?.height || 0);
      } catch {
        /* a renderer hiccup shouldn't kill the loop */
      }
      this._subtitleRenderRAF = requestAnimationFrame(tick);
    };
    this._subtitleRenderRAF = requestAnimationFrame(tick);
  }

  private _stopSubtitleRenderLoop(): void {
    if (this._subtitleRenderRAF !== null) {
      cancelAnimationFrame(this._subtitleRenderRAF);
      this._subtitleRenderRAF = null;
    }
  }

  /**
   * Return every cue for the active subtitle stream, scanning it via the
   * C-side prefetch path if we haven't already done so. Used by the cues
   * browser UI — gives the caller a stable list to render and seek into.
   * Resolves to an empty array when no subtitle is active, the active
   * track is bitmap-only (PGS), or scanning fails.
   */
  async getAllSubtitleCues(): Promise<
    { start: number; end: number; text: string }[]
  > {
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (!subtitleTrack) return [];
    if (subtitleTrack.subtitleType && subtitleTrack.subtitleType !== "text")
      return [];
    if (this.prefetchedSubtitleStream !== subtitleTrack.id) {
      await this.prefetchActiveSubtitleStream();
    }
    if (!this.videoRenderer) return [];
    // The renderer's cue cache is the canonical post-prefetch source —
    // prefetchActiveSubtitleStream pushes the full list into it via
    // setSubtitleCues. Reading it back avoids holding a duplicate copy
    // on MoviPlayer.
    return this.videoRenderer.getAllCues();
  }

  /**
   * Scan the active subtitle stream and seed the renderer with every cue.
   * No-op when the same stream has already been prefetched, when no
   * subtitle is selected, or when a prefetch is in flight. The demuxer is
   * left at EOF after the C-side scan, so we re-seek back to the current
   * playback position before returning.
   */
  private async prefetchActiveSubtitleStream(): Promise<void> {
    if (this.prefetchInFlight) return;
    if (!this.demuxer || !this.videoRenderer) return;
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (!subtitleTrack) return;
    if (this.prefetchedSubtitleStream === subtitleTrack.id) return;
    const bindings = this.demuxer.getBindings();
    if (!bindings) return;
    // Only support text subtitles — bitmap (PGS/dvd_subtitle) decoding
    // returns image data, which the prefetch text path can't carry across
    // and which the user-shift UI doesn't apply to anyway.
    if (subtitleTrack.subtitleType && subtitleTrack.subtitleType !== "text")
      return;

    this.prefetchInFlight = true;
    const resumeTime = this.clock.getTime();
    const wasPlaying = this.stateManager.getState() === "playing";

    // Quiesce all paths that touch the demuxer/decoders. Without this the
    // prefetch's seek-to-0 + sequential reads race the playback processLoop
    // (which is already mid-readPacket via Asyncify), corrupting the
    // js_read_async pending-read state and stalling playback indefinitely
    // ("No pending read to fulfill").
    this.stopPauseBuffering();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    // Bumping the seek session ID forces any in-flight processLoop iteration
    // to bail out at its next checkpoint instead of writing stale results.
    this.seekSessionId++;
    // Release a superseded seek's video-sync flag — this prefetch does its own
    // re-seek + resume below, so a lingering wait would strand the pipeline in a
    // permanent loading state (see notifySeekCompletion's superseded branch).
    this.waitingForVideoSync = false;
    if (wasPlaying) {
      this.clock.pause();
      if (!this.disableAudio) this.audioRenderer.pause();
      if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
    }
    // Wait for any demuxer call already in flight to land before we issue
    // our own. Asyncify won't let two reads/seeks overlap on the same
    // context; this poll is short because js_read_async resolves within a
    // single rAF once the JS side delivers the buffer.
    const maxWaitMs = 2000;
    const waitStart = performance.now();
    while (this.demuxInFlight && performance.now() - waitStart < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 10));
    }

    try {
      Logger.info(
        TAG,
        `Prefetching subtitle cues for stream ${subtitleTrack.id}...`,
      );
      const cues = await bindings.prefetchSubtitleCues(subtitleTrack.id);
      if (cues && cues.length > 0) {
        // Seed the renderer's cache with every cue at once. The renderer
        // already maintains an active-cue cursor that re-evaluates against
        // the current adjusted time, so we don't need a separate "play
        // from cache" mode — the existing display path just works.
        this.videoRenderer.setSubtitleCues(cues);
        this.prefetchedSubtitleStream = subtitleTrack.id;
        Logger.info(
          TAG,
          `Prefetched ${cues.length} subtitle cues for stream ${subtitleTrack.id}`,
        );
      } else {
        Logger.warn(
          TAG,
          `Subtitle prefetch returned no cues for stream ${subtitleTrack.id}`,
        );
      }

      // The C-side scan leaves the demuxer at EOF. Re-seek back to where
      // playback should be so the audio/video pipeline can keep going.
      // Flush decoders + clear queue since the demuxer is in an
      // undefined-for-playback state.
      await this.videoDecoder.flush();
      await this.audioDecoder.flush();
      if (this.videoRenderer) this.videoRenderer.clearQueue();
      this.audioRenderer.reset();
      await this.demuxer.seek(resumeTime, 1, this.getSeekStreamIndex());
      this.clock.seek(resumeTime);
      this.clearPacketQueues();
      this.resetEof();
    } catch (err) {
      Logger.error(TAG, "Subtitle prefetch failed", err);
    } finally {
      this.prefetchInFlight = false;
    }

    // Resume audio/video pipelines if we paused them above. We bypass the
    // public play() because the player's state is still "playing" — we
    // only paused the underlying clocks/decoders and need to nudge them
    // back without the full first-play song-and-dance.
    if (wasPlaying) {
      try {
        if (!this.disableAudio) await this.audioRenderer.play();
        if (this.videoRenderer) this.videoRenderer.startPresentationLoop();
        this.clock.start();
        // Re-arm the seek-target guard (filter-only, not waitingForVideoSync)
        // so any pre-target frames produced by Open-GOP recovery after the
        // resumeTime seek get dropped without firing notifySeekCompletion's
        // state transitions.
        this.seekTargetTime = resumeTime;
        this.animationFrameId = requestAnimationFrame(this.processLoop);
        this.requestWakeLock();
      } catch (err) {
        Logger.error(TAG, "Failed to resume after subtitle prefetch", err);
      }
    } else {
      // Even when paused, kick off pause-time buffering again so the
      // demuxer keeps reading ahead behind the scenes (HTTP sources only).
      this.startPauseBuffering();
    }
  }

  /**
   * Set volume (0-1)
   */
  setVolume(volume: number): void {
    if (this.streamWrapper) {
      this.streamWrapper.setVolume(volume);
    }
    this.audioRenderer.setVolume(volume);
  }

  /**
   * Take the sound down a slope, for a player that is about to go away.
   *
   * See AudioRenderer.fadeOut. An adaptive stream's audio comes out of a media
   * element rather than our gain node, so there is nothing to ramp — it is
   * stepped down instead, often enough that the ear hears a slope and not a
   * staircase.
   */
  fadeOutAudio(durationMs: number = 200): void {
    this.audioRenderer.fadeOut(durationMs);
    const wrapper = this.streamWrapper;
    if (!wrapper) return;
    const from = this.audioRenderer.getVolume?.() ?? 1;
    const steps = Math.max(4, Math.round(durationMs / 25));
    for (let i = 1; i <= steps; i++) {
      setTimeout(
        () => {
          try {
            wrapper.setVolume(Math.max(0, from * (1 - i / steps)));
          } catch {
            /* the stream is already gone */
          }
        },
        (durationMs * i) / steps,
      );
    }
  }

  /**
   * Get volume (0-1)
   */
  getVolume(): number {
    if (this.streamWrapper) {
      return this.streamWrapper.getVolume();
    }
    return this.audioRenderer.getVolume();
  }

  /**
   * Set muted state
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return; // No change

    this.muted = muted;
    if (this.streamWrapper) {
      this.streamWrapper.setMuted(muted);
      return;
    }

    // Was the audio being thrown away? Read it BEFORE unmute() flips the state.
    // While muted with a browser-suspended context every decoded audio frame is
    // dropped, so there is no audio for the picture on screen — the decoder has
    // run on ahead with the demuxer, a video buffer's worth past the presented
    // frame. See the re-sync below.
    const wasDroppingAudio = this.audioRenderer.isDroppingAudio();

    if (muted) {
      this.audioRenderer.mute();
    } else {
      // unmute() is async (initializes AudioContext on first unmute) but we
      // don't await it to keep setMuted() synchronous. Call it FIRST so its
      // AudioContext.resume() claims the tap's user activation before anything
      // else can: on Safari the wake-lock request below consumes the transient
      // activation, and if it ran first the resume would be denied — leaving the
      // shared context suspended and re-showing "tap to unmute" on the next video.
      const unmuted = this.audioRenderer.unmute().catch((err) => {
        Logger.error("MoviPlayer", "Failed to unmute", err);
      });
      // Tap-to-unmute is also a good moment to (re)acquire the screen wake lock,
      // which muted autoplay couldn't get without a gesture. Best-effort, after
      // unmute — losing the activation to it here is harmless; losing audio isn't.
      this.ensureWakeLock();

      // The audio for this moment is gone — dropped, frame by frame, while the
      // context was suspended. What the decoder holds now belongs to the
      // demuxer's read position, one video buffer AHEAD of the frame on screen.
      // Let that start playing and the clock, which audio masters, jumps
      // forward with it: the viewer hears a second or two of audio from the
      // future while the picture sits still, then the video catches up. That is
      // the "1-3s of audio, then video continues" on tap-to-unmute.
      //
      // The only way to get the audio for the current position is to read it
      // again, which is a seek — to exactly where we already are, so nothing is
      // lost but the re-read, and the bytes are still in the source's buffer.
      if (wasDroppingAudio && this.stateManager.getState() === "playing") {
        // Hold the output silent across the re-read. The resume has to ride the
        // tap, but what it makes audible is the decoder's position, not the
        // picture's — so the viewer got a second of the wrong moment, then a
        // seek, then the right one. Silent through the correction, audible when
        // it lands: one transition instead of three.
        this.audioRenderer.silenceForResync();
        // Where the picture is, read NOW — before the resume, not after it.
        //
        // A suspended AudioContext freezes its own currentTime, and the audio
        // clock is a mapping off that, so it goes on reporting the position
        // where the context went to sleep. While the audio was being dropped
        // nothing masters off it and the clock tracks the picture; the moment
        // the context is running again the clock snaps to that stale audio
        // position instead. Sampling the target inside the .then() therefore
        // sampled it AFTER the snap, and the seek dutifully took the picture
        // back to where the audio had been asleep. Measured: picture at 8.48s,
        // audio clock still reading 5.09s, and the tap sent playback back to
        // 4.31s — a four-second jump backwards, and then the race forwards to
        // catch up with the sound.
        const pictureAt = this.getCurrentTime();
        // …and keep the clock off the audio until the re-read has landed. The
        // context resuming is enough for the clock to sync to the audio clock —
        // still frozen where the context went to sleep, 0s on an autoplay that
        // was muted from the start — so the seek below began by pausing the
        // clock at 0:00, and the time and the bar sat at zero for the whole
        // re-read before jumping back. Unmastered, the clock runs on the wall
        // and tracks the picture, which is exactly what it did while the audio
        // was being dropped; it is handed back to the audio once the audio is
        // anchored where the picture is.
        this.clock.setAudioProvider(null);
        const remasterClock = () => {
          if (!this.disableAudio && !this._destroyed) {
            this.clock.setAudioProvider(this.audioRenderer);
          }
        };
        // …but the SEEK only once the context is RUNNING. Seeking first put the re-read
        // audio on an anchor that the "running" statechange then discarded,
        // and every buffer decoded in between was already late against a wall
        // clock that had walked the picture on: ~2s of silent video, then a
        // 2036ms drift correction to catch up. Racing a short timeout so a
        // resume that never settles can't swallow the correction entirely.
        void Promise.race([
          unmuted,
          new Promise((r) => setTimeout(r, MoviPlayer.UNMUTE_RESUME_WAIT_MS)),
        ]).then(() => {
          if (this.muted || this.stateManager.getState() !== "playing") {
            this.audioRenderer.releaseResyncSilence();
            remasterClock();
            return;
          }
          Logger.info(
            TAG,
            `Unmute: audio was being dropped — re-reading from ${pictureAt.toFixed(2)}s (where the picture was at the tap) so it lands with it`,
          );
          // Machinery, not a seek the viewer asked for: no spinner, no
          // seeking/seeked for the page, and it lands playing. It re-reads what
          // is already in the source's buffer, at the frame already on screen —
          // a loading ring over that read as the tap having broken something.
          this.seek(pictureAt, {
            internal: true,
            suppressSpinner: true,
            preservePlaying: true,
          })
            // Whatever happens — landed, failed, superseded — the hold has to
            // come off, or tap-to-unmute ends in permanent silence; and the
            // clock goes back to the audio, or it runs on the wall for good.
            .catch(() => {})
            .finally(() => {
              this.audioRenderer.releaseResyncSilence();
              remasterClock();
            });
        });
      }
    }
  }

  /**
   * Get muted state
   */
  getMuted(): boolean {
    return this.muted;
  }

  /**
   * Enable/disable stable audio mode
   * Stable audio provides: smooth gain transitions, auto-recovery,
   * gap filling on underrun, starvation detection, and fade on seek/reset
   */
  setStableAudio(enabled: boolean): void {
    this.audioRenderer.setStableAudio(enabled);
  }

  /** Stall the two streams together, either way round: see _bindAV. */
  setBindAV(enabled: boolean): void {
    this._bindAV = enabled;
  }

  /** Hidden does not mean unwatched: see _backgroundPlay. */
  setBackgroundPlay(enabled: boolean): void {
    this._backgroundPlay = enabled;
  }

  getBackgroundPlay(): boolean {
    return this._backgroundPlay;
  }

  getBindAV(): boolean {
    return this._bindAV;
  }

  /**
   * Get stable audio mode state
   */
  getStableAudio(): boolean {
    return this.audioRenderer.getStableAudio();
  }

  /**
   * Get comprehensive player stats for "Stats for nerds" overlay
   */
  /**
   * Raw render-health numbers for the stutter-hint monitor — distinct from
   * getStats(), which formats display strings. framesPresented is cumulative
   * (resets to 0 on seek/reset), so callers must handle it going backwards.
   * Null when there's no video renderer (audio-only / adaptive streams).
   */
  getRenderHealth(): {
    framesPresented: number;
    sourceFps: number;
    hostContended: boolean;
  } | null {
    if (!this.videoRenderer || this.streamWrapper) return null;
    const vt = this.trackManager.getActiveVideoTrack() as VideoTrack | null;
    return {
      framesPresented: this.videoRenderer.getStats().framesPresented,
      sourceFps: vt?.frameRate && vt.frameRate > 0 ? vt.frameRate : 30,
      hostContended: this.videoRenderer.isHostContended(),
    };
  }

  /**
   * What this source needs, in BITS per second, to arrive in real time.
   *
   * Total bytes over duration, not the video track's declared bitrate: a remux
   * carries every audio track and every subtitle in the same container, and the
   * demuxer reads the lot — on the 40GB file this was written for, five audio
   * tracks including TrueHD Atmos. What has to come down the wire is the file,
   * so the file is what the figure is taken from. Declared per-track bitrates
   * would answer a question nobody is asking, and MKV often omits them anyway.
   *
   * 0 when it cannot be known — a local file, or a source that has not resolved
   * its size — which is the signal to say nothing rather than guess.
   *
   * Deliberately NOT paired with a throughput accessor here. The ABR's reading
   * is a floor once the source parks at the prefetch gate, and publishing it
   * beside this invites exactly the comparison that cried wolf twice; the link
   * side of the question belongs to probeLinkBandwidth.
   */
  requiredLinkBps(): number {
    const bytes =
      (
        this.source as { getKnownSize?: () => number } | null
      )?.getKnownSize?.() ?? 0;
    const duration = this.getDuration();
    if (!(bytes > 0) || !(duration > 0)) return 0;
    return (bytes * 8) / duration;
  }

  /**
   * Is the DEVICE the bottleneck right now, rather than the delivery?
   *
   * The link notice needs this because its only other evidence is that
   * playback stopped, and a decoder that cannot keep up stops playback too —
   * the catch-up hold does it on purpose ("holding sound and clock for it").
   * Without this, a slow decoder on a heavy file would arm a verdict about the
   * connection, and a probe that happens to read low while competing with the
   * player's own streaming would then blame the link for the device's problem.
   * That is the same wrong-cause-named mistake the notice already made twice,
   * arriving from the third direction.
   *
   * Two answers, cheapest first. Self-inflicted buffering is the player's own
   * doing by definition, so it is never the link. The renderer's decode-bound
   * verdict is the settled judgement.
   *
   * Used only to hold a notice back, so a false positive here costs nothing but
   * silence, which is the right way to be wrong about this.
   */
  deviceIsBottleneck(): boolean {
    return (
      this._bufferingSelfInflicted ||
      (this.videoRenderer?.isDecodeBound?.() ?? false)
    );
  }

  /**
   * True once the renderer has judged this device unable to decode the current
   * rung at all (near-zero frames presented while audio flows). Callers use it
   * to tell "the pipeline is stuck" apart from "the decoder is simply too slow"
   * — the recovery for the first (a corrective re-prime seek) is actively
   * harmful for the second.
   */
  isDecodeBound(): boolean {
    return this.videoRenderer?.isDecodeBound?.() ?? false;
  }

  /**
   * Did the DELIVERY run dry just now — a read waiting on bytes the network
   * had not brought yet?
   *
   * deviceIsBottleneck answers the other half of the question and cannot
   * answer this one: it reads how fast the picture reaches the screen, and a
   * picture can run slow for reasons that never stop playback. From an 8K60
   * AV1 file on Google Drive: the host page held rAF to ~40/s, the picture
   * presented ~32fps, deviceIsBottleneck said "device" — and every stall in
   * the session was the sound running out because the next bytes had not
   * arrived. Those stalls were never counted against the link, so the notice
   * that the file needs 41 Mbps never came. A stall with a read parked on the
   * network is the delivery's, whatever the picture is doing.
   */
  deliveryStarved(
    withinMs: number = MoviPlayer.DELIVERY_STARVED_WINDOW_MS,
  ): boolean {
    const at =
      (
        this.source as { lastNetworkWait?: () => number } | null
      )?.lastNetworkWait?.() ?? 0;
    return at > 0 && performance.now() - at < withinMs;
  }
  private static readonly DELIVERY_STARVED_WINDOW_MS = 3000;

  /** The best rate the media has actually arrived at from this source,
   *  BITS/second, or -1 — see HttpSource.bestDeliveryBps. */
  /** What has actually been arriving, on average, over the last half minute
   *  of active streaming — BITS/second, or -1. The honest "is the link
   *  keeping up" figure; deliveryRateBps is the kinder one to quote. */
  sustainedDeliveryBps(): number {
    const src = this.source as {
      recentDeliveryBps?: (windowMs?: number, minMs?: number) => number;
    } | null;
    return src?.recentDeliveryBps?.(30_000, 5_000) ?? -1;
  }

  deliveryRateBps(): number {
    const src = this.source as {
      bestDeliveryBps?: () => number;
      recentDeliveryBps?: () => number;
    } | null;
    const best = src?.bestDeliveryBps?.() ?? -1;
    return best > 0 ? best : (src?.recentDeliveryBps?.() ?? -1);
  }

  getStats(): Record<string, string | number | boolean> {
    // HLS mode: delegate to HLS wrapper
    if (this.streamWrapper) {
      return this.streamWrapper.getStats();
    }

    const mediaInfo = this.mediaInfo;
    const videoTrack =
      this.trackManager.getActiveVideoTrack() as VideoTrack | null;
    const audioTrack =
      this.trackManager.getActiveAudioTrack() as AudioTrack | null;
    const videoDecoderStats = this.videoDecoder.getStats();
    const audioDecoderStats = this.audioDecoder.getStats();
    const rendererStats = this.videoRenderer?.getStats();
    const audioBuffered = this.audioRenderer.getBufferedDuration();

    const stats: Record<string, string | number | boolean> = {};

    // Video info
    if (videoTrack) {
      stats["Video Codec"] = videoTrack.codec ?? "N/A";
      stats["Resolution"] = `${videoTrack.width}x${videoTrack.height}`;
      // Quality label — classify by the larger of actual height and the
      // 16:9-normalised height (width * 9 / 16). Cinematic / ultrawide
      // sources letterbox horizontally, so a 3840×2080 cut of 4K UHD
      // would otherwise misreport as "2K" purely because its pixel
      // height is < 2160.
      const h = videoTrack.height;
      const eff = Math.max(h, Math.round((videoTrack.width * 9) / 16));
      stats["Quality"] =
        eff >= 8640
          ? "16K"
          : eff >= 4320
            ? "8K"
            : eff >= 2160
              ? "4K"
              : eff >= 1440
                ? "2K"
                : eff >= 1080
                  ? "1080p"
                  : eff >= 720
                    ? "720p"
                    : eff >= 480
                      ? "480p"
                      : "SD";
      stats["Frame Rate"] = `${videoTrack.frameRate} fps`;
      stats["Video Bitrate"] = videoTrack.bitRate
        ? `${(videoTrack.bitRate / 1000).toFixed(0)} kbps`
        : "N/A";
      if (videoTrack.pixelFormat)
        stats["Pixel Format"] = videoTrack.pixelFormat;
      stats["Color Space"] = videoTrack.colorSpace ?? "N/A";
      if (videoTrack.colorRange) stats["Color Range"] = videoTrack.colorRange;
      if (
        videoTrack.colorPrimaries &&
        videoTrack.colorPrimaries !== "unknown"
      ) {
        stats["Color Primaries"] = videoTrack.colorPrimaries;
      }
      if (videoTrack.colorTransfer && videoTrack.colorTransfer !== "unknown") {
        stats["Color Transfer"] = videoTrack.colorTransfer;
      }
      stats["HDR"] = videoTrack.isHDR ? "Yes" : "No";
      if (videoTrack.rotation) stats["Rotation"] = `${videoTrack.rotation}°`;
      stats["Video Decoder"] = videoDecoderStats.decoderType;
    }

    // Audio info
    if (audioTrack) {
      stats["Audio Codec"] = audioTrack.codec ?? "N/A";
      if (audioTrack.language && audioTrack.language !== "und") {
        stats["Language"] = audioTrack.language.toUpperCase();
      }
      stats["Sample Rate"] = `${audioTrack.sampleRate} Hz`;
      stats["Channels"] =
        audioTrack.channels === 1
          ? "Mono"
          : audioTrack.channels === 2
            ? "Stereo"
            : audioTrack.channels === 6
              ? "5.1 Surround"
              : audioTrack.channels === 8
                ? "7.1 Surround"
                : `${audioTrack.channels}ch`;
      stats["Audio Bitrate"] = audioTrack.bitRate
        ? `${(audioTrack.bitRate / 1000).toFixed(0)} kbps`
        : "N/A";
      stats["Audio Decoder"] = audioDecoderStats.decoderType;
      if (audioDecoderStats.softwareFallbackReason) {
        stats["Audio Software Fallback Reason"] =
          audioDecoderStats.softwareFallbackReason;
      }
    }

    // Subtitle info
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (subtitleTrack) {
      stats["Subtitle"] =
        `${subtitleTrack.codec ?? "text"}${subtitleTrack.language ? ` (${subtitleTrack.language.toUpperCase()})` : ""}`;
    }

    // Container
    if (mediaInfo) {
      stats["Container"] = mediaInfo.formatName ?? "N/A";
      stats["Total Bitrate"] = mediaInfo.bitRate
        ? `${(mediaInfo.bitRate / 1000).toFixed(0)} kbps`
        : "N/A";
    }

    // Playback
    const playbackState = this.stateManager.getState();
    const clockRunning = this.clock.isPlaying();
    stats["Playback State"] = playbackState;
    stats["Master Clock"] = clockRunning ? "Running" : "Stopped";
    stats["Playback Invariant"] =
      playbackState === "playing" && !clockRunning ? "VIOLATION" : "OK";
    stats["Playback Rate"] = `${this.clock.getPlaybackRate()}x`;
    stats["A/V Sync"] = this.clock.isSyncedToAudio()
      ? "Audio Master"
      : "Wall Clock";
    stats["Stable Volume"] = this.audioRenderer.getStableAudio() ? "On" : "Off";
    stats["Decode Path"] = this.isSoftwareHeavyDecoding()
      ? "Software-heavy"
      : "Hardware/native";

    // Buffers
    stats["Audio Buffer"] = `${audioBuffered.toFixed(2)}s`;
    stats["Audio Buffered Seconds"] = Number(audioBuffered.toFixed(3));
    const audioUnderrunning = this.audioRenderer.isUnderrunning();
    stats["Audio Underrunning"] = audioUnderrunning ? "Yes" : "No";
    stats["Audio Underrun Risk"] =
      audioUnderrunning || audioBuffered < 0.1
        ? "High"
        : audioBuffered < 0.5
          ? "Medium"
          : "Low";
    stats["Video Queue"] = `${rendererStats?.frameQueueSize ?? 0} frames`;
    stats["Frames Rendered"] = rendererStats?.framesPresented ?? 0;
    stats["Video Decoder Queue"] = videoDecoderStats.queueSize;
    stats["Audio Decoder Queue"] = audioDecoderStats.queueSize;
    stats["Seek Waiting For Video"] = this.waitingForVideoSync ? "Yes" : "No";
    stats["Seek Audio Hold Packets"] = this.waitingForVideoSync
      ? this.audioQueue.length
      : 0;
    stats["Seek Demux Ahead"] =
      this.waitingForVideoSync && this.seekDemuxAheadTime >= 0
        ? `${(this.seekDemuxAheadTime - this.seekTargetTime).toFixed(1)}s / ${MoviPlayer.SEEK_MAX_DEMUX_AHEAD_SECONDS}s`
        : "—";
    stats["Pause Prebuffer Packets"] = this.stateManager.is("paused")
      ? this.videoQueue.length + this.audioQueue.length
      : 0;
    if (audioDecoderStats.worker) {
      stats["Audio Worker Generation"] = audioDecoderStats.worker.generation;
      stats["Audio Worker Track"] = audioDecoderStats.worker.trackId;
      stats["Audio Worker Queue Depth"] = audioDecoderStats.worker.queueDepth;
      stats["Audio Worker In Flight"] = audioDecoderStats.worker.inFlight;
      stats["Audio Worker Reorder Backlog"] =
        audioDecoderStats.worker.reorderBacklog;
      stats["Audio Worker Stale Drops"] =
        audioDecoderStats.worker.droppedStaleMessages;
      stats["Audio Worker Configure State"] =
        audioDecoderStats.worker.configureState;
      stats["Audio Worker Configure ms"] = audioDecoderStats.worker.configureMs;
      stats["Audio Worker Configure Timeout ms"] =
        audioDecoderStats.worker.configureTimeoutMs;
      if (audioDecoderStats.worker.lastError) {
        stats["Audio Worker Last Error"] = audioDecoderStats.worker.lastError;
      }
    }

    // Memory usage (Chrome only)
    const mem = (performance as any).memory;
    if (mem) {
      stats["Memory Used"] = `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`;
      stats["Memory Limit"] =
        `${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB`;
    }

    // File
    if (this.fileSize > 0) {
      stats["File Size"] =
        this.fileSize > 1048576
          ? `${(this.fileSize / 1048576).toFixed(1)} MB`
          : `${(this.fileSize / 1024).toFixed(1)} KB`;
    }

    // Network (HttpSource) or Disk (FileSource) stats
    if (this.source instanceof HttpSource) {
      const net = this.source.getNetworkStats();
      stats["Downloaded"] =
        net.totalBytes > 1048576
          ? `${(net.totalBytes / 1048576).toFixed(1)} MB`
          : `${(net.totalBytes / 1024).toFixed(1)} KB`;
      stats["Network Speed"] =
        net.currentSpeed > 0
          ? net.currentSpeed > 1048576
            ? `${(net.currentSpeed / 1048576).toFixed(1)} MB/s`
            : `${(net.currentSpeed / 1024).toFixed(0)} KB/s`
          : "—";
      stats["Connection Time"] = `${net.elapsed.toFixed(1)}s`;
    } else if (this.source instanceof FileSource) {
      const disk = this.source.getDiskStats();
      stats["Disk Read"] =
        disk.totalBytes > 1048576
          ? `${(disk.totalBytes / 1048576).toFixed(1)} MB`
          : `${(disk.totalBytes / 1024).toFixed(1)} KB`;
      stats["Read Speed"] =
        disk.currentSpeed > 0
          ? disk.currentSpeed > 1048576
            ? `${(disk.currentSpeed / 1048576).toFixed(1)} MB/s`
            : `${(disk.currentSpeed / 1024).toFixed(0)} KB/s`
          : "—";
    }

    return stats;
  }

  /**
   * Get current I/O throughput in bytes/sec (for graph)
   * Works for both network (HttpSource) and disk (FileSource)
   */
  getNetworkSpeed(): number {
    // HLS mode: delegate to HLS wrapper
    if (this.streamWrapper) {
      return this.streamWrapper.getNetworkSpeed();
    }
    // EncryptedHttpSource extends HttpSource, so the HttpSource branch
    // covers encrypted playback too.
    if (this.source instanceof HttpSource) {
      return this.source.getNetworkStats().currentSpeed;
    }
    if (this.source instanceof FileSource) {
      return this.source.getDiskStats().currentSpeed;
    }
    return 0;
  }

  /**
   * Check if source is a local file
   */
  isFileSource(): boolean {
    if (this.streamWrapper) return false;
    return this.source instanceof FileSource;
  }

  /**
   * True when the active source has fallen back to linear (forward-only,
   * non-seekable) playback — server lacks HTTP Range support and the file is
   * too big to cache whole. Used by the UI as a backstop alongside the
   * "linearmode" event (in case the event fired before listeners attached).
   */
  isLinearPlayback(): boolean {
    const src = this.source as { isLinearMode?: () => boolean } | null;
    return typeof src?.isLinearMode === "function" ? src.isLinearMode() : false;
  }

  /**
   * True when audio is blocked by the browser's autoplay policy — the
   * AudioContext is stuck suspended despite an unmuted play() because no
   * user gesture has unlocked it. play()'s promise resolves either way, so
   * the element polls this after autoplay to decide whether to fall back to
   * muted playback + a "Tap to unmute" pill.
   */
  isAudioBlockedSuspended(): boolean {
    if (this.streamWrapper) return false;
    if (this.disableAudio) return false;
    return this.audioRenderer.isBlockedSuspended();
  }

  /**
   * True once the shared AudioContext has been unlocked at any point this
   * session. A subsequent suspended state (e.g. right after init() on an
   * auto-advanced track) is then just a resume in flight that will recover, so
   * the element waits it out instead of flashing the unmute pill.
   */
  wasAudioContextActivated(): boolean {
    if (this.disableAudio) return false;
    return this.audioRenderer.wasEverActivated();
  }

  /**
   * True when the browser will refuse to start audio now — no gesture on the
   * page yet and nothing unlocked this session. The element then skips the
   * wait for a warm-up that cannot come.
   */
  isAudioStartRefused(): boolean {
    if (this.disableAudio) return false;
    return this.audioRenderer.isStartRefused();
  }

  /** True when audio-only (data-saver) mode is active. */
  isAudioOnly(): boolean {
    return this._audioOnly;
  }

  /**
   * Toggle audio-only (data-saver) mode at runtime. On the demuxer path the
   * processLoop stops decoding video (CPU saving) — re-enabling re-seeks to
   * recover a keyframe and resume video in sync. Adaptive streams drop/restore
   * video renditions via a reload (config.audioOnly), so this only flips the
   * flag for them; the caller (MoviElement) owns that reload.
   */
  setAudioOnly(enabled: boolean): void {
    if (this._audioOnly === enabled) return;
    this._audioOnly = enabled;
    // Captions are not part of the picture, and they are the one thing on
    // screen that still has to keep time while it is gone.
    this.videoRenderer?.setPictureSuspended(enabled);
    if (this.streamWrapper) {
      // Adaptive streams: the wrapper picks an audio-only / smallest-video
      // variant live (no reload, so the stream — and its LIVE state — survives).
      (this.streamWrapper as any).setAudioOnly?.(enabled);
      return;
    }

    // Separate audio drives playback independently of the main (video) demux
    // loop — either the native <audio> element OR the WASM split-audio demuxer.
    // Either way, audio-only can stop the main loop entirely (video body stops
    // downloading + decoding) while audio keeps playing on its own path.
    const splitSource = !!this.audioDemuxer;

    if (enabled) {
      // Freeze the video surface cleanly — drop queued + on-screen frames so the
      // UI can swap to the album-art / strip view without a stale last frame.
      if (this.videoRenderer) this.videoRenderer.clearQueue();
      if (splitSource) {
        // Split source: stop the demux loop entirely so the video body stops
        // downloading + decoding. The native <audio> keeps playing on its own.
        // (Doing this live — never via a reload — avoids tearing down the WASM
        // context while a read is in flight, which crashes with an OOB.)
        if (this.animationFrameId !== null) {
          cancelAnimationFrame(this.animationFrameId);
          this.animationFrameId = null;
        }
        this.stopPauseBuffering();
      }
      // Muxed source: keep the demux loop running (it still decodes the in-file
      // audio); the processLoop's _audioOnly check skips only the video decode.
    } else {
      // Re-enabling video. Resume the video source prefetch that audio-only
      // paused (idempotent no-op if it wasn't paused), then bring the picture
      // back to where the sound already is.
      //
      // This used to be a plain seek() to the playhead, and a seek serves BOTH
      // pipelines: the audio renderer's scheduled buffers were dropped and
      // rebuilt, so the sound broke at the exact moment the viewer asked for
      // the picture back. Nothing about audio needs to move here — it never
      // stopped. This is the same situation as returning from a backgrounded
      // tab, where video decode was skipped while audio played on, and it takes
      // the same video-only recovery.
      this.setVideoSourcePrefetchPaused(false);
      if (this.stateManager.getState() === "playing") {
        void this.resyncVideoToAudio("Audio-only → video");
      } else {
        // Paused: there is no audio clock to catch up to and no loop to
        // restart, so put a frame back on screen the ordinary way.
        this.seek(this.getCurrentTime()).catch((e) =>
          Logger.warn(TAG, "Audio-only → video resync seek failed", e),
        );
      }
    }
  }

  /**
   * True when the active source is not a FileSource (gate inactive), or when
   * the FileSource's initial preload pass has settled.
   */
  isFileSourcePreloadComplete(): boolean {
    if (!(this.source instanceof FileSource)) return true;
    return this.source.isPreloadComplete();
  }

  /**
   * Public accessor for the mobile-device flag (used by MoviElement to gate
   * UI behavior on mobile-only paths).
   */
  static isMobileDevice(): boolean {
    return MoviPlayer._isMobileDevice;
  }

  /**
   * Request WakeLock to prevent screen sleep
   */
  private async requestWakeLock(retry: number = 1): Promise<void> {
    // Check if WakeLock API is available
    if (!("wakeLock" in navigator)) {
      Logger.debug(TAG, "WakeLock API not available");
      return;
    }

    // The Screen Wake Lock API rejects (NotAllowedError) unless the page is
    // visible — don't even attempt while hidden. It's the wrong moment, not a
    // fault; handleVisibilityChange re-requests once the tab is shown.
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      Logger.debug(TAG, "WakeLock skipped — page not visible");
      return;
    }

    try {
      // Release existing wakeLock if any
      if (this.wakeLock) {
        await this.releaseWakeLock();
      }

      // Request new wakeLock
      const wakeLock = await (navigator as any).wakeLock.request("screen");
      this.wakeLock = wakeLock;
      Logger.debug(TAG, "WakeLock acquired");

      // Handle wakeLock release (e.g., user switches tab, screen locks)
      wakeLock.addEventListener("release", () => {
        Logger.debug(TAG, "WakeLock released by system");
        this.wakeLock = null;
      });
    } catch (error) {
      this.wakeLock = null;
      Logger.warn(TAG, "Failed to acquire WakeLock", error);
      // Some devices reject the very FIRST request transiently even while
      // visible (a race as the page becomes fully interactive), then never
      // re-acquire for the rest of the session. Retry once shortly — but only
      // if we still want the lock (active playback, visible, none held).
      if (retry > 0) {
        setTimeout(() => {
          const st = this.stateManager.getState();
          if (
            !this.wakeLock &&
            (st === "playing" || st === "buffering") &&
            typeof document !== "undefined" &&
            document.visibilityState === "visible"
          ) {
            this.requestWakeLock(retry - 1);
          }
        }, 600);
      }
    }
  }

  /**
   * Re-acquire the screen wake lock if we should be holding one but aren't.
   * Called on the moments where the lock can quietly drop, or where a failed
   * first attempt gets a fresh chance: tab visibility changes and player
   * resizes (fullscreen / orientation / PiP transitions). Idempotent — no-op
   * when a lock is already held, playback isn't active, or the page is hidden.
   */
  private ensureWakeLock(): void {
    if (this.wakeLock) return; // already held
    const st = this.stateManager.getState();
    if (st !== "playing" && st !== "buffering") return; // not actively playing
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    )
      return;
    this.requestWakeLock();
  }

  /**
   * Handle network recovery — re-seek to current position to restart cleanly
   */
  private handleNetworkOnline = (): void => {
    const state = this.stateManager.getState();
    if (state === "buffering" || state === "playing") {
      const currentTime = this.getCurrentTime();
      Logger.info(
        TAG,
        `Network online — re-seeking to ${currentTime.toFixed(2)}s for clean recovery`,
      );
      this.seek(currentTime).catch((err) => {
        Logger.error(TAG, "Network recovery seek failed", err);
      });
    }
  };

  /**
   * Handle visibility change
   */
  /** Set by MoviElement when Document PiP is active */
  public isPiPActive: boolean = false;

  private handleVisibilityChange = async (): Promise<void> => {
    const isPlaying =
      this.stateManager.getState() === "playing" ||
      this.stateManager.getState() === "buffering";

    if (document.visibilityState === "hidden" && isPlaying) {
      // On phones/tablets, skip background-playback gymnastics entirely. The OS
      // throttles/freezes hidden tabs aggressively (timers stop, AudioContext
      // suspends, recovery on resume is unreliable) — easier to just pause.
      // PiP is exempted; that's an explicit "keep playing" gesture.
      // UA check (not pointer:coarse) so Windows touch laptops aren't misclassified.
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      const uaData = (navigator as any)?.userAgentData;
      const isMobile =
        uaData?.mobile === true ||
        /Android|iPhone|iPod|Mobile|Opera Mini|IEMobile|BlackBerry/i.test(ua) ||
        // iPad on iOS 13+ reports as Mac — disambiguate via touch points
        (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
      // ...unless the page has explicitly asked for background playback. It is
      // opt-in, so the caller is taking on the unreliability described above;
      // the return path already handles the worst of it, pausing for a tap if
      // the AudioContext comes back stuck suspended.
      if (isMobile && !this.isPiPActive && !this._backgroundPlay) {
        this.pause();
        return;
      }

      // Tab went to background — use Worker timer (Safari throttles setInterval to 1s+)
      this.isBackgrounded = true;

      // Background timer drives processLoop to keep audio flowing while hidden.
      // For audio-less content (no audio track or audio disabled) without PiP,
      // video decode is skipped AND there's no audio to drive — running the loop
      // would just race the demuxer to EOF (no backpressure → eofReached=true →
      // foreground recovery returns early → video stuck on resume).
      const hasAudio =
        !!this.trackManager.getActiveAudioTrack() && !this.disableAudio;
      if (hasAudio || this.isPiPActive) {
        this.startBackgroundTimer();
      }

      // In background (not PiP), stop video presentation and clear queue
      // to prevent frame accumulation that blocks audio demuxing via backpressure.
      // At 60fps, the queue fills in ~1.7s and starves audio completely.
      if (!this.isPiPActive && this.videoRenderer) {
        this.videoRenderer.stopPresentationLoop();
        this.videoRenderer.clearQueue();
      }

      // Resume AudioContext if suspended
      if (this.audioRenderer) {
        (this.audioRenderer as any).audioContext?.resume?.().catch(() => {});
      }
    } else if (document.visibilityState === "visible") {
      // Tab visible again — stop background timer, RAF takes over
      this.isBackgrounded = false;
      this.stopBackgroundTimer();

      // The system drops the wake lock whenever the tab hides; now that we're
      // visible again, re-acquire it (idempotent, gated on active playback).
      this.ensureWakeLock();

      if (isPlaying) {
        // Resume AudioContext if needed. On mobile after long background the
        // browser may keep it suspended (autoplay policy — prior gesture has
        // expired). If resume doesn't actually move us back to "running",
        // there's no point pretending playback is live: pause cleanly so the
        // UI shows the play button and the user can tap to resume.
        const audioCtx = (this.audioRenderer as any)?.audioContext as
          AudioContext | undefined;
        if (audioCtx) {
          try {
            await audioCtx.resume();
          } catch {}
          if (
            audioCtx.state === "suspended" &&
            !this.muted &&
            !this.disableAudio
          ) {
            Logger.warn(
              TAG,
              "AudioContext stuck suspended after foreground — pausing for user tap",
            );
            this.pause();
            return;
          }
        }

        if (!this.isPiPActive) {
          await this.resyncVideoToAudio("Foreground recovery");
        } else {
          // PiP was active — just restart processLoop, video was rendering in PiP
          this.processLoop();
        }

        // Re-acquire once playback has settled back in — idempotent, so it's a
        // no-op if ensureWakeLock above already got it.
        setTimeout(() => this.ensureWakeLock(), 500);
      }
    }
  };

  /**
   * Bring the PICTURE back to where the sound already is, without touching the
   * sound.
   *
   * Used wherever video decode was stopped while audio kept running — a
   * backgrounded tab, and the audio-only toggle being switched back off. An
   * ordinary seek() would serve both, but it re-seeks the audio too: the
   * renderer's scheduled buffers are dropped and rebuilt, which is a hole in
   * the sound at the exact moment the viewer asked for the picture back. Here
   * only the video decoder is flushed and only the demuxer is repositioned;
   * the audio decoder, the renderer and everything it has already scheduled are
   * left alone, and the re-demuxed audio packets that were already played are
   * skipped by seekTargetTime.
   */
  private async resyncVideoToAudio(reason: string): Promise<void> {
    // clock.getTime() falls back to wall-clock when the audio output is
    // suspended in background, so it can race far ahead of the audio that has
    // actually been rendered. Resolve the real audio position from the
    // AudioRenderer's clock / buffer end, and fall back to the wall clock when
    // there is no audio at all.
    const audioClock = this.audioRenderer?.getAudioClock() ?? -1;
    const audioBufferEnd = this.audioRenderer?.getMaxScheduledMediaTime() ?? 0;
    const audioTime =
      audioClock >= 0
        ? audioClock
        : audioBufferEnd > 0
          ? audioBufferEnd
          : this.clock.getTime();
    Logger.debug(TAG, `${reason}: video-only seek to ${audioTime.toFixed(2)}s`);

    // "Video-only" is the whole point of this recovery — and the one thing a
    // binding does not allow. The sound is asked to carry on while the picture
    // is re-fetched and re-decoded, which on a healthy link is a blink and on a
    // failing one is the complaint itself: audio-only switched back to video,
    // the video would not fetch, the spinner came up, and the sound played
    // straight through it without ever waiting for the picture.
    //
    // Worse, this is the one recovery that can take the pipeline with it. It
    // cancels the loop below and then blocks on demuxer.seek(); if that seek
    // never lands — a link that died in the same moment — processLoop is never
    // restarted, and processLoop is where stall detection, the resume gate and
    // the demux timeout all live. Read off the session this came from: 5,628
    // further log lines, not one buffering event, the sound running on over a
    // picture that stopped at 42s.
    //
    // So hold, but LATE. Holding up front costs the case that works: the whole
    // catch-up is normally a few hundred milliseconds of already-buffered
    // decode, and stopping the sound for it turned a switch nobody noticed into
    // a spinner — and, because the ABR reads any buffering as the rung failing,
    // into a walk down the whole ladder. Give the picture its moment, and hold
    // only if it doesn't arrive: past this, the sound is running away from a
    // catch-up that is not catching up, which is the thing a binding forbids.
    let held = false;
    const holdIfStillWaiting = () => {
      if (this._destroyed || this.seekSessionId !== mySessionId) return;
      if (!this.stateManager.is("playing")) return;
      const bound =
        this._bindAV &&
        !this.disableAudio &&
        (!!this.audioDemuxer || !!this.trackManager.getActiveAudioTrack());
      if (!bound) return;
      held = true;
      Logger.info(
        TAG,
        `${reason}: the picture is still coming — holding sound and clock for it`,
      );
      this.wasPlayingBeforeRebuffer = true;
      // Our own doing, not a starved pipeline: the resume gate lets go on
      // readiness instead of serving the cushion meant for a decoder that fell
      // behind, and the ABR knows not to read it as the rung failing.
      this._bufferingSelfInflicted = true;
      this.stateManager.setState("buffering");
      this.clock.pause();
      this.audioRenderer?.suspendForBuffering();
      // Down so the catch-up's frames ACCUMULATE — that queue is what the
      // resume gate measures before it starts the two together again.
      this.videoRenderer?.stopPresentationLoop();
    };

    // Cancel any in-flight processLoop to avoid demux conflicts during seek
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    const mySessionId = ++this.seekSessionId;
    const holdTimer = setTimeout(holdIfStillWaiting, MoviPlayer.RESYNC_HOLD_MS);
    // Release a superseded seek's video-sync flag (this recovery seek is
    // filter-only and owns its own resume) so the pipeline can't strand in
    // a permanent wait — see notifySeekCompletion's superseded branch.
    this.waitingForVideoSync = false;

    try {
      // Let a read already inside the demuxer land before seeking it — the
      // same wait seek() and the rendition swap do. Cancelling the rAF stops
      // the NEXT pass, not a readPacket that Asyncify has suspended mid-call,
      // and a seek issued over that read takes its pending slot: the read's
      // bytes then arrive to "No pending read to fulfill", the readPacket never
      // resolves, and demuxInFlight holds the whole pipeline until the demux
      // timeout. Measured right after a hard 8K → 4K swap, where this catch-up
      // fires by design: a 35s freeze while the source kept filling for nobody.
      let guard = 0;
      while (this.demuxInFlight && guard++ < 100) {
        await new Promise((r) => setTimeout(r, 10));
      }
      if (this.seekSessionId !== mySessionId) {
        clearTimeout(holdTimer);
        return; // Superseded
      }

      // Flush video decoder only — audio decoder and renderer untouched
      if (this.videoDecoder) {
        await this.videoDecoder.flush();
      }
      if (this.videoRenderer) {
        this.videoRenderer.clearQueue();
      }

      if (this.seekSessionId !== mySessionId) return; // Superseded

      // Reset EOF flag — demuxer is being repositioned. For audio-less
      // video, background processLoop may have raced to EOF; without this
      // reset, processLoop would early-return and playback stalls.
      this.resetEof();

      // Seek demuxer to nearest keyframe before current audio position
      if (this.demuxer) {
        await this.demuxer.seek(audioTime + this.startTime);
      }
      // Both queues hold what was read from the old cursor; the audio from
      // here on is re-read, and seekTargetTime below keeps what was already
      // scheduled from being decoded twice.
      this.clearPacketQueues();
      // The blocking part is behind us — whatever happens now, the pipeline is
      // moving again, so the hold has nothing left to protect against.
      clearTimeout(holdTimer);

      if (this.seekSessionId !== mySessionId) return; // Superseded

      // Re-anchor the wall clock to audio. While backgrounded the wall
      // clock advanced freely while audio output was suspended; without
      // this re-sync, getTime() will continue reporting the inflated
      // value and Clock's drift correction will snap the wall clock
      // back at 50%/sample, causing time-update jitter on resume.
      this.clock.seek(audioTime + this.startTime);

      // Skip pre-target packets: use audio buffer end (not clock time) so
      // already-scheduled audio isn't re-decoded — prevents fast-forward sound.
      this.seekTargetTime = Math.max(
        audioTime + this.startTime,
        audioBufferEnd,
      );
      // …but the PICTURE rejoins where the sound is, not where its schedule
      // ends. See _videoResumeTarget.
      this._videoResumeTarget = audioTime + this.startTime;
      this._videoCatchUpStartedAt = performance.now();
      this.seekingToKeyframe = true;
      this.seekingToKeyframeStartTime = performance.now();
      this.seekKeyframeScanned = 0;
      this.seekCraSeen = 0;

      // Restart video pipeline. If the hold went up while we were waiting, the
      // presentation loop stays down: the resume gate is measuring the queue
      // now, and a loop running through that would consume each frame as it
      // landed and leave the gate with nothing to find.
      if (this.videoRenderer && !held) {
        this.videoRenderer.startPresentationLoop();
      }
      this.processLoop();
    } catch (err) {
      clearTimeout(holdTimer);
      Logger.error(TAG, `${reason} failed`, err);
      // Fall back to processLoop restart so playback doesn't stall
      this.processLoop();
    }
  }

  /**
   * Start background timer using Web Worker (Safari-safe, not throttled)
   */
  /**
   * Make sure the hidden-tab pump is running, whatever route got us playing.
   *
   * While the tab is hidden rAF is throttled to nothing, so the audio loop —
   * which runs on rAF — does not tick and the renderer is handed nothing to
   * play. The Worker timer is what keeps it fed. play() already starts it, but
   * play() is not the only way playback begins: a seek completing resumes
   * straight into "playing", and that is exactly how the next track starts
   * after a background auto-advance. Read off a real session's log — state
   * playing, clock started, "AudioRenderer Playing … state: running", and then
   * not one decoded packet until the viewer came back.
   */
  private ensureBackgroundPump(): void {
    if (!this.isBackgrounded || this.isPiPActive) return;
    // Split (separate-URL) audio's track is not in the main trackManager, so
    // count its demuxer too — same reason handleVisibilityChange does.
    const hasAudio =
      (!!this.trackManager.getActiveAudioTrack() || !!this.audioDemuxer) &&
      !this.disableAudio;
    if (hasAudio) this.startBackgroundTimer();
  }

  private startBackgroundTimer(): void {
    if (this.backgroundWorker || this.backgroundIntervalId) return;
    Logger.debug(TAG, "Starting background playback timer");

    try {
      // Create inline Worker — not throttled in background tabs
      const blob = new Blob(
        [
          `
        let id = null;
        self.onmessage = (e) => {
          if (e.data === 'start') {
            id = setInterval(() => self.postMessage('tick'), 16);
          } else if (e.data === 'stop') {
            clearInterval(id);
            id = null;
          }
        };
      `,
        ],
        { type: "application/javascript" },
      );
      const worker = new Worker(URL.createObjectURL(blob));
      this.backgroundWorker = worker;
      worker.onmessage = () => this.backgroundTick();
      // A worker that fails to LOAD does not throw — the constructor returns an
      // object and the failure arrives later as an error event, so the catch
      // below never ran and neither did its fallback. What was left was a
      // worker that would never tick and an `if (this.backgroundWorker) return`
      // guard saying the pump was running. Safari does exactly this: a
      // cross-origin-isolated page (which this one is — SharedArrayBuffer needs
      // COOP/COEP) refuses a blob: worker, logging "Cannot load blob:… due to
      // access control checks". So the hidden tab had no pump at all: rAF is
      // throttled to nothing there, and the sound stopped as soon as the
      // buffered second or two ran out.
      worker.onerror = () => {
        Logger.warn(
          TAG,
          "Background worker failed to load — falling back to setInterval",
        );
        try {
          worker.terminate();
        } catch {}
        if (this.backgroundWorker === worker) this.backgroundWorker = null;
        this.startBackgroundTimerFallback();
      };
      worker.postMessage("start");
    } catch {
      // Worker not available at all (constructor threw).
      Logger.debug(TAG, "Worker unavailable, using setInterval fallback");
      this.startBackgroundTimerFallback();
    }
  }

  /**
   * The pump without a worker. Throttled in a hidden tab (Safari clamps it to
   * about a second), which is far worse than a worker tick — but a tick a
   * second still decodes ahead and keeps the sound alive, where nothing at all
   * ends it.
   */
  private startBackgroundTimerFallback(): void {
    if (this.backgroundIntervalId || this._destroyed) return;
    // Only while the pump is still wanted — the load error can land after the
    // tab came back, and the visibility handler has stopped the timer by then.
    // (PiP is deliberately not excluded: the hidden-tab-with-PiP case starts
    // this pump too.)
    if (!this.isBackgrounded) return;
    this.backgroundIntervalId = window.setInterval(
      () => this.backgroundTick(),
      16,
    );
  }

  /**
   * One background-timer tick (Worker or setInterval). Drives decode while the
   * tab is hidden and rAF is throttled.
   */
  private backgroundTick(): void {
    const state = this.stateManager.getState();
    if (state !== "playing" && state !== "buffering") return;
    if (this.audioDemuxer) {
      // Split (separate-URL) audio: keep the audio decoding — its own loop runs
      // on rAF, which is throttled while hidden (this is what stalled it). The
      // video body isn't shown in the background, so skip its decode entirely to
      // avoid piling frames into a queue nothing is draining — except in PiP,
      // where the video IS visible in the PiP window.
      this.pumpSplitAudio();
      // A track finishing while backgrounded must still auto-advance (music).
      this.maybeEndSplitAudio();
      if (this.isPiPActive) this.processLoop();
    } else {
      // Muxed: processLoop decodes the in-file audio inline, so it's all we need.
      this.processLoop();
    }
    if (this.isPiPActive && this.videoRenderer) {
      (this.videoRenderer as any).presentationLoop?.();
    }
  }

  /**
   * Stop background timer
   */
  private stopBackgroundTimer(): void {
    if (this.backgroundWorker) {
      this.backgroundWorker.postMessage("stop");
      this.backgroundWorker.terminate();
      this.backgroundWorker = null;
      Logger.debug(TAG, "Background worker stopped");
    }
    if (this.backgroundIntervalId !== null) {
      clearInterval(this.backgroundIntervalId);
      this.backgroundIntervalId = null;
    }
  }

  /**
   * Start pause-time buffering: demux packets while paused so that
   * resume/seek within buffered area is near-instant (YouTube-like behavior).
   * Reads into the packet queues without decoding; play() feeds from them.
   */
  private startPauseBuffering(): void {
    if (this.pauseBufferTimerId !== null) return;
    if (!this.demuxer || this.eofReached) return;
    if (this.waitingForVideoSync || this.seekTargetTime !== -1) return;
    // Only for HTTP sources — local files are already fully available
    if (this.source instanceof FileSource) return;

    Logger.debug(TAG, "Starting pause-time buffering");
    // Hold the window: what pause-time buffering reads ahead must not cost
    // the bytes between the playhead and it. See holdWindow.
    if (this.source instanceof HttpSource) this.source.holdWindow();
    this.pauseBufferTimerId = window.setInterval(() => {
      this.pauseBufferTick();
    }, MoviPlayer.PAUSE_BUFFER_INTERVAL_MS);
  }

  private stopPauseBuffering(): void {
    if (this.pauseBufferTimerId !== null) {
      clearInterval(this.pauseBufferTimerId);
      this.pauseBufferTimerId = null;
      Logger.debug(TAG, "Stopped pause-time buffering");
    }
  }

  private pauseBufferTick = async () => {
    // Guard: only buffer while actually paused
    if (this.stateManager.getState() !== "paused") {
      this.stopPauseBuffering();
      return;
    }
    // Don't interfere with active WASM operations
    if (this.demuxInFlight || !this.demuxer) return;
    if (this.waitingForVideoSync || this.seekTargetTime !== -1) {
      this.stopPauseBuffering();
      return;
    }
    if (this.eofReached) {
      this.stopPauseBuffering();
      return;
    }

    // The same read decision as playback, against a longer readahead, and
    // under the same byte ceiling.
    if (!this.needsMorePackets(MoviPlayer.PAUSE_BUFFER_SECONDS)) {
      Logger.debug(
        TAG,
        `Pause buffer full: video=${this.videoQueue.forwardSeconds().toFixed(1)}s audio=${this.audioQueue.forwardSeconds().toFixed(1)}s, ${(
          (this.videoQueue.bytes + this.audioQueue.bytes) /
          1048576
        ).toFixed(1)}MB`,
      );
      this.stopPauseBuffering();
      return;
    }

    try {
      this.demuxInFlight = true;
      this.demuxInFlightStartTime = performance.now();

      // Read a small burst of packets
      const burstSize = 10;
      for (let i = 0; i < burstSize; i++) {
        if (this.stateManager.getState() !== "paused") break;
        if (!this.needsMorePackets(MoviPlayer.PAUSE_BUFFER_SECONDS)) break;

        // Don't push the demuxer past what HttpSource already holds — the next
        // read would otherwise trigger startStream() at the new offset, which
        // resets the sliding window and evicts already-buffered earlier bytes.
        // Pause-time buffering must never request bytes the network hasn't
        // delivered yet.
        if (this.source instanceof HttpSource && !this.source.isFullyCached()) {
          const pos = this.source.getPosition();
          const end = this.source.getBufferedEnd();
          // Keep ~1MB margin so an in-progress demuxer read doesn't straddle
          // the boundary and still trigger a refetch.
          if (pos >= end - 1024 * 1024) {
            this.stopPauseBuffering();
            break;
          }
        }

        const readEpoch = this._refreshEpoch;
        const packet = await this.demuxer.readPacket();
        if (!packet) {
          this.markEof();
          break;
        }
        this.enqueuePacket(packet, readEpoch !== this._refreshEpoch);
      }
    } catch (e) {
      Logger.error(TAG, "Pause buffer demux error", e);
    } finally {
      this.demuxInFlight = false;
    }
  };

  /**
   * Release WakeLock
   */
  private async releaseWakeLock(): Promise<void> {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
        this.wakeLock = null;
        Logger.debug(TAG, "WakeLock released");
      } catch (error) {
        Logger.warn(TAG, "Failed to release WakeLock", error);
        this.wakeLock = null;
      }
    }
  }

  /**
   * Get buffered time in seconds
   * Returns the furthest time position that has been buffered
   */
  /** The source's buffered end, in bytes, when the buffer-bar clamp was last
   *  raised — see getBufferedTime. */
  private _bufferedLatchBytes = 0;

  getBufferedTime(): number {
    if (this.streamWrapper) {
      return this.streamWrapper.getBufferEndTime();
    }

    if (!this.mediaInfo || !this.source) {
      return 0;
    }

    const duration = this.mediaInfo.duration;
    if (duration <= 0) {
      return 0;
    }

    // Audio-only: the bar has to answer for the AUDIO, since that is the only
    // thing still being fetched. The video source's prefetch is paused by this
    // very mode, so its read cursor and its window cannot move — the forward
    // delta the maths below computes is frozen, and `currentTime + a constant`
    // is a bar that grows only because the playhead does. That is exactly what
    // it looks like: a buffer that tracks the progress instead of leading it.
    //
    // A linear byte→time map is honest for audio in a way it is not for video:
    // an AAC/Opus track holds its bitrate, so bytes and seconds stay in step.
    if (this._audioOnly && this.audioSource instanceof HttpSource) {
      const audio = this.audioSource;
      if (audio.isFullyCached()) return duration;
      const size = audio.getKnownSize();
      const end = audio.getBufferedEnd();
      if (size > 0 && end > 0) {
        return Math.min(duration, (end / size) * duration);
      }
    }

    // For HttpSource, report the buffered-end *relative* to the source's
    // real read cursor. Converting both endpoints to time via linear ratio
    // fails on VBR (seek byte offset ≠ linear(seek time)). Instead, use the
    // byte delta between buffered-end and the source's last-read position
    // — both are real byte offsets — and apply linear conversion only to
    // that small delta, added to the accurate currentTime.
    //
    // Pause-time buffering decouples the demuxer cursor from the playback
    // clock (demuxer keeps reading ahead while currentTime is frozen),
    // which causes forwardBytes to shrink and the bar to walk backward.
    // Clamp monotonically: the buffered-end never moves backward except on
    // seek (where lastBufferedTime is reset elsewhere).
    if (this.source instanceof HttpSource && this.fileSize > 0) {
      // Small files fully cached in memory should report the entire
      // duration as buffered. The byte-delta math below underreports
      // for VBR content (e.g., a high-bitrate intro consumes more bytes
      // than its share of duration, so currentBytes/fileSize at low
      // currentTime is artificially high → forwardTime is artificially
      // low → bufferedTime = currentTime + forwardTime falls short of
      // duration even though every byte is in memory).
      if (this.source.isFullyCached()) {
        this.lastBufferedTime = duration;
        return duration;
      }
      const bufferedEndBytes = this.source.getBufferedEnd();
      if (bufferedEndBytes > 0) {
        const currentBytes = this.source.getPosition();
        // Downloaded to the last byte of the file: there is nothing left to
        // fetch, so the bar is full. The same VBR skew described above stops
        // the byte-delta maths from ever saying so — it leaves the bar a
        // sliver short of the end on a file that finished downloading minutes
        // ago, which reads as "still buffering" forever.
        // …but only when the window actually SPANS from here to the end. It
        // slides, and a container whose index lives at the tail — Matroska
        // cues, a trailing moov — sends it there during open: for that moment
        // the window ends at the last byte of a file it has read four
        // megabytes of, and this said the whole thing was buffered. Worse, it
        // said so into a monotonic latch, so a 45-minute file showed a full bar
        // from the first second and only told the truth again after a seek
        // reset the latch.
        // Measured against where the PLAYHEAD is, not where the demuxer's
        // cursor is: during the tail read they are the same byte, so comparing
        // the window to the cursor still calls a 4MB read of a 3.6GB file
        // "fully buffered". The playhead's offset is only an estimate — linear,
        // so VBR skews it — but the question here is coarse: is the window
        // somewhere near the beginning of what is left to play, or is it parked
        // at the far end of the file reading an index?
        const windowStart = this.source.getBufferedStart();
        const playheadBytes =
          (this.getCurrentTime() / duration) * this.fileSize;
        if (bufferedEndBytes >= this.fileSize && windowStart <= playheadBytes) {
          this.lastBufferedTime = duration;
          return duration;
        }
        const forwardBytes = Math.max(0, bufferedEndBytes - currentBytes);
        const forwardTime = (forwardBytes / this.fileSize) * duration;
        // Never past the end: the same skew can overshoot in the other
        // direction, and a bar wider than the track is its own small lie.
        const computed = Math.min(
          duration,
          this.getCurrentTime() + forwardTime,
        );
        // The clamp stands for bytes that are still there. A window that
        // moved BACK (a new stream at a seek target, a reset) has dropped the
        // bytes the old end was measuring, so the old end goes with them.
        if (bufferedEndBytes < this._bufferedLatchBytes)
          this.lastBufferedTime = 0;
        this._bufferedLatchBytes = bufferedEndBytes;
        this.lastBufferedTime = Math.max(this.lastBufferedTime, computed);
        return this.lastBufferedTime;
      }
    }

    // For FileSource, the entire file is buffered
    if (this.source instanceof FileSource) {
      return duration;
    }

    // EncryptedHttpSource now extends HttpSource, so the branch above
    // handles its buffered-end reporting too.

    // HLS demuxer fallback: the SegmentStreamSource fetches segments on demand,
    // so its read cursor (getPosition = furthest byte read) sits ahead of the
    // playhead by the demuxer's prebuffer. Estimate the playhead's byte position
    // linearly and report the gap as buffered-ahead time.
    if (
      this.source instanceof SegmentStreamSource &&
      this.fileSize > 0 &&
      duration > 0
    ) {
      const frontier = this.source.getPosition();
      const playheadBytes = (this.getCurrentTime() / duration) * this.fileSize;
      const forwardBytes = Math.max(0, frontier - playheadBytes);
      const forwardTime = (forwardBytes / this.fileSize) * duration;
      return Math.min(this.getCurrentTime() + forwardTime, duration);
    }

    return 0;
  }

  /**
   * Check if current source is HttpSource
   */
  isHttpSource(): boolean {
    return this.source instanceof HttpSource;
  }

  /**
   * Tune the active source's prefetch window. Value is megabytes — the
   * target "buffer ahead of playback" the source should try to maintain.
   * Honored by HttpSource (adjusts its sliding-window cap) and by
   * EncryptedHttpSource (scales PREFETCH_HIGH/LOW_WATER + cache cap).
   * Other source types are silently ignored.
   *
   * Wired to the `buffersize` element attribute so consumers can tune
   * memory vs. seek responsiveness at deploy time without forking.
   */
  setMaxBufferSize(megabytes: number): void {
    if (!(megabytes > 0) || !this.source) return;
    const src = this.source as SourceAdapter & {
      setMaxBufferSize?: (mb: number) => void;
    };
    if (typeof src.setMaxBufferSize === "function") {
      src.setMaxBufferSize(megabytes);
    }
  }

  /**
   * Get buffer start position in bytes (for HttpSource)
   * Returns -1 if not available or not HttpSource
   */
  getBufferStartBytes(): number {
    if (this.source instanceof HttpSource) {
      return this.source.getBufferStart();
    }
    return -1;
  }

  /**
   * Whether a quality switch is preparing its rung right now.
   *
   * For the element's stuck watchdog, which judges progress by the ACTIVE
   * source's bytes. A step down holds that source's download for the prep
   * (see suspendNetwork in switchVideoRenditionInPlace), so the bytes stop by
   * design while the new rung's arrive somewhere the watchdog cannot see —
   * and it read that as stuck and nudged a seek into the prep, which the prep
   * then abandoned as the viewer seeking. The prep has its own budget.
   */
  isPreparingRendition(): boolean {
    return this._pendingSwitchSource !== null;
  }

  /**
   * Get buffer end position in bytes (for HttpSource)
   * Returns -1 if not available or not HttpSource
   */
  getBufferEndBytes(): number {
    if (this.source instanceof HttpSource) {
      return this.source.getBufferedEnd();
    }
    return -1;
  }

  /**
   * Get buffer start time in seconds (for HttpSource)
   * Converts buffer start bytes to time position using current read position as reference
   */
  getBufferedRangeStart(): number {
    return this.bufferedRangeStart;
  }

  getBufferStartTime(): number {
    if (
      !this.mediaInfo ||
      !this.source ||
      !(this.source instanceof HttpSource) ||
      this.fileSize <= 0
    ) {
      return 0;
    }

    const duration = this.mediaInfo.duration;
    // For HttpSource, convert buffer start bytes to time using stable linear estimation
    if (this.source instanceof HttpSource && this.fileSize > 0) {
      const bufferStartBytes = this.source.getBufferStart();
      const ratio = Math.min(1, bufferStartBytes / this.fileSize);
      return ratio * duration;
    }
    return 0;
  }

  /**
   * Lowest time a backward seek can SAFELY land in linear (non-range) playback.
   * The window starts at getBufferStartTime, but a seek's keyframe sits at a
   * lower byte than the linear time→byte estimate (GOP span + VBR), so seeking
   * right at the window edge usually reads just below it and fails. Pad the
   * start by a byte safety margin so the keyframe stays inside the RAM window.
   * Returns 0 for seekable (range-capable) or non-HTTP sources.
   */
  getSeekableStartTime(): number {
    if (
      !this.mediaInfo ||
      !(this.source instanceof HttpSource) ||
      this.fileSize <= 0 ||
      !this.source.isLinearMode()
    ) {
      return 0;
    }
    const MARGIN_BYTES = 96 * 1024 * 1024; // covers a keyframe-before-target gap
    const safeBytes = Math.min(
      this.fileSize,
      this.source.getBufferStart() + MARGIN_BYTES,
    );
    return Math.min(
      this.mediaInfo.duration,
      (safeBytes / this.fileSize) * this.mediaInfo.duration,
    );
  }

  /**
   * Get buffer end time in seconds (for HttpSource)
   * Same as getBufferedTime but more explicit
   */
  getBufferEndTime(): number {
    return this.getBufferedTime();
  }

  /**
   * Get the source adapter (for checking buffer status, etc.)
   */
  getSource(): SourceAdapter | null {
    return this.source;
  }

  /**
   * Set log level
   */
  static setLogLevel(level: LogLevel): void {
    Logger.setLevel(level);
    // Also update FFmpeg log level for all active bindings
    updateAllBindingsLogLevel(level);
  }

  /**
   * Get the video element renderer (for faststart conversion access)
   * Returns null if not using MSE mode
   */
  /**
   * Check if video decoding is falling back to software
   */
  isSoftwareDecoding(): boolean {
    return this.videoDecoder ? this.videoDecoder.isSoftware : false;
  }

  /**
   * Check if any active decode path is software-backed.
   * Unlike isSoftwareDecoding(), this includes worker audio software decode.
   */
  isSoftwareHeavyDecoding(): boolean {
    return isSoftwareDecodePath(this.videoDecoder, this.audioDecoder);
  }

  /**
   * True when software decode work runs on the main thread.
   * Worker video/audio decode is intentionally excluded so UI effects are not
   * disabled when FFmpeg work is isolated off the main thread.
   */
  isMainThreadSoftwareDecoding(): boolean {
    const decodeMode = getDecodeMode(this.videoDecoder, this.audioDecoder);
    const videoStats = this.videoDecoder.getStats?.();
    const audioStats = this.audioDecoder.getStats();
    return (
      (decodeMode.videoSoftware && !videoStats?.worker) ||
      (decodeMode.audioSoftware && !audioStats.worker)
    );
  }

  /**
   * WHY the picture is being decoded on the CPU — see
   * MoviVideoDecoder.softwareReason. "hardware-refused" is a trade worth
   * offering the viewer; the other two are simply how this codec plays.
   */
  softwareDecodeReason():
    "unmapped" | "no-webcodecs" | "hardware-refused" | null {
    return this.videoDecoder?.softwareReason ?? null;
  }

  /**
   * Is the CPU carrying the decode? True for the WASM decoder, for a browser
   * with no WebCodecs at all, and — the case that hid for a while — for a
   * WebCodecs decoder that had to drop `prefer-hardware` because the rung has
   * no hardware path. Chrome accepts AV1 1440p that way and decodes it on the
   * CPU; the ladder ceiling has to treat all three the same, or the rung sits
   * there with a full decode queue and the spinner up, never stepping down.
   */
  /**
   * Is the download finished — the whole file in hand, or everything up to the
   * end of the media already buffered?
   *
   * The ABR's every downshift reason is a statement about the LINK, and once
   * there is nothing left to fetch there is no link left in the picture. A
   * shrinking buffer then means only that the playhead is walking toward an end
   * that is already downloaded, which is what playback IS. Dropping a rung
   * there costs a switch and buys nothing: the bytes for the rung we would
   * leave are already on the machine, and the ones for the rung we would land
   * on are not.
   */
  private nothingLeftToFetch(): boolean {
    if (
      (
        this.source as { isFullyCached?: () => boolean } | null
      )?.isFullyCached?.() === true
    ) {
      return true;
    }
    const duration = this.getDuration();
    return duration > 0 && this.getBufferedTime() >= duration - 0.5;
  }

  /**
   * Everything a video decoder needs to be THE video decoder: frames into the
   * renderer's queue with the seek-target filter, errors out to the host, and
   * the keyframe-wait hold that keeps a mid-playback recovery out of the
   * buffering state.
   *
   * A method rather than a block in the constructor because a seamless quality
   * switch builds its next decoder BEFORE it owns the pipeline — it primes into
   * a private list of frames, and takes this wiring only at the swap. Wiring
   * that differed even slightly from the original would show up as a bug that
   * appears only after the first switch.
   */
  /**
   * Decode the incoming rendition PAST the playhead before anything is swapped,
   * so the changeover costs no frames.
   *
   * The old switch was seamless everywhere except the one place that shows: the
   * network prep overlapped, but the DECODE did not. The pipeline stopped, the
   * decoder flushed, every queued frame was thrown away, the decoder
   * reconfigured, and only then did the first packet of the new rendition go
   * in. What the viewer sees is the sum of those — a still frame under a
   * spinner, for as long as a fresh GOP takes.
   *
   * So a second decoder runs alongside the first, on its own demuxer, and
   * decodes until it holds frames the clock has not reached yet. Only then does
   * anything swap, and what swaps is a queue that already has the next quarter
   * second in it. The outgoing frames play out first (see spliceQueue), so the
   * seam is one frame following another at a new size.
   *
   * Two decoders exist at once for the length of the prime, which is the cost:
   * on a device that only has one hardware decoder the second will not
   * configure, and on a slow one the extra decode may cost the OLD rendition a
   * frame or two. Both end the same way — null, and the caller does the hard
   * switch it always did.
   *
   * Staging is bounded by the clock, not by the packet count: a frame the
   * playhead has already passed is closed the moment it arrives, so the window
   * held in memory is the lead below and never the whole seek-to-live gap. It
   * matters — at 8K a second of frames is not something to hold "just in case".
   */
  private async primeRendition(
    newDemuxer: Demuxer,
    newTrack: VideoTrack,
    newStartTime: number,
    prepDeadline: number,
    status: { exhausted: boolean; readInFlight?: Promise<unknown> },
  ): Promise<{ decoder: MoviVideoDecoder; frames: VideoFrame[] } | null> {
    const staged: VideoFrame[] = [];
    const mediaTime = (f: VideoFrame) => f.timestamp / 1_000_000 - newStartTime;
    const dropStale = () => {
      const floor = this.getCurrentTime() - 0.05;
      while (staged.length > 0 && mediaTime(staged[0]) < floor) {
        staged.shift()!.close();
      }
    };
    const discard = () => {
      for (const f of staged) f.close();
      staged.length = 0;
    };

    const dec = new MoviVideoDecoder(this.config.decoder === "software");
    const bindings = newDemuxer.getBindings();
    if (bindings) dec.setBindings(bindings);
    let decoderFailed = false;
    dec.setOnError(() => {
      decoderFailed = true;
    });
    dec.setOnFrame((frame) => {
      // Behind the playhead already — decoded only to build reference state.
      if (mediaTime(frame) < this.getCurrentTime() - 0.05) {
        frame.close();
        return;
      }
      staged.push(frame);
    });
    dec.setPlaybackRate(this.clock.getPlaybackRate());

    try {
      const extradata = newDemuxer.getExtradata(newTrack.id) ?? undefined;
      const configured = await dec.configure(
        newTrack,
        extradata,
        this.config.frameRate ?? 0,
      );
      if (!configured || decoderFailed) {
        discard();
        dec.close();
        return null;
      }
      // Priming holds two decoders open at once, and on a device with one
      // hardware decode session the SECOND one is the one that loses it — it
      // configures perfectly well and quietly comes up in software. Adopting
      // that would trade a visible switch for an invisible collapse to CPU
      // decode at the higher resolution, which is a far worse trade. The hard
      // path has no such contention: by the time it configures, the outgoing
      // decoder is closed and the hardware is free.
      if (dec.isSoftwareBacked && !this.videoDecoder?.isSoftwareBacked) {
        Logger.debug(
          TAG,
          "Seamless prime came up in software while the outgoing decoder is on hardware — hard switch instead",
        );
        discard();
        dec.close();
        return null;
      }

      // How far ahead to prime. Reaching the end of what the outgoing rendition
      // has queued would mean losing nothing at all, but that queue can hold
      // seconds and these are whole decoded frames — at 8K, seconds of them is
      // not memory to spend on a cosmetic. Capped, so a deep queue gives up its
      // tail and everything else is kept.
      const queued = this.videoRenderer?.queuedPtsRange ?? null;
      const target = Math.min(
        Math.max(
          this.getCurrentTime() + MoviPlayer.SEAMLESS_PRIME_LEAD_S,
          (queued?.last ?? 0) + 0.05,
        ),
        this.getCurrentTime() + MoviPlayer.SEAMLESS_PRIME_MAX_AHEAD_S,
      );

      // Its own budget, or whatever the whole prep has left — whichever runs
      // out first. The open may already have eaten most of it.
      const deadline = Math.min(
        performance.now() + MoviPlayer.SEAMLESS_PRIME_BUDGET_MS,
        prepDeadline,
      );
      let started = false;
      let fed = 0;
      for (;;) {
        if (decoderFailed || this._destroyed) break;
        if (performance.now() > deadline) {
          status.exhausted = true;
          break;
        }
        dropStale();
        const last =
          staged.length > 0 ? mediaTime(staged[staged.length - 1]) : -Infinity;
        if (
          last >= target &&
          staged.length >= MoviPlayer.SEAMLESS_PRIME_MIN_FRAMES
        ) {
          return { decoder: dec, frames: staged };
        }
        // The deadline above is checked at the TOP of each pass, which bounds a
        // slow DECODE but not a slow READ — and on the rung that needs this
        // most, the read is the whole wait. Unbounded, the 5s budget was worth
        // whatever a single readPacket felt like taking on a 1.2GB file.
        const read = newDemuxer.readPacket();
        const packet = await withDeadline(read, deadline - performance.now());
        if (packet === TIMED_OUT) {
          status.exhausted = true;
          // Still suspended inside the demuxer — which the hard path goes on
          // to seek and play from. It has to land first; see the swap.
          status.readInFlight = read.catch(() => undefined);
          break;
        }
        if (!packet) break; // EOF before we could get ahead
        if (packet.streamIndex !== newTrack.id) continue;
        // A decoder that has just configured needs a random-access point, and
        // the demuxer's seek landed on one — but a non-IDR open-GOP keyframe is
        // not one, and feeding it here would produce the corrupt frames the
        // main path spends its keyframe hunt avoiding.
        if (!started) {
          if (!packet.keyframe || !packet.isIdr) continue;
          started = true;
        }
        dec.decode(
          packet.data,
          packet.timestamp,
          packet.keyframe,
          packet.dts,
          packet.isIdr,
          packet.isRasl,
          packet.disposable,
        );
        // Frames come out asynchronously; without yielding, this loop would
        // feed the whole budget in before a single one arrived — and hold the
        // main thread away from the rendition that is still playing.
        if (++fed % 4 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    } catch (e) {
      Logger.debug(TAG, `Seamless prime failed: ${e}`);
    }
    discard();
    dec.close();
    return null;
  }

  private wireVideoDecoder(dec: MoviVideoDecoder): void {
    dec.setOnFrame((frame) => {
      // Background mode: drop video frames silently (audio keeps playing)
      // But keep frames if PiP is active (canvas is visible in PiP window)
      if (document.hidden && !this.isPiPActive) {
        frame.close();
        return;
      }

      // Queue frames for smooth presentation with A/V sync
      // Allow processing if playing OR if we are seeking (waiting for sync)
      //
      // …and while BUFFERING, which is the state whose whole purpose is to
      // refill this queue. Leaving it out closed a loop with no way out of it:
      // buffering waits for the video queue to come back, and every frame
      // decoded to fill it was thrown away here because we were buffering. The
      // queue could only ever hold what survived from BEFORE the stall — and a
      // stall is declared on an empty queue, so it held nothing. Everything odd
      // in three sessions of logs is this: a bound wait that never once saw
      // `videoReady` true and always left on its 15s escape; the demuxer racing
      // flat-out through 14MB of file during a stall, because the renderer
      // never filled and never applied backpressure; a hold for the picture
      // that sat there while the picture was decoded and discarded a frame at a
      // time, until the viewer seeked by hand. The presentation loop is stopped
      // throughout buffering, so nothing here reaches the screen early — the
      // frames simply wait, which is what the resume gate is waiting to find.
      if (
        this.videoRenderer &&
        (this.stateManager.getState() === "playing" ||
          this.stateManager.getState() === "buffering" ||
          // Leaving buffering parks on "paused" for the length of an async
          // play(), and the decoder keeps handing frames over throughout —
          // see _resumeToPlayPending.
          this._resumeToPlayPending ||
          this.waitingForVideoSync ||
          // …and for the one frame a forced completion left owing. See
          // _pictureOwedFrom: without this the frames a paused seek was
          // waiting for arrive just after it gives up and are all dropped.
          this._pictureOwedFrom !== -1)
      ) {
        // A frame arriving while a seek waits for sync is that seek WORKING —
        // the decoder walking from the keyframe towards the target. Stamped
        // here, before the drop below, precisely because those dropped frames
        // are the evidence: they are the walk. The seek deadline reads this to
        // tell "the decoder is grinding through a long GOP" apart from "nothing
        // is coming", which is the only case the deadline is for.
        if (this.waitingForVideoSync) {
          this._seekFrameProgressAt = performance.now();
        }

        // IMPORTANT: Drop video frames before the seek target time
        // These frames are decoded to build decoder state (reference frames),
        // but we don't display them - we want accurate seeking to the target time
        const frameTime = frame.timestamp / 1_000_000; // Convert to seconds
        // A video-only resume overrides the shared target, which is parked at
        // the audio schedule's end for the audio path's sake — see
        // _videoResumeTarget.
        const gate =
          this._videoResumeTarget !== -1
            ? this._videoResumeTarget
            : this.seekTargetTime !== -1
              ? this.seekTargetTime
              : // Nothing else is filtering, but an owed picture still must not
                // be paid with a frame from before the position asked for.
                this._pictureOwedFrom;
        // CRITICAL: Check seekTargetTime !== -1 instead of >= 0 to support negative start times
        // Some media files have negative PTS offsets (e.g., startTime = -0.105s)
        if (gate !== -1 && frameTime < gate) {
          // Drop this frame, it's before our target time
          frame.close();
          return;
        }
        // Caught up. The gate stays OURS — opened, not handed back — and
        // seekTargetTime stays armed for the audio it is protecting: those
        // packets run seconds ahead of this frame and must not decode twice.
        if (this._videoResumeTarget !== -1) {
          this._videoResumeTarget = Number.NEGATIVE_INFINITY;
          this._pictureOwedFrom = -1;
          this.videoRenderer.queueFrame(frame);
          return;
        }

        // Video reached target! If a seek is awaiting sync, fire the
        // completion path. Otherwise the guard was set in filter-only
        // mode (first-play / post-prefetch resume) just to drop pre-target
        // frames produced by Open-GOP recovery — we just clear the guard
        // so subsequent frames flow through without re-entering this
        // branch (which would log a warn-spam every frame).
        if (this.seekTargetTime !== -1) {
          if (this.waitingForVideoSync) {
            Logger.debug(
              TAG,
              `onFrame: frameTime=${frameTime.toFixed(3)}s >= seekTargetTime=${this.seekTargetTime.toFixed(3)}s, calling notifySeekCompletion`,
            );
            this.notifySeekCompletion(frameTime);
          } else {
            this.seekTargetTime = -1;
          }
        }

        this._pictureOwedFrom = -1;
        this.videoRenderer.queueFrame(frame);
      } else {
        frame.close();
      }
    });

    dec.setOnError((error) => {
      Logger.error(TAG, "Video decoder error", error);
      // On a source we KNOW is encrypted, this is where the clear lead ran out.
      // The decoder is telling the truth — it cannot decode these samples — but
      // "Decoding error" describes the symptom and hides the cause, and the
      // cause is one the embedder can act on. Say it plainly instead, and stop
      // pulling: the rest of the file is bytes we can never use, and reading it
      // to the end is what turned this into a hundreds-of-megabytes download.
      if (this._sourceIsEncrypted) {
        this.encryptedSourceGaveUp();
        return;
      }
      this.emit("error", error);
      // Note: Decoder now has built-in recovery, only pauses after MAX_ERRORS
    });

    // When the decoder enters its "skip non-keyframes until next IDR" recovery
    // during normal playback (decode-error recreate, e.g. high-bitrate 1080p
    // H.264 whose HW decoder throws an EncodingError on an IDR), we deliberately
    // do NOT flip into buffering. Per request: the clock and audio keep running
    // and the video simply holds its last frame until the next keyframe lands
    // (~1 GOP), then A/V sync catches the video up with a jump. The stall
    // detector is already suppressed across this window via
    // videoDecoder.isRecentlyRecovering(), so the empty video queue here is not
    // mistaken for a stall. Seeks are handled by the seek pipeline (suppressed
    // here via the state/sync guard).
    dec.onKeyframeWaitChange = (waiting) => {
      const state = this.stateManager.getState();
      // Track the hold so ABR doesn't misread the draining video buffer
      // (clock advancing, video frozen on last frame) as the rung failing.
      this._videoHoldingForKeyframe = waiting && state === "playing";
      if (state === "seeking" || this.waitingForVideoSync) return;
      if (this._videoHoldingForKeyframe) {
        Logger.debug(
          TAG,
          "Decoder waiting for keyframe mid-playback — staying in playing (audio/clock continue, video holds until next keyframe)",
        );
      }
    };
  }

  private decodingOnCpu(): boolean {
    if (webCodecsUnavailable()) return true;
    return this.videoDecoder ? this.videoDecoder.isSoftwareBacked : false;
  }

  /**
   * Does the software-decode ceiling apply to THIS rung?
   *
   * The ceiling exists because the CPU is carrying the decode — but a decoder is
   * chosen per CODEC, and a ladder is usually mixed. Applied to the whole ladder
   * it punished rungs that were never the problem: a 2160p AV1 with no hardware
   * path fell to the WASM decoder, and the correction took the whole ladder down
   * to 480p — past the 1080p H.264 rung sitting right there, which this machine
   * decodes in hardware without noticing. A rung of a different family is an
   * open question, and the decode-bound screen is what answers it; this cap has
   * nothing to say about it.
   *
   * Two cases keep the ceiling ladder-wide: no WebCodecs at all (then every
   * codec is our WASM decoder, family is irrelevant), and a rung whose codec the
   * ladder never declared (nothing to compare — stay conservative).
   */
  private softwareCeilingApplies(rungCodec?: string): boolean {
    if (webCodecsUnavailable()) return true;
    const family = codecFamily(rungCodec);
    const active = codecFamily(this.videoDecoder?.configuredCodec);
    if (!family || !active) return true;
    return family === active;
  }

  /**
   * Embedded cover art for the loaded source, decoded into an ImageBitmap.
   * Null when the source has no attached_pic stream (regular video files,
   * audio files without artwork). Caller MUST NOT close() the bitmap — it
   * is owned by the player and released on destroy() / next load.
   */
  getCoverArt(): ImageBitmap | null {
    return this.coverArt;
  }

  /**
   * Extract embedded cover art once at load and emit a "coverart" event.
   *
   * Runs entirely in a short-lived, isolated thumbnail-style WASM context
   * — the same isolated-demuxer machinery the seek-bar previews use — so
   * reading the artwork packet never moves the MAIN demuxer's file
   * position and therefore can't disturb playback or seeking. Done
   * exactly once (artwork is static), then the context is torn down.
   *
   * Deliberately does NOT surface attached_pic through a new C/WASM
   * StreamInfo field or export: that shifts the WASM memory layout and
   * trips a latent FFmpeg audio overflow into a production-only OOB (see
   * project memory "Album Art Crashes WASM"). Using only the existing
   * thumbnail read/packet exports keeps the WASM binary byte-identical.
   */
  private async extractCoverArt(): Promise<void> {
    // Opt-in via the `thumb` attribute (maps to config.enablePreviews).
    // Without it the audio source just shows the bare strip — no artwork,
    // and no isolated WASM context is spun up at all.
    if (!this.config.enablePreviews) return;

    // Cover art only makes sense for an audio-led source: there must be an
    // audio track and NO real playable video (a real video file's frames
    // are the content, not artwork). getVideoTracks() already excludes the
    // still-image cover stream via the isLikelyCoverArt heuristic, so an
    // audio file with embedded art reports zero video tracks here.
    if (this.trackManager.getAudioTracks().length === 0) return;
    if (this.trackManager.getVideoTracks().length > 0) return;

    const picTracks = this.trackManager.getAttachedPicTracks();
    if (picTracks.length === 0) return;
    // Past this point an art track exists, so the UI is holding off the
    // audio-strip layout waiting for a bitmap. Emit a null "coverart" on every
    // failure exit so the element can stop waiting and fall back to the strip
    // instead of sitting on a blank surface forever.
    if (!this.source || this.fileSize <= 0) {
      this.emit("coverart", null);
      return;
    }

    try {
      // Demuxer owns the isolated-context read; we just turn the encoded
      // bytes into a bitmap and publish it.
      const data = await Demuxer.extractAttachedPicture(
        this.source,
        this.fileSize,
        this.config.wasmBinary,
      );
      if (!data || data.length === 0) {
        this.emit("coverart", null);
        return;
      }

      const codec = (picTracks[0].codec || "").toLowerCase();
      const mime =
        codec === "png"
          ? "image/png"
          : codec === "mjpeg" || codec === "jpeg" || codec === "jpg"
            ? "image/jpeg"
            : codec === "webp"
              ? "image/webp"
              : "image/*";
      // getPacketDataCopy already .slice()s into a fresh, non-shared
      // ArrayBuffer, so it's safe to hand straight to Blob.
      const blob = new Blob([data.buffer as ArrayBuffer], { type: mime });
      const bitmap = await createImageBitmap(blob);

      // Release the previous bitmap before stomping the reference — a stale
      // load → load sequence (playlist next-track) would otherwise leak GPU
      // memory until the next GC cycle.
      this.coverArt?.close?.();
      this.coverArt = bitmap;

      this.emit("coverart", bitmap);
      Logger.info(
        TAG,
        `Cover art extracted: ${bitmap.width}x${bitmap.height} (${codec || "image"})`,
      );
    } catch (err) {
      Logger.warn(TAG, "Cover art extraction failed", err);
      this.emit("coverart", null);
    }
  }

  /**
   * Destroy player and release resources
   */
  destroy(): void {
    Logger.info(TAG, "Destroying player");
    this._destroyed = true;
    // First, before any of the teardown below. Everything this player has in
    // flight — probes, subtitle segments, manifest fetches, ranged reads —
    // carries this signal, and the point of it is that they stop the moment the
    // player does rather than finishing into a void. The sources are closed
    // further down as well; that is belt and braces, not the mechanism.
    this._lifetimeAbort.abort();
    if (this._switchTraceTimer !== null) {
      clearInterval(this._switchTraceTimer);
      this._switchTraceTimer = null;
    }

    // Stop driving a host subtitle renderer, but DON'T destroy it — the renderer
    // is owned by whoever registered it (the element re-applies it to the fresh
    // player after a source change, so destroying it here would kill it mid-swap).
    // The registrar owns destroy(): the element does it on disconnect / on swap.
    this._stopSubtitleRenderLoop();
    this._customSubtitleRenderer = null;
    this._subtitleLayer?.remove();
    this._subtitleLayer = null;

    // Cancel a pending deferred preview warm-up.
    if (this._previewWarmTimer) {
      clearTimeout(this._previewWarmTimer);
      this._previewWarmTimer = null;
    }

    // Stop the ABR timer.
    if (this._abrTimer) {
      clearInterval(this._abrTimer);
      this._abrTimer = null;
    }
    this.cancelBlackFrameWatchdog();

    // Release WakeLock
    this.releaseWakeLock();

    // Stop playback
    this.clock.pause();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.stopBackgroundTimer();
    this.stopPauseBuffering();

    // A rendition switch caught mid-prep. Its source is downloading right now
    // and is not `this.source` yet, so nothing below would ever reach it.
    if (this._pendingSwitchDemuxer) {
      try {
        this._pendingSwitchDemuxer.close();
      } catch {}
      this._pendingSwitchDemuxer = null;
    }
    if (this._pendingSwitchSource) {
      try {
        this._pendingSwitchSource.close();
      } catch {}
      this._pendingSwitchSource = null;
    }

    // Tear down the split (separate-URL) WASM audio pipeline.
    this.stopAudioLoop();
    if (this.audioDemuxer) {
      this.audioDemuxer.close();
      this.audioDemuxer = null;
      this.splitAudioQueue.clear();
    }
    if (this.audioSource) {
      try {
        this.audioSource.close();
      } catch {}
      this.audioSource = null;
    }

    // Destroy the adaptive-streaming wrapper (HLS or DASH, via Shaka)
    if (this.streamWrapper) {
      this.streamWrapper.destroy();
      this.streamWrapper = null;
    }

    this.clearPacketQueues();

    // Close resources
    this.videoDecoder.close();
    this.audioDecoder.close();

    if (this.videoRenderer) {
      this.videoRenderer.destroy();
    }
    this.audioRenderer.destroy();

    // Close demuxer
    if (this.demuxer) {
      this.demuxer.close();
      this.demuxer = null;
    }

    // Cleanup external subtitles
    this.stopExternalSubtitles();
    this._externalSubCues = [];
    this._subtitleTracks = [];

    // Tear down the thumbnail (seek-preview) pipeline. It is a SECOND, fully
    // independent stack — its own isolated WASM module and FFmpeg context, its
    // own WebCodecs decoder, its own WebGL context, its own HTTP source — and
    // none of it was being released. A host that rebuilds the player per video
    // (the common pattern) therefore leaked one of each per video, and the
    // WebGL contexts are the sharp end: Chrome caps a page at ~16, after which
    // it starts killing the oldest — which may belong to the player on screen.
    this.destroyPreviewPipeline();

    // Close source
    if (this.source) {
      this.source.close();
      this.source = null;
    }

    // Clear cache
    this.cache.clear();

    // Clear track manager
    this.trackManager.clear();

    // Release cover art bitmap. close() is a no-op on platforms that
    // don't implement it (older Firefox); guard with optional call.
    this.coverArt?.close?.();
    this.coverArt = null;

    // Reset state
    this.stateManager.reset();
    this.mediaInfo = null;

    // Remove all listeners
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    window.removeEventListener("online", this.handleNetworkOnline);
    this.removeAllListeners();

    Logger.info(TAG, "Player destroyed");
  }
}
