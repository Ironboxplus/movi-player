/**
 * Decisions that tie the `<source>` list and the subtitle menu together.
 *
 * Kept free of the DOM and of MoviElement's state so they can be tested in
 * node: MoviElement itself needs a custom-element registry and a live player
 * (see test/render/automatic-software-fallback-source.test.ts for the same
 * constraint), and what is worth pinning here is the DECISION, not the markup.
 *
 * The model follows the HTML media-element loading algorithm: switching the
 * resource forgets the tracks the resource carried in-band, and keeps the
 * out-of-band `<track>` children. A host that lists the same subtitle both as
 * an in-band track of one source and as an extracted file for another (a cloud
 * transcode has no in-band subtitles) says so with `data-inband-title` and
 * `data-inband-order` on the `<track>`; the pieces below turn that into one
 * logical subtitle list that does not depend on which source is playing.
 */

/** A `.m3u8` anywhere in the URL, the same test the element has always used to
 *  decide a source is adaptive (a host appends `#.m3u8` to hint a signed URL). */
const HLS_URL = /\.m3u8/i;
const ADAPTIVE_URL = /\.(m3u8|mpd)/i;

export function isHlsSource(src: unknown): boolean {
  return typeof src === "string" && HLS_URL.test(src);
}

function isAdaptiveSource(src: unknown): boolean {
  return typeof src === "string" && ADAPTIVE_URL.test(src);
}

export interface LadderEntry {
  src: string;
}

/**
 * Auto (the ABR) swaps renditions in place by byte range, which an HLS source
 * cannot do, and a list that mixes an original file with transcodes is not a
 * ladder of one picture at several bitrates anyway: Auto would start on the
 * smallest entry, which for such a list is the 360P transcode, not the file.
 * Any HLS entry in a multi-source list therefore turns Auto off.
 */
export function autoQualityAllowed(ladder: readonly LadderEntry[]): boolean {
  return !ladder.some((q) => isHlsSource(q.src));
}

export type QualityMenuMode = "sources" | "dash" | "levels" | "none";

/**
 * Which quality menu to draw. A declared `<source>` list wins over everything,
 * including an adaptive source that is playing right now: the list is what the
 * host offered, and an HLS entry in it used to make the menu vanish, leaving
 * no way back to the entry that was not HLS.
 */
export function qualityMenuMode(args: {
  currentSrc: unknown;
  ladder: readonly LadderEntry[];
  dashRenditionCount: number;
}): QualityMenuMode {
  if (args.ladder.length > 1) return "sources";
  if (!isAdaptiveSource(args.currentSrc)) return "none";
  return args.dashRenditionCount > 1 ? "dash" : "levels";
}

/**
 * The source to open first. Under Auto the smallest entry opens (the speed
 * test is the playback itself); without Auto, or where Auto is not allowed,
 * the host's `data-default` stands.
 */
export function chooseOpeningSource(args: {
  ladder: readonly LadderEntry[];
  declaredDefault: string | undefined;
  fallback: string;
  autoPref: boolean;
  smallest: string | undefined;
}): string {
  if (
    args.ladder.length > 1 &&
    args.autoPref &&
    autoQualityAllowed(args.ladder) &&
    args.smallest
  ) {
    return args.smallest;
  }
  return args.declaredDefault ?? args.fallback;
}

// ── Subtitles ───────────────────────────────────────────────────────────────

/** An in-band subtitle track of the source that is open, in container order. */
export interface InbandTrack {
  id: number;
  title: string;
  /** The container's language code, when it has one. */
  lang?: string;
  /** `title` is made up (the container gave the track no name). */
  untitled?: boolean;
}

/** An in-band track of a source that was open earlier. */
export interface InbandSlot {
  order: number;
  title: string;
  lang?: string;
  untitled?: boolean;
}

export interface ExternalSubtitle {
  lang: string;
  label: string;
  active: boolean;
  pending?: boolean;
  inbandTitle?: string;
  inbandOrder?: number;
  /** Language of the in-band track the file stands for (`data-inband-lang`). */
  inbandLang?: string;
}

export type SubtitleMenuEntry = (
  | { kind: "muxed"; id: number }
  | { kind: "external"; lang: string; pending?: boolean }
  | { kind: "original-only" }
) & {
  label: string;
  /** The logical subtitle this row stands for, stable across sources. */
  identity: string;
  active: boolean;
};

