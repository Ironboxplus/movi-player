import { describe, expect, it } from "vitest";
import {
  FontCatalog,
  isFontAttachment,
  overrideFontNames,
  parseNameTable,
  readFontNames,
  styleFontNames,
} from "../../src/decode/SubtitleFonts";

// ── Minimal sfnt builders ───────────────────────────────────────────────────
// Just what the name-table reader looks at: the table directory and a `name`
// table, with the table offsets absolute in the file the way a TrueType
// Collection requires. The real-font run (MKV with DejaVu attachments) is in
// test/demux/attachments-real-wasm.test.ts.

const utf16be = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    b[i * 2] = s.charCodeAt(i) >> 8;
    b[i * 2 + 1] = s.charCodeAt(i) & 0xff;
  }
  return b;
};
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

interface NameRec {
  platform: number;
  id: number;
  text: string;
}

function nameTable(recs: NameRec[]): Uint8Array {
  const strings = recs.map((r) => (r.platform === 1 ? ascii(r.text) : utf16be(r.text)));
  const head = 6 + recs.length * 12;
  const total = head + strings.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(2, recs.length);
  v.setUint16(4, head);
  let at = 0;
  recs.forEach((r, i) => {
    const rec = 6 + i * 12;
    v.setUint16(rec, r.platform);
    v.setUint16(rec + 2, r.platform === 1 ? 0 : 1);
    v.setUint16(rec + 4, 0);
    v.setUint16(rec + 6, r.id);
    v.setUint16(rec + 8, strings[i].length);
    v.setUint16(rec + 10, at);
    out.set(strings[i], head + at);
    at += strings[i].length;
  });
  return out;
}

const pad4 = (n: number) => (n + 3) & ~3;

function sfnt(tables: { tag: string; data: Uint8Array }[], base = 0): Uint8Array {
  const dir = 12 + tables.length * 16;
  let at = base + dir;
  const placed = tables.map((t) => {
    const p = { ...t, offset: at };
    at += pad4(t.data.length);
    return p;
  });
  const out = new Uint8Array(at - base);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, tables.length);
  placed.forEach((t, i) => {
    const rec = 12 + i * 16;
    out.set(ascii(t.tag), rec);
    v.setUint32(rec + 8, t.offset);
    v.setUint32(rec + 12, t.data.length);
    out.set(t.data, t.offset - base);
  });
  return out;
}

const font = (family: string, base = 0, extra: NameRec[] = []) =>
  sfnt(
    [
      { tag: "head", data: new Uint8Array(54) },
      // Glyph data stands in for the bulk of a real font: the body is far
      // bigger than the directory read, so a body read is told apart by size.
      { tag: "glyf", data: new Uint8Array(5000) },
      { tag: "name", data: nameTable([{ platform: 3, id: 1, text: family }, ...extra]) },
    ],
    base,
  );

function collection(families: string[]): Uint8Array {
  const headSize = 12 + families.length * 4;
  const sizes = families.map((f) => font(f, 0).length);
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = headSize;
  families.forEach((f, i) => {
    offsets.push(at);
    parts.push(font(f, at));
    at += sizes[i];
  });
  const out = new Uint8Array(at);
  const v = new DataView(out.buffer);
  out.set(ascii("ttcf"), 0);
  v.setUint32(4, 0x00010000);
  v.setUint32(8, families.length);
  offsets.forEach((o, i) => v.setUint32(12 + i * 4, o));
  parts.forEach((p, i) => out.set(p, offsets[i]));
  return out;
}

