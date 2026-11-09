/**
 * Matroska font attachments against the REAL WASM build, on a real MKV made by
 * ffmpeg at test time: H.264 + AAC + one ASS track + eight font attachments
 * (DejaVu Sans, about 750 KB, six copies of it under other names, and DejaVu
 * Sans Mono, about 340 KB): over six megabytes of bodies, so that one buffer of
 * read-ahead is a small part of them.
 *
 * What it pins is the patched matroskadec (docker/patches): opening the file
 * must not read the attachment bodies, the demuxer must say where each body
 * is, and a font must be fetched only when a style asks for it.
 *
 * Needs ffmpeg and two fonts. CI has both (apt: ffmpeg, fonts-dejavu-core);
 * elsewhere the test skips, except that MOVI_REQUIRE_WASM=1 turns a missing
 * ffmpeg/font into a failure like it does a missing WASM.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasWasm } from "../helpers/wasm-available";
import { Demuxer } from "../../src/demux/Demuxer";
import { FileSource } from "../../src/source/FileSource";
import { FontCatalog, styleFontNames } from "../../src/decode/SubtitleFonts";

vi.mock("../../dist/wasm/movi.js", async (importOriginal) => {
  const { hasWasm } = await import("../helpers/wasm-available");
  return hasWasm ? importOriginal() : { default: vi.fn(async () => ({})) };
});

const FONT_SANS =
  process.env.MOVI_TEST_FONT_SANS ?? "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const FONT_MONO =
  process.env.MOVI_TEST_FONT_MONO ?? "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;
const fontsAvailable = existsSync(FONT_SANS) && existsSync(FONT_MONO);
const runnable = hasWasm && ffmpegAvailable && fontsAvailable;

if (hasWasm && !runnable && process.env.MOVI_REQUIRE_WASM === "1") {
  throw new Error(
    `MOVI_REQUIRE_WASM=1 but the attachment test cannot run: ffmpeg=${ffmpegAvailable}, fonts=${fontsAvailable}`,
  );
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 160
PlayResY: 90

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans Mono,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,5,5,5,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:02.50,Default,,0,0,0,,hello
`;

// A FileSource that remembers what the demuxer (and the catalog) asked it for.
class CountingSource extends FileSource {
  reads: [number, number][] = [];
  async read(offset: number, length: number): Promise<ArrayBuffer> {
    this.reads.push([offset, length]);
    return super.read(offset, length);
  }
}

const overlap = (reads: [number, number][], from: number, size: number) => {
  let bytes = 0;
  for (const [o, l] of reads) {
    const lo = Math.max(o, from);
    const hi = Math.min(o + l, from + size);
    if (hi > lo) bytes += hi - lo;
  }
  return bytes;
};

describe.skipIf(!runnable)("Matroska attachments against real WASM", () => {
  let dir = "";
  let mkv: Buffer;
  let source: CountingSource;
  let demuxer: Demuxer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "movi-att-"));
    writeFileSync(join(dir, "sub.ass"), ASS);
    const copies = [1, 2, 3, 4, 5, 6].map((n) => {
      const path = join(dir, `DejaVuSansCopy${n}.ttf`);
      writeFileSync(path, readFileSync(FONT_SANS));
      return path;
    });
    const fonts = [FONT_SANS, ...copies, FONT_MONO];
    const r = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-i", join(dir, "sub.ass"),
        "-map", "0:v", "-map", "1:a", "-map", "2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "ass",
        ...fonts.flatMap((f, i) => [
          "-attach", f, `-metadata:s:t:${i}`, "mimetype=application/x-truetype-font",
        ]),
        join(dir, "fonts.mkv"),
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
    mkv = readFileSync(join(dir, "fonts.mkv"));
    source = new CountingSource(new File([mkv], "fonts.mkv"));
    demuxer = new Demuxer(source, undefined, true);
    await demuxer.open();
  }, 120_000);

  afterAll(() => {
    try {
      demuxer?.close();
    } catch {
      /* ignore */
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists the fonts with their MIME type and name", () => {
    const att = demuxer.getAttachments();
    expect(att.map((a) => a.filename).sort()).toEqual([
      "DejaVuSans.ttf",
      "DejaVuSansCopy1.ttf",
      "DejaVuSansCopy2.ttf",
      "DejaVuSansCopy3.ttf",
      "DejaVuSansCopy4.ttf",
      "DejaVuSansCopy5.ttf",
      "DejaVuSansCopy6.ttf",
      "DejaVuSansMono.ttf",
    ]);
    for (const a of att) expect(a.mimeType).toBe("application/x-truetype-font");
  });

  it("does not read the attachment bodies when it opens the file", () => {
    const att = demuxer.getAttachments();
    const fontBytes = att.reduce((n, a) => n + a.size, 0);
    expect(fontBytes).toBeGreaterThan(5_000_000);
    const touched = att.reduce((n, a) => n + overlap(source.reads, a.offset, a.size), 0);
    // The first buffer (512 KB) runs into the first body before anything can
    // be skipped; every other body was read in full before the patch.
    expect(touched).toBeLessThan(700_000);
  });

  it("reports offsets and sizes that read back the exact font files", () => {
    for (const a of demuxer.getAttachments()) {
      const original = readFileSync(a.filename === "DejaVuSansMono.ttf" ? FONT_MONO : FONT_SANS);
      expect(a.size).toBe(original.length);
      expect(sha256(mkv.subarray(a.offset, a.offset + a.size))).toBe(sha256(original));
    }
  });

  it("downloads only the font a style uses", async () => {
    const att = demuxer.getAttachments();
    const sub = demuxer.getSubtitleTracks()[0];
    const header = demuxer.getExtradata(sub.id);
    expect(header).not.toBeNull();
    const wanted = styleFontNames(header!);
    expect(wanted).toEqual(["dejavu sans mono"]);

    const catalog = new FontCatalog(att, async (o, l) => new Uint8Array(await source.read(o, l)));
    const before = source.reads.length;
    const got = await catalog.fontsFor(wanted);

    expect(got).toHaveLength(1);
    expect(sha256(got[0])).toBe(sha256(readFileSync(FONT_MONO)));
    const mine = source.reads.slice(before);
    const sans = att.find((a) => a.filename === "DejaVuSans.ttf")!;
    const mono = att.find((a) => a.filename === "DejaVuSansMono.ttf")!;
    // Naming the unused font costs its directory and name table, not its body.
    expect(overlap(mine, sans.offset, sans.size)).toBeLessThan(sans.size * 0.1);
    expect(overlap(mine, mono.offset, mono.size)).toBeGreaterThanOrEqual(mono.size);
  });
});
