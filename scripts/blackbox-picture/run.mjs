#!/usr/bin/env node
// Black-box: the picture stays on screen while subtitles are shown, in a real
// Chrome with the real JASSUB and a built movi-player package, the element set
// up as OpenList sets it up. No mocks: the media is made by make-fixtures.sh and
// served with Range support; every claim is read off the pixels of a screenshot.
//
//   node scripts/blackbox-picture/run.mjs --dist <package/dist> --media <fixtures> \
//        --jassub <bundle dir> [--out <dir>]
//
// The picture is blue. For each way a subtitle reaches the player (in-band ASS
// and SRT, a <track> file of each kind declared after the player was made, as
// OpenList's file page now does), the subtitle is picked while the video plays,
// and two things have to hold:
//   - the cue is drawn (white ink in the lower half);
//   - the picture is still there (a patch away from the cue and the controls is
//     blue, not black), for three seconds after the cue appeared.
// Each case runs twice: with Chrome's defaults, and with WebGPU on (JASSUB
// draws with WebGPU when it has an adapter, as a desktop Chrome does).
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../blackbox-sources/server.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const dist = resolve(arg("dist", "dist"));
const media = resolve(arg("media", "fixtures"));
const jassub = resolve(arg("jassub", "jassub-bundle"));
const outDir = resolve(arg("out", ".blackbox-results/picture"));

const W = 640;
const H = 360;
const FALLBACK = "dejavu sans|/media/DejaVuSans.ttf";

const results = [];
const note = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};

const PAGE = `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#000">
<div id="host" style="width:${W}px;height:${H}px;position:relative"></div>
<script type="module">
  await import("/dist/element.js");
  const { default: JASSUB } = await import("/jassub/jassub.bundle.js");
  customElements.get("movi-player").setJassubHost({
    load: async () => JASSUB,
    workerUrl: "/jassub/worker.bundle.js",
    wasmUrl: "/jassub/wasm/jassub-worker.wasm",
    modernWasmUrl: "/jassub/wasm/jassub-worker-modern.wasm",
  });
  window.__hostReady = true;
</script>
</body>`;

const server = await startServer({
  mounts: { "/media/": media, "/dist/": dist, "/jassub/": jassub },
  pages: { "/page.html": PAGE },
});
await mkdir(outDir, { recursive: true });
const consoleLog = [];

// Mean colour of the picture away from the cue (bottom) and the title (top),
// and the white ink of the cue in the lower half.
const look = async (page) => {
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, bmp.width, bmp.height);
    let r = 0, gr = 0, b = 0, n = 0;
    for (let y = Math.floor(height * 0.2); y < Math.floor(height * 0.45); y++) {
      for (let x = Math.floor(width * 0.3); x < Math.floor(width * 0.7); x++) {
        const i = (y * width + x) * 4;
        r += data[i]; gr += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    let ink = 0;
    for (let y = Math.floor(height * 0.5); y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] > 180) ink++;
      }
    }
    return { r: Math.round(r / n), g: Math.round(gr / n), b: Math.round(b / n), ink };
  }, png.toString("base64"));
};
const blue = (p) => p.b > 100 && p.b > p.r + 50;

const state = (page) =>
  page.evaluate(() => {
    const el = document.querySelector("movi-player");
    const p = el.player;
    const root = el.shadowRoot;
    const css = (e) => {
      const s = getComputedStyle(e);
      return { z: s.zIndex, bg: s.backgroundColor, op: s.opacity, vis: s.visibility, disp: s.display };
    };
    return {
      time: p?.getCurrentTime?.(),
      state: p?.getState?.(),
      inband: p?.getSubtitleTracks?.().map((t) => [t.id, t.codec, t.label]),
      activeInband: p?.trackManager?.getActiveSubtitleTrack?.()?.id ?? null,
      files: p?.getSubtitleLangs?.(),
      canvases: [...root.querySelectorAll("canvas")].map((c) => [c.getAttribute("part") || c.className, c.width, c.height, c.clientWidth, c.clientHeight, css(c)]),
      layers: [...root.querySelectorAll(".movi-subtitle-renderer-layer")].map((e) => [e.childElementCount, css(e)]),
    };
  });

const CASES = [
  { name: "no subtitle (control)" },
  { name: "in-band ASS", inband: /ass|ssa/i },
  { name: "in-band SRT", inband: /subrip|srt|text/i },
  {
    name: "late <track> ASS file",
    late: [{ src: "/media/sub.ass", lang: "en", label: "sub.ass", format: "ass" }],
    file: "en",
  },
  {
    name: "late <track> SRT file",
    late: [{ src: "/media/sub.srt", lang: "zh", label: "sub.srt", format: "srt" }],
    file: "zh",
  },
];