const reader = (file: Uint8Array) => {
  const calls: [number, number][] = [];
  const read = async (offset: number, length: number) => {
    calls.push([offset, length]);
    return file.slice(offset, offset + length);
  };
  return { read, calls };
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("isFontAttachment (mpv sub/sd_ass.c attachment_is_font)", () => {
  const a = (filename: string, mimeType: string, size = 10) => ({ filename, mimeType, size });

  it.each([
    "application/x-truetype-font",
    "application/vnd.ms-opentype",
    "application/x-font-otf",
    "application/x-font-ttf",
    "application/x-font",
    "application/font-sfnt",
    "font/collection",
    "font/otf",
    "font/sfnt",
    "font/ttf",
  ])("accepts MIME type %s whatever the name", (mime) => {
    expect(isFontAttachment(a("whatever.bin", mime))).toBe(true);
  });

  it("falls back to the extension when the MIME type is wrong, any case", () => {
    for (const name of ["a.ttf", "a.TTC", "a.OtF", "dir/a.otc"]) {
      expect(isFontAttachment(a(name, "application/octet-stream"))).toBe(true);
    }
  });

  it("rejects what is neither", () => {
    expect(isFontAttachment(a("cover.jpg", "image/jpeg"))).toBe(false);
    expect(isFontAttachment(a("notes.txt", "text/plain"))).toBe(false);
    expect(isFontAttachment(a("font.woff2", "font/woff2"))).toBe(false);
  });

  it("compares the MIME type exactly, as mpv does", () => {
    expect(isFontAttachment(a("a.bin", "FONT/TTF"))).toBe(false);
    expect(isFontAttachment(a("a.bin", "font/ttf; charset=binary"))).toBe(false);
  });

  it("needs a name, a type and a body", () => {
    expect(isFontAttachment(a("", "font/ttf"))).toBe(false);
    expect(isFontAttachment(a("a.ttf", ""))).toBe(false);
    expect(isFontAttachment(a("a.ttf", "font/ttf", 0))).toBe(false);
  });

  it("matches the extension on the last four characters of a longer name only", () => {
    // mpv: strlen(name) > 4, so a bare ".ttf" is not a font by extension.
    expect(isFontAttachment(a(".ttf", "x/y"))).toBe(false);
    expect(isFontAttachment(a("x.ttf", "x/y"))).toBe(true);
  });
});

describe("parseNameTable", () => {
  it("reads family, full, PostScript and typographic names, lowercased", () => {
    const t = nameTable([
      { platform: 3, id: 1, text: "Noto Sans" },
      { platform: 3, id: 2, text: "Bold" },
      { platform: 3, id: 4, text: "Noto Sans Bold" },
      { platform: 3, id: 6, text: "NotoSans-Bold" },
      { platform: 3, id: 16, text: "Noto Sans Display" },
    ]);
    expect(parseNameTable(t).sort()).toEqual(
      ["noto sans", "noto sans bold", "notosans-bold", "noto sans display"].sort(),
    );
  });

  it("decodes UTF-16 names outside ASCII", () => {
    const t = nameTable([{ platform: 3, id: 1, text: "思源黑体 CN" }]);
    expect(parseNameTable(t)).toEqual(["思源黑体 cn"]);
  });

  it("reads Macintosh-platform names", () => {
    const t = nameTable([{ platform: 1, id: 1, text: "Old Mac Font" }]);
    expect(parseNameTable(t)).toEqual(["old mac font"]);
  });

  it("survives a table that lies about its size", () => {
    const t = nameTable([{ platform: 3, id: 1, text: "Fine" }]);
    expect(parseNameTable(t.subarray(0, 10))).toEqual([]);
    expect(parseNameTable(new Uint8Array(3))).toEqual([]);
  });
});

describe("readFontNames", () => {
  it("names a plain font with two ranged reads", async () => {
    const f = font("Example Sans", 0, [{ platform: 3, id: 4, text: "Example Sans Regular" }]);
    const { read, calls } = reader(f);
    expect((await readFontNames(read, f.length)).sort()).toEqual([
      "example sans",
      "example sans regular",
    ]);
    expect(calls).toHaveLength(2);
    // …and neither read is the whole file's worth for a real font: the name
    // table is a slice at its own offset.
    expect(calls[1][0]).toBeGreaterThan(0);
  });

  it("names every member of a TrueType Collection", async () => {
    const f = collection(["Family One", "Family Two"]);
    const { read } = reader(f);
    expect((await readFontNames(read, f.length)).sort()).toEqual(["family one", "family two"]);
  });

  it("returns nothing for what is not a font, without throwing", async () => {
    const junk = new Uint8Array(4096).fill(7);
    expect(await readFontNames(reader(junk).read, junk.length)).toEqual([]);
    expect(await readFontNames(reader(new Uint8Array(5)).read, 5)).toEqual([]);
    const failing = async () => {
      throw new Error("network");
    };
    expect(await readFontNames(failing, 100)).toEqual([]);
  });

  it("refuses a name table that points past the end of the file", async () => {
    const f = font("Example Sans");
    const cut = f.slice(0, f.length - 20);
    expect(await readFontNames(reader(cut).read, cut.length)).toEqual([]);
  });
});

describe("what an ASS script asks for", () => {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour",
    "Style: Default,Arial,40,&H00FFFFFF",
    "Style: Sign,@Noto Sans CJK SC,36,&H00FFFFFF",
    "Style: Again,arial,36,&H00FFFFFF",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\r\n");

  it("lists each style's Fontname once, lowercased, without the vertical @", () => {
    expect(styleFontNames(header).sort()).toEqual(["arial", "noto sans cjk sc"]);
  });

  it("finds the Fontname column wherever the Format line puts it", () => {
    const h = "[V4 Styles]\nFormat: Name, Fontsize, Fontname\nStyle: S,20,Comic Neue";
    expect(styleFontNames(h)).toEqual(["comic neue"]);
  });

  it("reads a Uint8Array header", () => {
    expect(styleFontNames(new TextEncoder().encode(header)).length).toBe(2);
  });

  it("ignores Fontname-looking text outside the styles section", () => {
    expect(styleFontNames("[Events]\nStyle: x,Not A Font,1")).toEqual([]);
  });

  it("finds \\fn overrides in an event", () => {
    expect(overrideFontNames("{\\fnImpact\\b1}Hi{\\fn Courier New }there{\\fn}")).toEqual([
      "impact",
      "courier new",
    ]);
    expect(overrideFontNames("no overrides")).toEqual([]);
  });
});

describe("FontCatalog", () => {
  const fontA = font("Alpha Sans", 0);
  const fontB = font("Beta Serif", 0);
  const file = new Uint8Array(1000 + fontA.length + 100 + fontB.length);
  const offA = 1000;
  const offB = 1000 + fontA.length + 100;
  file.set(fontA, offA);
  file.set(fontB, offB);
  const attachments = [
    { filename: "alpha.ttf", mimeType: "font/ttf", offset: offA, size: fontA.length },
    { filename: "beta.bin", mimeType: "application/x-truetype-font", offset: offB, size: fontB.length },
    { filename: "cover.jpg", mimeType: "image/jpeg", offset: 5, size: 10 },
    { filename: "read-at-open.ttf", mimeType: "font/ttf", offset: -1, size: 10 },
  ];

  const make = () => {
    const { read, calls } = reader(file);
    return { catalog: new FontCatalog(attachments, read), calls };
  };

  it("keeps only fonts that can be fetched", () => {
    expect(make().catalog.count).toBe(2);
  });

  it("downloads only the font a style asks for, whole, and never the other", async () => {
    const { catalog, calls } = make();
    const got = await catalog.fontsFor(["Beta Serif"]);
    expect(got).toHaveLength(1);
    expect(Array.from(got[0])).toEqual(Array.from(fontB));
    const whole = calls.filter(([, l]) => l >= fontA.length);
    // exactly one full-size read, and it is B's body
    expect(whole).toEqual([[offB, fontB.length]]);
    expect(calls.every(([o]) => o >= offA)).toBe(true);
  });

  it("matches the name in any case and does not fetch a font twice", async () => {
    const { catalog } = make();
    expect(await catalog.fontsFor(["ALPHA sans"])).toHaveLength(1);
    expect(await catalog.fontsFor(["alpha sans"])).toHaveLength(0);
  });

  it("supplies nothing for a name no attachment carries", async () => {
    const { catalog, calls } = make();
    expect(await catalog.fontsFor(["Arial"])).toEqual([]);
    expect(calls.some(([, l]) => l >= fontA.length)).toBe(false);
    expect(await catalog.has("Arial")).toBe(false);
    expect(await catalog.has("beta serif")).toBe(true);
  });

  it("names the fonts with two small reads each, not with their bodies", async () => {
    const { catalog, calls } = make();
    await catalog.index();
    expect(calls).toHaveLength(4);
    expect(calls.every(([, l]) => l <= 1024 + 8)).toBe(true);
  });
});