export interface SubtitleMenuInput {
  /** In-band tracks of the source that is playing. Empty for HLS. */
  inband: readonly InbandTrack[];
  external: readonly ExternalSubtitle[];
  /** In-band tracks of the non-HLS source opened earlier, if any. */
  remembered?: readonly InbandSlot[];
}

function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The codes one language goes by: ISO 639-2/B, 639-2/T and 639-1. A code in no
 *  group stands for itself. */
const LANGUAGE_GROUPS: readonly (readonly string[])[] = [
  ["chi", "zho", "zh", "cmn", "yue"], ["eng", "en"], ["jpn", "ja"], ["kor", "ko"],
  ["spa", "es"], ["fre", "fra", "fr"], ["ger", "deu", "de"], ["ita", "it"],
  ["por", "pt"], ["rus", "ru"], ["ara", "ar"], ["tha", "th"], ["vie", "vi"],
  ["may", "msa", "ms"], ["ind", "id"], ["hin", "hi"], ["tur", "tr"], ["pol", "pl"],
  ["dut", "nld", "nl"], ["swe", "sv"], ["dan", "da"], ["nor", "no", "nob"], ["fin", "fi"],
  ["cze", "ces", "cs"], ["gre", "ell", "el"], ["heb", "he"], ["hun", "hu"], ["ukr", "uk"],
];

function languageKey(l: string | undefined): string {
  let k = (l || "").trim().toLowerCase();
  const cut = k.search(/[-_]/);
  if (cut > 0) k = k.slice(0, cut);
  return LANGUAGE_GROUPS.find((g) => g.includes(k))?.[0] ?? k;
}

/** Two language codes agree unless both are known and differ: a missing or
 *  "und" code says nothing. */
function sameLanguage(a: string | undefined, b: string | undefined): boolean {
  const ka = languageKey(a);
  const kb = languageKey(b);
  return !ka || !kb || ka === "und" || kb === "und" || ka === kb;
}

/**
 * An alias is believed only when what it points at agrees. By index first, then
 * by title: a mismatch means the host's idea of the track list is not this
 * file's, and a duplicated subtitle is a smaller mistake than the wrong one.
 * Where either side has no title (a track the container left unnamed) the
 * languages decide instead: a title that is not there cannot disagree, and the
 * order has already matched.
 * With nothing to check against (the original was never opened) it is trusted.
 */
function confirms(
  input: SubtitleMenuInput,
  order: number,
  title: string,
  lang: string | undefined,
): boolean {
  const agrees = (t: { title: string; lang?: string; untitled?: boolean }) =>
    title && t.title.trim() && !t.untitled
      ? sameTitle(t.title, title)
      : sameLanguage(t.lang, lang);
  if (input.inband.length > 0) {
    const t = input.inband[order];
    return !!t && agrees(t);
  }
  if (input.remembered && input.remembered.length > 0) {
    const slot = input.remembered.find((s) => s.order === order);
    return !!slot && agrees(slot);
  }
  return true;
}

function classify(input: SubtitleMenuInput) {
  const accepted = new Map<number, ExternalSubtitle>();
  const plain: ExternalSubtitle[] = [];
  for (const ext of input.external) {
    const order = ext.inbandOrder;
    const title = (ext.inbandTitle || "").trim();
    if (
      typeof order === "number" &&
      Number.isInteger(order) &&
      order >= 0 &&
      !accepted.has(order) &&
      confirms(input, order, title, ext.inbandLang)
    ) {
      accepted.set(order, ext);
    } else {
      plain.push(ext);
    }
  }
  return { accepted, plain };
}

/**
 * External subtitles the source's own in-band track stands in for. They stay
 * registered with the player (they are what plays on a rendition) but must not
 * be offered, cycled to or restored while the original is open.
 */
export function hiddenExternalLangs(input: SubtitleMenuInput): Set<string> {
  if (input.inband.length === 0) return new Set();
  return new Set([...classify(input).accepted.values()].map((e) => e.lang));
}