async function run(browser, mode, c) {
  const label = `[${mode}] ${c.name}`;
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await context.newPage();
  page.on("console", (m) => consoleLog.push(`${label} [${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLog.push(`${label} [pageerror] ${e.message}`));
  page.on("worker", (w) => w.on("console", (m) => consoleLog.push(`${label} [worker ${m.type()}] ${m.text()}`)));
  try {
    await page.goto(`${server.url}/page.html`);
    await waitFor(() => page.evaluate(() => window.__hostReady === true), 30_000, "the page");
    const gpu = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter?.()));
    // As OpenList's movi_core.tsx writes it.
    await page.evaluate(({ fallback }) => {
      const wrapper = document.createElement("div");
      wrapper.style.cssText = "position:relative;width:100%";
      wrapper.innerHTML = `<movi-player src="/media/subs.mkv" controls theme="dark" hdr fastseek autoplay subtitlefallbackfont="${fallback}" style="width:100%;max-height:80vh"></movi-player>`;
      document.getElementById("host").appendChild(wrapper);
    }, { fallback: FALLBACK });
    await waitFor(
      () => page.evaluate(() => {
        const el = document.querySelector("movi-player");
        return el.duration > 5 && el.currentTime > 1;
      }),
      90_000,
      "the video to play",
    );
    if (c.late) {
      await page.evaluate((tracks) => {
        const el = document.querySelector("movi-player");
        const t = document.createElement("template");
        t.innerHTML = tracks
          .map((x) => `<track kind="subtitles" src="${x.src}" srclang="${x.lang}" label="${x.label}" data-format="${x.format}">`)
          .join("");
        el.append(t.content);
      }, c.late);
      await sleep(500);
    }
    await sleep(1000);
    const before = await look(page);
    if (c.inband) {
      const ok = await page.evaluate(async (src) => {
        const p = document.querySelector("movi-player").player;
        const t = p.getSubtitleTracks().find((x) => new RegExp(src, "i").test(`${x.codec} ${x.codecString ?? ""}`));
        if (!t) return false;
        return p.selectSubtitleTrack(t.id);
      }, c.inband.source);
      if (!ok) throw new Error("no such in-band track: " + JSON.stringify(await state(page)));
    } else if (c.file) {
      await page.evaluate((lang) => document.querySelector("movi-player").player.selectSubtitleLang(lang), c.file);
    }
    let drawn = !c.inband && !c.file;
    if (!drawn) {
      drawn = await waitFor(async () => (await look(page)).ink > 50, 20_000, "the cue").catch(() => false);
    }
    const after = [];
    for (let i = 0; i < 3; i++) {
      await sleep(1000);
      after.push(await look(page));
    }
    const s = await state(page);
    await page.screenshot({ path: resolve(outDir, `${mode}-${c.name.replace(/[^a-z0-9]+/gi, "_")}.png`) }).catch(() => {});
    const fmt = (p) => `rgb(${p.r},${p.g},${p.b}) ink ${p.ink}`;
    note(`${label}: picture before the subtitle`, blue(before), fmt(before));
    if (c.inband || c.file) note(`${label}: cue drawn`, !!drawn, after.map((p) => p.ink).join("/"));
    note(
      `${label}: picture with the subtitle on`,
      after.every(blue),
      `${after.map(fmt).join(" | ")}; webgpu adapter ${gpu}; state ${JSON.stringify(s)}`,
    );
  } catch (e) {
    note(`${label}: harness`, false, String(e?.stack ?? e).split("\n").slice(0, 3).join(" | "));
    await page.screenshot({ path: resolve(outDir, `${mode}-${c.name.replace(/[^a-z0-9]+/gi, "_")}-error.png`) }).catch(() => {});
  }
  await context.close();
}

const MODES = {
  default: [],
  webgpu: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader"],
};
for (const [mode, extra] of Object.entries(MODES)) {
  const browser = await chromium.launch({
    executablePath: process.env.MOVI_CHROME_EXECUTABLE || undefined,
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", ...extra],
  });
  for (const c of CASES) await run(browser, mode, c);
  await browser.close();
}

await writeFile(resolve(outDir, "results.json"), JSON.stringify({ results }, null, 2));
await writeFile(resolve(outDir, "console.log"), consoleLog.join("\n"));
await server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
