#!/usr/bin/env node
// Black-box: ASS subtitles and their font attachments, in a real Chrome with
// the real JASSUB (libass) and a built movi-player package. No mocks: the media
// is made by make-fixtures.sh and served with Range support, and every claim
// is read off the server's request log or off the pixels of a screenshot.
//
//   node scripts/blackbox-fonts/run.mjs --dist <package/dist> --media <fixtures> \
//        --jassub <bundle dir> [--out <dir>]
//
// fonts.mkv carries 16 font attachments (11 MB) and an ASS track styled with
// "DejaVu Sans Mono". Three things have to hold:
//   a. opening it does not read the attachment bodies;
//   b. selecting the track reads the Mono body, and of the others only the
//      directory and name table each (that is how the family is found);
//   c. the cue is drawn in the attached Mono font: the ink of "iiiiiiiiii" is
//      about twice as wide as when the same script is drawn in the fallback
//      (DejaVu Sans), which is what plain.mkv, with no attachments, shows.
//
// The HTTP log can only say what was REQUESTED, and the player's first range is
// 4 MB (FIRST_RANGE_CHUNK_SIZE in HttpSource). That is why the file is padded:
// with 11 MB of bodies, 4 MB is a minority of them, and the two fonts that
// matter sit past the 4 MB mark where only a deliberate read can touch them.
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const outDir = resolve(arg("out", ".blackbox-results/fonts"));

const W = 640;
const H = 360;
// The fallback family is only a key; a lower-case name is what JASSUB's own
// default ("liberation sans") looks like, so it is looked up the same way.
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

const browser = await chromium.launch({
  executablePath: process.env.MOVI_CHROME_EXECUTABLE || undefined,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});
const consoleLog = [];

// Where each attachment's body sits in fonts.mkv, found by its bytes. The
// decoys are copies of one file, attached one after the other, so each is
// searched for after the end of the one before.
const mkvBytes = await readFile(resolve(media, "fonts.mkv"));
const find = async (file, bytesOf, from = 0) => {
  const body = await readFile(resolve(media, bytesOf));
  const at = mkvBytes.indexOf(body, from);
  if (at < 0) throw new Error(`${file} is not in fonts.mkv`);
  return { file, offset: at, size: body.length };
};
const all = [];
let from = 0;
for (let i = 1; i <= 14; i++) {
  const b = await find(`Pad${i}.ttf`, "Pad1.ttf", from);
  all.push(b);
  from = b.offset + b.size;
}
const sans = await find("DejaVuSans.ttf", "DejaVuSans.ttf");
const mono = await find("DejaVuSansMono.ttf", "DejaVuSansMono.ttf");
all.push(sans, mono);
const total = all.reduce((n, b) => n + b.size, 0);
console.log("attachment bodies:", JSON.stringify(all.map((b) => [b.file, b.offset, b.size])));

// Bytes of one body that requests in log[from..to) asked for.
const requested = (a, b, body) => {
  let n = 0;
  for (const r of server.log.slice(a, b)) {
    if (r.path !== "/media/fonts.mkv") continue;
    const lo = Math.max(r.start, body.offset);
    const hi = Math.min(r.end + 1, body.offset + body.size);
    if (hi > lo) n += hi - lo;
  }
  return n;
};

// The ink of the cue: the white pixels in the lower half of a screenshot of the
// player. The picture is black, so nothing else can be bright.
const ink = async (page) => {
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, bmp.width, bmp.height);
    let minX = width;
    let maxX = -1;
    let count = 0;
    for (let y = Math.floor(height * 0.5); y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] > 180) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    return { width: maxX >= minX ? maxX - minX + 1 : 0, count };
  }, png.toString("base64"));
};

