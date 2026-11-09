/**
 * ASS/SSA rendering with libass, through JASSUB, as a SubtitleRenderer.
 *
 * movi owns everything about how a script reaches libass: the header, the
 * packets of an embedded track, a whole external .ass file, the fonts the
 * script names and the one it falls back to. What it does not own is JASSUB
 * itself. The library, its worker and its two WebAssembly builds are assets
 * that have to go through the host's bundler (`new URL(..., import.meta.url)`
 * does not survive being bundled twice), so the host hands them in once with
 * `MoviElement.setJassubHost`. Nothing is loaded until an ASS track is shown.
 *
 * Fonts follow mpv/libass: a script's `Fontname` is looked up among the fonts
 * registered with libass by family name; the container's attachments are those
 * fonts, and only the ones a script uses are downloaded (see SubtitleFonts.ts).
 * A font the script switches to later with `\fn` is fetched when the event that
 * names it arrives.
 */
import type { Packet, SubtitleRenderer, SubtitleTrack } from "../types";
import { overrideFontNames } from "../decode/SubtitleFonts";
import { Logger } from "../utils/Logger";

const TAG = "JassubRenderer";

/** The pieces of JASSUB this uses. Typed here, not imported: it is a host asset. */
interface JassubInstance {
  ready: Promise<void>;
  renderer: {
    setTrack(content: string): Promise<void> | void;
    freeTrack(): Promise<void> | void;
    addFonts(fonts: (Uint8Array | string)[]): Promise<boolean>;
    processChunk(
      data: string,
      timecode: number,
      duration: number,
    ): Promise<void> | void;
  };
  timeOffset: number;
  manualRender(data: {
    expectedDisplayTime: number;
    width: number;
    height: number;
    mediaTime: number;
  }): Promise<void>;
  destroy(): Promise<void>;
}
type JassubCtor = new (options: Record<string, unknown>) => JassubInstance;

/** What the host provides: how to get JASSUB and where its assets are served. */
export interface JassubHost {
  /** Resolves to the JASSUB class, or to its module (`default`). */
  load(): Promise<unknown>;
  workerUrl?: string;
  wasmUrl?: string;
  modernWasmUrl?: string;
}

/** The font libass uses for a name nothing else answers to. */
export interface FallbackFont {
  family: string;
  url: string;
}

/** Fetches the fonts of the open file by family name; see FontCatalog. */
export interface FontSource {
  fontsFor(names: readonly string[]): Promise<Uint8Array[]>;
}

const isAss = (track: SubtitleTrack) =>
  /^(ass|ssa)$/i.test(track.codec) ||
  /\b(ass|ssa)\b/i.test(track.codecString ?? "");

