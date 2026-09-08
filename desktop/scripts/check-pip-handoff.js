/** Verify the PiP settings handoff: /handoff.js is served and imports cleanly
 *  in the PiP page, the ?s= blob arrives parsed, applySettings lands on a live
 *  <movi-player>, and the return trip carries a settings object back. */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { createLocalServer } = require("../src/local-server");

app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport,SharedArrayBuffer");

const SENT = {
  audio: { id: 1, lang: "hin", index: 1 },
  subtitle: null,
  subtitlesOff: true,
  volume: 0.42,
  muted: false,
  rate: 0.75,
};

let reported = null;
ipcMain.on("pip:state", (_e, s) => {
  if (s && s.settings && reported === null) reported = s.settings;
});

app.whenReady().then(async () => {
  const server = createLocalServer({
    rendererDir: path.join(__dirname, "..", "renderer"),
    isLocalAllowed: () => false,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const pip = new BrowserWindow({
    width: 480, height: 270, alwaysOnTop: true, frame: false, show: false,
    webPreferences: { preload: path.join(__dirname, "..", "src", "preload.js"), contextIsolation: true },
  });

  pip.webContents.on("did-finish-load", async () => {
    const r = await pip.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 60 && !customElements.get('movi-player'); i++) await new Promise(r => setTimeout(r, 50));
      const mod = await import('/handoff.js');
      const p = document.getElementById('pip-player');
      // pip.js runs applySettings inside load(), which fires on script start.
      await new Promise(r => setTimeout(r, 400));
      return {
        moduleServed: typeof mod.captureSettings === 'function' && typeof mod.applySettings === 'function',
        volume: p.volume,
        muted: p.muted,
        rate: p.playbackRate,
        shape: Object.keys(mod.captureSettings(p) || {}).sort().join(','),
        // The muxed-track route the handoff reads. An ordinary MKV's own audio
        // streams are invisible to getAudioLangs — that list is the declared
        // <source kind="audio"> one — so without these the pick has nothing to
        // capture and nothing to re-apply. Names have to survive minification,
        // which is the point of checking them against the shipped bundle.
        muxedRoute: !!p.player && typeof p.player.getAudioTracks === 'function'
          && typeof p.player.selectAudioTrack === 'function'
          && typeof p.player.getSubtitleTracks === 'function'
          && typeof p.player.selectSubtitleTrack === 'function'
          && !!p.player.trackManager
          && typeof p.player.trackManager.getActiveAudioTrack === 'function'
          && typeof p.player.trackManager.getActiveSubtitleTrack === 'function',
        pickRoute: typeof p.pickAudioTrack === 'function' && typeof p.pickSubtitleTrack === 'function',
      };
    })()`, true);

    // The back-channel ticks once a second.
    await new Promise((r) => setTimeout(r, 1400));

    const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 0.001;
    const checks = [
      ["/handoff.js served and imported", r.moduleServed],
      ["volume carried across", near(r.volume, SENT.volume)],
      ["muted carried across", r.muted === SENT.muted],
      ["playback rate carried across", near(r.rate, SENT.rate)],
      ["captureSettings reports every field", r.shape === "audio,muted,rate,subtitle,subtitlesOff,volume"],
      ["muxed track route reachable in the shipped bundle", r.muxedRoute],
      ["element pick* path survives minification", r.pickRoute],
      ["settings ride the return trip", !!reported && near(reported.volume, SENT.volume) && near(reported.rate, SENT.rate)],
    ];
    let fail = 0;
    for (const [n, ok] of checks) {
      console.log(ok ? "✓" : "✗", n, ok ? "" : `→ ${JSON.stringify({ r, reported })}`);
      if (!ok) fail++;
    }
    console.log(`\n${checks.length - fail} passed, ${fail} failed`);
    server.close();
    pip.destroy();
    app.exit(fail ? 1 : 0);
  });

  const u = new URL(`http://127.0.0.1:${port}/pip.html`);
  u.searchParams.set("src", "/_proxy/x?url=http://example.com/v.mp4");
  u.searchParams.set("t", "0");
  u.searchParams.set("s", JSON.stringify(SENT));
  pip.loadURL(u.toString());
  setTimeout(() => app.exit(4), 20000);
});
