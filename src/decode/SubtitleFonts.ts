/**
 * Fonts that travel with a subtitle: which container attachments are fonts,
 * which family names they answer to, and which of them an ASS script uses.
 *
 * The rules follow mpv (sub/sd_ass.c: font_mimetypes, attachment_is_font) and
 * libass: an attachment is a font by MIME type, or by file extension when the
 * muxer got the MIME type wrong; the script's `Fontname` (and any `\fn`) is
 * looked up among the registered fonts by family name before the default font
 * is used. What this adds is the economy: the attachments are not downloaded
 * to find out what they are called. The name table of an sfnt font sits in its
 * first few KB, so two small ranged reads per font say which family it is and
 * only the fonts a script asks for are fetched in full.
 */

/** mpv sub/sd_ass.c `font_mimetypes`, compared exactly like mpv does. */
export const FONT_MIMETYPES: readonly string[] = [
  "application/x-truetype-font",
  "application/vnd.ms-opentype",
  "application/x-font-otf",
  "application/x-font-ttf",
  "application/x-font", // probably incorrect, as mpv's own comment says
  "application/font-sfnt",
  "font/collection",
  "font/otf",
  "font/sfnt",
  "font/ttf",
];

/** mpv `font_exts`: the fallback for a muxer that wrote the wrong MIME type. */
export const FONT_EXTENSIONS: readonly string[] = [".ttf", ".ttc", ".otf", ".otc"];

export interface AttachmentLike {
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * mpv's attachment_is_font: needs a name, a type and a body; then the MIME
 * type, then the last four characters of the name, case-insensitively.
 */
export function isFontAttachment(a: AttachmentLike): boolean {
  if (!a.filename || !a.mimeType || !(a.size > 0)) return false;
  if (FONT_MIMETYPES.includes(a.mimeType)) return true;
  const ext = a.filename.length > 4 ? a.filename.slice(-4).toLowerCase() : "";
  return FONT_EXTENSIONS.includes(ext);
}

// ── sfnt name table ─────────────────────────────────────────────────────────

/** Reads `length` bytes at `offset`; may return fewer at the end of the file. */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

const NAME_IDS = new Set([
  1, // family
  4, // full name
  6, // PostScript name
  16, // typographic family
]);

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function decodeNameString(bytes: Uint8Array, platform: number): string {
  // Platforms 0 (Unicode) and 3 (Windows) store UTF-16BE; platform 1 (Mac) is
  // MacRoman, of which the ASCII range is all a family name needs.
  if (platform === 0 || platform === 3) {
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return s;
  }
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** The names in a `name` table, lowercased: family, full, PostScript, typographic. */
export function parseNameTable(table: Uint8Array): string[] {
  if (table.length < 6) return [];
  const v = view(table);
  const count = v.getUint16(2);
  const stringsAt = v.getUint16(4);
  const out = new Set<string>();
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > table.length) break;
    const platform = v.getUint16(rec);
    const nameId = v.getUint16(rec + 6);
    if (!NAME_IDS.has(nameId)) continue;
    const length = v.getUint16(rec + 8);
    const offset = stringsAt + v.getUint16(rec + 10);
    if (offset + length > table.length) continue;
    const s = decodeNameString(table.subarray(offset, offset + length), platform)
      .trim()
      .toLowerCase();
    if (s) out.add(s);
  }
  return [...out];
}

const tag = (b: Uint8Array, at: number) =>
  String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

// Enough for the sfnt header and the table records of any real font (62 of
// them), so the directory costs one read.
const DIRECTORY_READ = 1024;
// A name table is a few KB; the cap keeps a broken length field from asking
// for the whole file.
const NAME_TABLE_CAP = 256 * 1024;

async function sfntNames(
  read: RangeReader,
  base: number,
  fileSize: number,
  preloaded?: Uint8Array,
): Promise<string[]> {
  const dir = preloaded ?? (await read(base, DIRECTORY_READ));
  if (dir.length < 12) return [];
  const numTables = view(dir).getUint16(4);
  let records = dir;
  const need = 12 + numTables * 16;
  if (dir.length < need && base + dir.length < fileSize) {
    records = await read(base, need);
  }
  if (records.length < need) return [];
  const v = view(records);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (tag(records, rec) !== "name") continue;
    const offset = v.getUint32(rec + 8);
    const length = Math.min(v.getUint32(rec + 12), NAME_TABLE_CAP);
    if (length < 6 || offset + length > fileSize) return [];
    return parseNameTable(await read(offset, length));
  }
  return [];
}

/**
 * The names one font file answers to (lowercased). A TrueType Collection
 * lists every member's names. Two ranged reads for a plain font — the
 * directory, then the name table — and the same per extra member of a
 * collection. Never throws: a font that cannot be read has no names.
 */