export class JassubRenderer implements SubtitleRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private container: HTMLElement | null = null;
  private instance: JassubInstance | null = null;
  private creating: Promise<JassubInstance> | null = null;
  private active = false;
  private delay = 0;
  private fontSource: FontSource | null = null;
  private asked = new Set<string>();
  // Packets and fonts are applied in the order they arrive, whatever the
  // worker's speed: a script's events are meaningless before its header.
  private chain: Promise<unknown> = Promise.resolve();
  private destroyed = false;
  private readonly decoder = new TextDecoder();

  constructor(
    private host: JassubHost,
    private fallback?: FallbackFont,
    private createCanvas: () => HTMLCanvasElement = () =>
      document.createElement("canvas"),
  ) {}

  /** Only ASS/SSA is libass's; the rest stay with the built-in decoder. */
  accepts(track: SubtitleTrack): boolean {
    return isAss(track);
  }

  setFontSource(source: FontSource | null): void {
    this.fontSource = source;
    this.asked.clear();
  }

  mount(container: HTMLElement): void {
    this.container = container;
    if (this.canvas && this.canvas.parentElement !== container) {
      container.appendChild(this.canvas);
    }
  }

  async configure(
    _track: SubtitleTrack,
    extradata?: Uint8Array,
    fonts?: Uint8Array[],
  ): Promise<void> {
    const header = extradata ? this.decoder.decode(extradata) : "";
    this.asked.clear();
    await this.enqueue(async () => {
      await this.show(header, fonts);
    });
  }

  async loadExternal(content: string, fonts?: Uint8Array[]): Promise<void> {
    this.asked.clear();
    await this.enqueue(async () => {
      await this.show(content, fonts);
    });
  }

  pushPacket(packet: Packet): void {
    if (!this.active) return;
    const text = this.decoder.decode(packet.data);
    void this.enqueue(async () => {
      const inst = this.instance;
      if (!inst || !this.active) return;
      await this.supplyFonts(inst, overrideFontNames(text));
      void inst.renderer.processChunk(
        text,
        Math.round(packet.timestamp * 1000),
        Math.round(Math.max(0, packet.duration) * 1000),
      );
    });
  }

  render(mediaTime: number, videoWidth: number, videoHeight: number): void {
    const inst = this.instance;
    if (!inst || !this.active || !this.container) return;
    const w = videoWidth > 0 ? videoWidth : this.container.clientWidth;
    const h = videoHeight > 0 ? videoHeight : this.container.clientHeight;
    if (!(w > 0 && h > 0)) return;
    void inst
      .manualRender({
        expectedDisplayTime: performance.now(),
        width: w,
        height: h,
        mediaTime,
      })
      .catch(() => {
        /* a frame that cannot be drawn is not worth stopping the loop for */
      });
  }

  setDelay(seconds: number): void {
    this.delay = seconds;
    if (this.instance) this.instance.timeOffset = seconds;
  }

  /**
   * libass keeps an event it has already been given (a repeated ReadOrder is
   * ignored), so a seek needs nothing dropped: the events that straddle the
   * new position are exactly the ones already in the track.
   */
  clear(): void {}

  /** What was showing is no longer this renderer's: draw nothing. */
  release(): void {
    this.active = false;
    void this.enqueue(async () => {
      if (this.instance && !this.active)
        await this.instance.renderer.freeTrack();
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.active = false;
    try {
      await this.chain;
    } catch {
      /* the queue's own failures were logged where they happened */
    }
    const inst =
      this.instance ?? (await this.creating?.catch(() => null)) ?? null;
    this.instance = null;
    this.creating = null;
    try {
      await inst?.destroy();
    } catch {
      /* torn down with its worker */
    }
    this.canvas?.remove();
    this.canvas = null;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.chain.then(job).catch((e) => {
      Logger.error(TAG, "ASS renderer step failed", e);
    });
    this.chain = run;
    return run;
  }

  /** Make `script` the track libass shows, with `fonts` registered first. */
  private async show(script: string, fonts?: Uint8Array[]): Promise<void> {
    if (this.destroyed) return;
    let inst = this.instance;
    if (!inst) {
      // A new instance takes the script and the fonts in its constructor.
      inst = await this.create(script, fonts ?? []);
      if (this.destroyed) return;
      this.instance = inst;
    } else {
      if (fonts?.length) await inst.renderer.addFonts(fonts);
      await inst.renderer.setTrack(script);
    }
    inst.timeOffset = this.delay;
    this.active = true;
  }

  private create(script: string, fonts: Uint8Array[]): Promise<JassubInstance> {
    if (!this.creating) {
      this.creating = (async () => {
        const mod = (await this.host.load()) as
          { default?: JassubCtor } | JassubCtor;
        const Ctor = (
          typeof mod === "function" ? mod : mod.default
        ) as JassubCtor;
        if (!Ctor)
          throw new Error("JASSUB host did not provide the JASSUB class");
        const canvas = this.createCanvas();
        canvas.setAttribute("part", "ass-subtitle");
        canvas.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
        this.canvas = canvas;
        this.container?.appendChild(canvas);
        const options: Record<string, unknown> = {
          canvas,
          subContent: script,
          fonts,
          timeOffset: this.delay,
          ...(this.host.workerUrl && { workerUrl: this.host.workerUrl }),
          ...(this.host.wasmUrl && { wasmUrl: this.host.wasmUrl }),
          ...(this.host.modernWasmUrl && {
            modernWasmUrl: this.host.modernWasmUrl,
          }),
          // Not in `fonts`: JASSUB fetches it only when a name finds nothing else.
          ...(this.fallback && {
            availableFonts: { [this.fallback.family]: this.fallback.url },
            defaultFont: this.fallback.family,
          }),
        };
        const inst = new Ctor(options);
        await inst.ready;
        return inst;
      })();
      this.creating.catch(() => {
        this.creating = null;
      });
    }
    return this.creating;
  }

  /** Register, with libass, the attachments that answer to any of `names`. */
  private async supplyFonts(
    inst: JassubInstance,
    names: string[],
  ): Promise<void> {
    if (!this.fontSource) return;
    const fresh = names.filter((n) => !this.asked.has(n));
    if (!fresh.length) return;
    for (const n of fresh) this.asked.add(n);
    try {
      const fonts = await this.fontSource.fontsFor(fresh);
      if (fonts.length) await inst.renderer.addFonts(fonts);
    } catch (e) {
      Logger.warn(TAG, "Could not load an embedded font", e);
    }
  }
}
