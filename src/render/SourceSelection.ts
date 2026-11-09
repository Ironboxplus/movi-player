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
}

/** An in-band track of a source that was open earlier. */
export interface InbandSlot {
  order: number;
  title: string;
}

export interface ExternalSubtitle {
  lang: string;
  label: string;
  active: boolean;
  pending?: boolean;
  inbandTitle?: string;
  inbandOrder?: number;
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

/**
 * An alias is believed only when what it points at agrees. By index first, then
 * by title: a mismatch means the host's idea of the track list is not this
 * file's, and a duplicated subtitle is a smaller mistake than the wrong one.
 * With nothing to check against (the original was never opened) it is trusted.
 */
function confirms(input: SubtitleMenuInput, order: number, title: string): boolean {
  if (input.inband.length > 0) {
    const t = input.inband[order];
    return !!t && sameTitle(t.title, title);
  }
  if (input.remembered && input.remembered.length > 0) {
    const slot = input.remembered.find((s) => s.order === order);
    return !!slot && sameTitle(slot.title, title);
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
      title &&
      !accepted.has(order) &&
      confirms(input, order, title)
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
        // Named for the track it stands for, not for the extracted file.
        label: (ext.inbandTitle || "").trim(),
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
