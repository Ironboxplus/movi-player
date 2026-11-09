import { describe, expect, it, vi } from "vitest";
import { JassubRenderer } from "../../src/render/JassubRenderer";
import type { Packet, SubtitleTrack } from "../../src/types";

// JASSUB is a host asset (a worker plus WebAssembly), so what stands in for it
// here is the host's side of the contract: a class with the surface the
// renderer calls. Everything movi decides — what reaches libass, in what order
// and with which fonts — is the real code.

class FakeJassub {
  static instances: FakeJassub[] = [];
  ready = Promise.resolve();
  timeOffset = 0;
  calls: string[] = [];
  added: Uint8Array[][] = [];
  chunks: [string, number, number][] = [];
  renders: { width: number; height: number; mediaTime: number }[] = [];
  renderer = {
    setTrack: async (c: string) =>
      void this.calls.push(`setTrack:${c.slice(0, 12)}`),
    freeTrack: async () => void this.calls.push("freeTrack"),
    addFonts: async (f: (Uint8Array | string)[]) => {
      this.added.push(f as Uint8Array[]);
      this.calls.push("addFonts");
      return true;
    },
    processChunk: async (d: string, t: number, du: number) => {
      this.chunks.push([d, t, du]);
    },
  };
  constructor(public options: Record<string, unknown>) {
    FakeJassub.instances.push(this);
  }
  async manualRender(d: { width: number; height: number; mediaTime: number }) {
    this.renders.push(d);
  }
  async destroy() {
    this.calls.push("destroy");
  }
}

const track = (codec: string): SubtitleTrack =>
  ({ id: 3, type: "subtitle", codec, subtitleType: "text" }) as SubtitleTrack;

const packet = (text: string, timestamp = 1.5, duration = 2): Packet =>
  ({
    streamIndex: 3,
    keyframe: true,
    timestamp,
    dts: timestamp,
    duration,
    data: new TextEncoder().encode(text),
    isIdr: false,
    isRasl: false,
  }) as Packet;

const HEADER = new TextEncoder().encode("[Script Info]\nScriptType: v4.00+\n");

function make(fallback?: { family: string; url: string }) {
  FakeJassub.instances.length = 0;
  const container = {
    clientWidth: 800,
    clientHeight: 450,
    appendChild: vi.fn(),
  };
  const canvas = {
    style: {},
    setAttribute: vi.fn(),
    remove: vi.fn(),
    parentElement: container,
  };
  const r = new JassubRenderer(
    {
      load: async () => ({ default: FakeJassub }),
      workerUrl: "w.js",
      wasmUrl: "a.wasm",
      modernWasmUrl: "b.wasm",
    },
    fallback,
    () => canvas as unknown as HTMLCanvasElement,
  );
  r.mount(container as unknown as HTMLElement);
  return { r, container, inst: () => FakeJassub.instances[0] };
}