export function buildSubtitleMenu(
  input: SubtitleMenuInput & { activeMuxedId: number | null },
): SubtitleMenuEntry[] {
  const { accepted, plain } = classify(input);
  const entries: SubtitleMenuEntry[] = [];

  if (input.inband.length > 0) {
    input.inband.forEach((t, i) => {
      entries.push({
        kind: "muxed",
        id: t.id,
        label: t.title,
        identity: `inband:${i}`,
        active: input.activeMuxedId === t.id,
      });
    });
  } else {
    const slots = new Map<number, SubtitleMenuEntry>();
    for (const [order, ext] of accepted) {
      slots.set(order, {
        kind: "external",
        lang: ext.lang,
        // Named for the track it stands for, not for the extracted file (which
        // names it only when the track has no name).
        label: (ext.inbandTitle || "").trim() || ext.label,
        identity: `inband:${order}`,
        active: ext.active,
        ...(ext.pending ? { pending: true } : {}),
      });
    }
    for (const s of input.remembered ?? []) {
      if (slots.has(s.order)) continue;
      slots.set(s.order, {
        kind: "original-only",
        label: s.title,
        identity: `inband:${s.order}`,
        active: false,
      });
    }
    entries.push(
      ...[...slots.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e),
    );
  }

  for (const ext of plain) {
    entries.push({
      kind: "external",
      lang: ext.lang,
      label: ext.label,
      identity: `ext:${ext.lang}`,
      active: ext.active,
      ...(ext.pending ? { pending: true } : {}),
    });
  }
  return entries;
}

/**
 * A declared `<track>` was pointed at another file. Returns the entry now
 * holding the new `src`, or null when there is nothing to load again: no such
 * track, an empty `src`, or the one it already had.
 */
export function retargetTrack<T extends { lang: string; src: string }>(
  tracks: readonly T[],
  lang: string,
  src: string,
): T | null {
  const track = tracks.find((t) => t.lang === lang);
  if (!track || !src || track.src === src) return null;
  track.src = src;
  return track;
}

export interface ChildTrackChange<T> {
  added: T[];
  removed: T[];
}

/**
 * The `<track>` children changed while the `<source>` ones did not. `held` is
 * the element's external subtitle list, `childLangs` the part of it that came
 * from `<track>` children (a list the host passed in JS is not the children's
 * to take away), `declared` what the children say now. A track is known by its
 * `lang`, the key the menu and the player use; a new `src` on a known one is
 * `retargetTrack`'s business, not a change of the list.
 */
export function reconcileChildTracks<T extends { lang: string }>(
  held: readonly T[],
  childLangs: readonly string[],
  declared: readonly T[],
): ChildTrackChange<T> {
  const have = new Set(held.map((t) => t.lang));
  const now = new Set(declared.map((t) => t.lang));
  const fromChildren = new Set(childLangs);
  return {
    added: declared.filter((t) => !have.has(t.lang)),
    removed: held.filter((t) => fromChildren.has(t.lang) && !now.has(t.lang)),
  };
}

/** The events a change of the list is announced with, as on a media element's
 *  `textTracks`: `removetrack` for each track that left, `addtrack` for each
 *  that joined. */
export function trackEvents<T>(
  change: ChildTrackChange<T>,
): { type: "addtrack" | "removetrack"; track: T }[] {
  return [
    ...change.removed.map((track) => ({ type: "removetrack" as const, track })),
    ...change.added.map((track) => ({ type: "addtrack" as const, track })),
  ];
}

export function identityOfExternal(input: SubtitleMenuInput, lang: string): string {
  const { accepted } = classify(input);
  for (const [order, ext] of accepted) {
    if (ext.lang === lang) return `inband:${order}`;
  }
  return `ext:${lang}`;
}

export function identityOfMuxed(input: SubtitleMenuInput, id: number): string | null {
  const i = input.inband.findIndex((t) => t.id === id);
  return i >= 0 ? `inband:${i}` : null;
}

/** The logical subtitle showing now, or null when subtitles are off. Reads the
 *  external list as given, so a hidden alias that is active still counts. */
export function activeIdentity(
  input: SubtitleMenuInput & { activeMuxedId: number | null },
): string | null {
  const ext = input.external.find((e) => e.active);
  if (ext) return identityOfExternal(input, ext.lang);
  if (input.activeMuxedId !== null) return identityOfMuxed(input, input.activeMuxedId);
  return null;
}

/** The row to select for an identity on the source that is open now. A greyed
 *  row is not selectable: nothing in this source can show it. */
export function resolveIdentity(
  entries: readonly SubtitleMenuEntry[],
  identity: string,
): SubtitleMenuEntry | null {
  return (
    entries.find((e) => e.identity === identity && e.kind !== "original-only") ?? null
  );
}