export async function readFontNames(read: RangeReader, fileSize: number): Promise<string[]> {
  try {
    const head = await read(0, DIRECTORY_READ);
    if (head.length < 12) return [];
    if (tag(head, 0) !== "ttcf") return await sfntNames(read, 0, fileSize, head);
    const v = view(head);
    const numFonts = Math.min(v.getUint32(8), 256);
    const names = new Set<string>();
    for (let i = 0; i < numFonts; i++) {
      const at = 12 + i * 4;
      if (at + 4 > head.length) break;
      for (const n of await sfntNames(read, v.getUint32(at), fileSize)) names.add(n);
    }
    return [...names];
  } catch {
    return [];
  }
}

// ── What an ASS script asks for ─────────────────────────────────────────────

const normalizeFontName = (name: string) =>
  name.trim().replace(/^@/, "").toLowerCase();

/** The `Fontname` of every style in an ASS header (`[V4+ Styles]`/`[V4 Styles]`). */
export function styleFontNames(header: string | Uint8Array): string[] {
  const text = typeof header === "string" ? header : new TextDecoder().decode(header);
  const out = new Set<string>();
  let inStyles = false;
  let col = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inStyles = /^\[v4\+? styles\]$/i.test(line);
      col = -1;
      continue;
    }
    if (!inStyles) continue;
    if (/^format\s*:/i.test(line)) {
      col = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((c) => c.trim().toLowerCase())
        .indexOf("fontname");
    } else if (/^style\s*:/i.test(line) && col >= 0) {
      const name = line.slice(line.indexOf(":") + 1).split(",")[col];
      if (name && normalizeFontName(name)) out.add(normalizeFontName(name));
    }
  }
  return [...out];
}

/** The fonts an event's text switches to with `\fn`. */
export function overrideFontNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\\fn([^\\}]+)/g)) {
    const n = normalizeFontName(m[1]);
    if (n) out.add(n);
  }
  return [...out];
}

// ── Catalog ─────────────────────────────────────────────────────────────────

export interface FontAttachment {
  filename: string;
  mimeType: string;
  offset: number;
  size: number;
}

/**
 * The font attachments of one open file, named on demand and fetched on demand.
 *
 * `read` reads from the media source (the same source the demuxer reads), so a
 * font is a ranged request into the file and nothing more. A font is fetched
 * at most once; asking again for a name it already supplied returns nothing
 * new, which is what lets the caller hand each result straight to the renderer.
 */
export class FontCatalog {
  private fonts: FontAttachment[];
  private names = new Map<FontAttachment, Promise<string[]>>();
  private fetched = new Set<FontAttachment>();

  constructor(
    attachments: readonly (AttachmentLike & { offset: number })[],
    private read: RangeReader,
    private concurrency = 4,
  ) {
    // An attachment the demuxer had to read at open (offset -1) has no place
    // in the file to fetch it from.
    this.fonts = attachments
      .filter((a) => a.offset >= 0 && isFontAttachment(a))
      .map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        offset: a.offset,
        size: a.size,
      }));
  }

  get count(): number {
    return this.fonts.length;
  }

  private namesOf(f: FontAttachment): Promise<string[]> {
    let p = this.names.get(f);
    if (!p) {
      p = readFontNames((o, l) => this.read(f.offset + o, Math.min(l, f.size - o)), f.size);
      this.names.set(f, p);
    }
    return p;
  }

  /** Name every font (a few small reads each), a few at a time. */
  async index(): Promise<void> {
    const queue = [...this.fonts];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await this.namesOf(f);
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, queue.length) }, worker),
    );
  }

  /**
   * The bodies of the fonts that answer to any of `wanted` (family names, any
   * case) and have not been supplied yet. Reads the whole font only for those.
   */
  async fontsFor(wanted: readonly string[]): Promise<Uint8Array[]> {
    const want = new Set(wanted.map(normalizeFontName).filter(Boolean));
    if (!want.size) return [];
    await this.index();
    const out: Uint8Array[] = [];
    for (const f of this.fonts) {
      if (this.fetched.has(f)) continue;
      const names = await this.namesOf(f);
      if (!names.some((n) => want.has(n))) continue;
      this.fetched.add(f);
      const body = await this.read(f.offset, f.size);
      if (body.length === f.size) out.push(body);
      else this.fetched.delete(f);
    }
    return out;
  }

  /** Whether some font here answers to `name` (after `index()`). */
  async has(name: string): Promise<boolean> {
    await this.index();
    const n = normalizeFontName(name);
    for (const f of this.fonts) if ((await this.namesOf(f)).includes(n)) return true;
    return false;
  }
}