describe("JassubRenderer", () => {
  it("takes ASS and SSA tracks and leaves the rest to the built-in decoder", () => {
    const { r } = make();
    expect(r.accepts(track("ass"))).toBe(true);
    expect(r.accepts(track("ssa"))).toBe(true);
    expect(r.accepts(track("SSA"))).toBe(true);
    expect(r.accepts(track("subrip"))).toBe(false);
    expect(r.accepts(track("webvtt"))).toBe(false);
    expect(r.accepts(track("hdmv_pgs_subtitle"))).toBe(false);
  });

  it("loads nothing until an ASS track is shown", async () => {
    const { r } = make();
    expect(FakeJassub.instances).toHaveLength(0);
    await r.configure(track("ass"), HEADER, []);
    expect(FakeJassub.instances).toHaveLength(1);
  });

  it("opens JASSUB with the script header, the style fonts and the host's assets", async () => {
    const { r, inst } = make();
    const font = new Uint8Array([1, 2, 3]);
    await r.configure(track("ass"), HEADER, [font]);
    const o = inst().options;
    expect(o.subContent).toContain("[Script Info]");
    expect(o.fonts).toEqual([font]);
    expect(o.workerUrl).toBe("w.js");
    expect(o.wasmUrl).toBe("a.wasm");
    expect(o.modernWasmUrl).toBe("b.wasm");
    expect(o.availableFonts).toBeUndefined();
  });

  it("registers the fallback font as an on-demand default, not as a loaded font", async () => {
    const { r, inst } = make({
      family: "Source Han Sans CN",
      url: "/f/han.woff2",
    });
    await r.configure(track("ass"), HEADER, []);
    const o = inst().options;
    expect(o.availableFonts).toEqual({ "Source Han Sans CN": "/f/han.woff2" });
    expect(o.defaultFont).toBe("Source Han Sans CN");
    expect(o.fonts).toEqual([]);
  });

  it("hands packets to libass with millisecond timing, in order", async () => {
    const { r, inst } = make();
    await r.configure(track("ass"), HEADER, []);
    r.pushPacket(packet("0,0,Default,,0,0,0,,one", 1.5, 2));
    r.pushPacket(packet("1,0,Default,,0,0,0,,two", 4, 0.25));
    await r.destroy().catch(() => {});
    expect(inst().chunks).toEqual([
      ["0,0,Default,,0,0,0,,one", 1500, 2000],
      ["1,0,Default,,0,0,0,,two", 4000, 250],
    ]);
  });

  it("fetches a font a later \\fn names, once", async () => {
    const { r, inst } = make();
    const impact = new Uint8Array([9, 9]);
    const fontsFor = vi.fn(async (names: readonly string[]) =>
      names.includes("impact") ? [impact] : [],
    );
    r.setFontSource({ fontsFor });
    await r.configure(track("ass"), HEADER, []);
    r.pushPacket(packet("0,0,Default,,0,0,0,,{\\fnImpact}loud"));
    r.pushPacket(packet("1,0,Default,,0,0,0,,{\\fnImpact}again"));
    r.pushPacket(packet("2,0,Default,,0,0,0,,plain"));
    await r.destroy().catch(() => {});
    expect(fontsFor).toHaveBeenCalledTimes(1);
    expect(inst().added).toEqual([[impact]]);
  });

  it("re-points an existing instance at the next track instead of rebuilding", async () => {
    const { r, inst } = make();
    await r.configure(track("ass"), HEADER, []);
    const next = new Uint8Array([5]);
    await r.configure(
      track("ass"),
      new TextEncoder().encode("[Script Info]\nTitle: B\n"),
      [next],
    );
    expect(FakeJassub.instances).toHaveLength(1);
    expect(inst().calls).toEqual(["addFonts", "setTrack:[Script Info]"]);
    expect(inst().added).toEqual([[next]]);
  });

  it("shows a whole external script", async () => {
    const { r, inst } = make();
    await r.loadExternal("[Script Info]\nTitle: file\n[Events]\n");
    expect(inst().options.subContent).toContain("Title: file");
    r.render(3, 0, 0);
    await r.destroy().catch(() => {});
    expect(inst().renders).toHaveLength(1);
  });

  it("draws nothing and ignores packets once released", async () => {
    const { r, inst } = make();
    await r.configure(track("ass"), HEADER, []);
    r.release();
    r.pushPacket(packet("0,0,Default,,0,0,0,,late"));
    r.render(1, 854, 480);
    await r.destroy().catch(() => {});
    expect(inst().calls).toContain("freeTrack");
    expect(inst().chunks).toEqual([]);
    expect(inst().renders).toEqual([]);
  });

  it("renders at the video's size, or the overlay's when it is not known", async () => {
    const { r, inst } = make();
    await r.configure(track("ass"), HEADER, []);
    r.render(2.5, 1920, 1080);
    r.render(3, 0, 0);
    await r.destroy().catch(() => {});
    expect(inst().renders).toEqual([
      {
        expectedDisplayTime: expect.any(Number),
        width: 1920,
        height: 1080,
        mediaTime: 2.5,
      },
      {
        expectedDisplayTime: expect.any(Number),
        width: 800,
        height: 450,
        mediaTime: 3,
      },
    ]);
  });

  it("passes the subtitle delay on, also to an instance made later", async () => {
    const { r, inst } = make();
    r.setDelay(0.7);
    await r.configure(track("ass"), HEADER, []);
    expect(inst().timeOffset).toBe(0.7);
    r.setDelay(-0.2);
    expect(inst().timeOffset).toBe(-0.2);
  });

  it("keeps what libass already has on a seek", async () => {
    const { r, inst } = make();
    await r.configure(track("ass"), HEADER, []);
    r.clear();
    expect(inst().calls).not.toContain("freeTrack");
  });
});