// Open `file`, select its ASS track, and report what was asked for and drawn.
async function play(file) {
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await context.newPage();
  page.on("console", (m) => consoleLog.push(`[${file}] [${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLog.push(`[${file}] [pageerror] ${e.message}`));
  await page.goto(`${server.url}/page.html`);
  await waitFor(
    () => page.evaluate(() => window.__hostReady === true),
    30_000,
    "the page to load the player and JASSUB",
  );
  const t0 = server.log.length;
  await page.evaluate(
    ({ file, fallback }) => {
      const el = document.createElement("movi-player");
      el.setAttribute("autoplay", "");
      el.setAttribute("muted", "");
      el.setAttribute("subtitlefallbackfont", fallback);
      el.style.cssText = "width:100%;height:100%;display:block";
      el.setAttribute("src", `/media/${file}`);
      document.getElementById("host").appendChild(el);
    },
    { file, fallback: FALLBACK },
  );
  await waitFor(
    () =>
      page.evaluate(() => {
        const el = document.querySelector("movi-player");
        return el.duration > 5 && (el.player?.getSubtitleTracks?.().length ?? 0) > 0;
      }),
    90_000,
    `${file} to open with its subtitle track`,
  );
  await sleep(2000);
  const opened = server.log.length;
  await page.evaluate(async () => {
    const p = document.querySelector("movi-player").player;
    await p.selectSubtitleTrack(p.getSubtitleTracks()[0].id);
  });
  await waitFor(async () => (await ink(page)).count > 50, 60_000, "the cue to be drawn");
  await sleep(1500);
  const seen = await ink(page);
  const done = server.log.length;
  await page.screenshot({ path: resolve(outDir, `${file}.png`) }).catch(() => {});
  await context.close();
  return { t0, opened, done, ink: seen };
}

try {
  const real = await play("fonts.mkv");
  console.log("fonts.mkv ink:", JSON.stringify(real.ink));

  const touchedOnOpen = all.reduce((n, b) => n + requested(real.t0, real.opened, b), 0);
  const monoOnOpen = requested(real.t0, real.opened, mono);
  const sansOnOpen = requested(real.t0, real.opened, sans);
  note(
    "a. opening the file asks for a minority of the attachment bodies",
    touchedOnOpen < total * 0.5 && monoOnOpen < mono.size * 0.1 && sansOnOpen < sans.size * 0.1,
    `asked for ${touchedOnOpen} of ${total} bytes of bodies (the player's first range is 4 MB); Mono ${monoOnOpen}/${mono.size}, Sans ${sansOnOpen}/${sans.size}`,
  );

  const monoLater = requested(real.opened, real.done, mono);
  note(
    "b1. selecting the ASS track downloads the Mono font the style names",
    monoLater + monoOnOpen >= mono.size,
    `Mono ${monoLater + monoOnOpen}/${mono.size} bytes`,
  );
  const others = all.filter((b) => b !== mono);
  const rows = others.map((b) => [b.file, requested(real.opened, real.done, b), b.size]);
  const worst = rows.reduce((w, r) => (r[1] / r[2] > w[1] / w[2] ? r : w), rows[0]);
  note(
    "b2. no other attachment is downloaded, only probed (under a quarter of any body)",
    rows.every(([, got, size]) => got < size * 0.25),
    `worst ${worst[0]} ${worst[1]}/${worst[2]}; Sans ${rows.find((r) => r[0] === "DejaVuSans.ttf")[1]}/${sans.size}`,
  );

  const control = await play("plain.mkv");
  console.log("plain.mkv ink:", JSON.stringify(control.ink));
  const ratio = real.ink.width / Math.max(1, control.ink.width);
  note(
    "c. the cue is drawn in the attached Mono font, not the fallback",
    // "i" advances 0.602 em in DejaVu Sans Mono and 0.278 em in DejaVu Sans:
    // a ratio near 2.2. 1.6 leaves room for hinting and for the first and
    // last glyph's side bearings, and is far from the 1.0 of the same font.
    ratio > 1.6,
    `ink ${real.ink.width}px with the attachment, ${control.ink.width}px without (ratio ${ratio.toFixed(2)})`,
  );
} catch (e) {
  note("harness", false, String(e?.stack ?? e).split("\n").slice(0, 3).join(" | "));
}

await writeFile(resolve(outDir, "results.json"), JSON.stringify({ results, requests: server.log.length }, null, 2));
await writeFile(
  resolve(outDir, "requests.json"),
  JSON.stringify(server.log.filter((r) => r.path === "/media/fonts.mkv"), null, 1),
);
await writeFile(resolve(outDir, "console.log"), consoleLog.join("\n"));
await browser.close();
await server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
