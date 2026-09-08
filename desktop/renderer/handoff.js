/**
 * What travels with a video between the main window and PiP.
 *
 * The two windows hold two separate players, not one player shown twice — the
 * handoff carries a source and a position, and everything else about how the
 * viewer had the film set up was left behind. Pick the second audio track, turn
 * captions on, slow it to 0.75x, then hit PiP: all three reverted to whatever
 * the fresh element decided on its own, and setting them again inside the PiP
 * window meant losing them a second time on the way back.
 *
 * Two track worlds, and a file is in one or the other:
 *   muxed     — streams inside the container, keyed by the container's own
 *               track id. An ordinary MKV with two audio streams is this.
 *   declared  — <source kind="audio"> children and DASH ladders, which are
 *               separate files keyed by language.
 * The element's getAudioLangs / getSubtitleLangs answer for the DECLARED list
 * only, which is why reading them alone came back empty on every normal file.
 * The muxed side is read off the MoviPlayer the element holds, the same object
 * the element's own track menus go through.
 *
 * Imported by both renderer.js and pip.js so the two ends cannot drift.
 */

const safe = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** Swallow the promise the subtitle selector hands back — a track the file
 *  turns out not to have is a miss, not an unhandled rejection. */
const settle = (v) => {
  if (v && typeof v.catch === "function") v.catch(() => {});
  return v;
};

const rowsOf = (fn) => {
  const v = safe(fn);
  return Array.isArray(v) ? v : [];
};

/** The MoviPlayer inside the element. */
const core = (el) => safe(() => el.player) || null;

/**
 * Two tags for the same language as far as a viewer is concerned. Files
 * disagree about how to spell one — "en", "eng", "en-US" — and the file on the
 * far side of the handoff is usually the same file, but a PiP window that has
 * moved on to the next episode may well spell it differently.
 */
const sameLang = (a, b) => {
  const x = String(a || "").trim().toLowerCase();
  const y = String(b || "").trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  // "und" is Matroska's way of saying nobody filled the field in. Matching on
  // it would pair two tracks that are only equally anonymous.
  if (x === "und" || y === "und") return false;
  const stem = (v) => v.split(/[-_]/)[0].slice(0, 2);
  return stem(x) === stem(y);
};

/**
 * One list of {id, lang, active} plus the way to switch to a row, whichever
 * world this file lives in. Selection goes through the element's own pick*
 * path when it is there, so the choice is remembered exactly as it would be if
 * the viewer had used the menu — the four UI surfaces all funnel through it.
 */
function audioSurface(el) {
  const c = core(el);
  const muxed = rowsOf(() => c && c.getAudioTracks());
  if (muxed.length) {
    const activeId = safe(() => c.trackManager.getActiveAudioTrack().id);
    return {
      rows: muxed.map((t, i) => {
        const id = typeof t.id === "number" ? t.id : i;
        return {
          id,
          lang: t.language || "",
          active: typeof activeId === "number" ? id === activeId : i === 0,
        };
      }),
      select: (row) =>
        safe(() => el.pickAudioTrack(row.id)) ?? safe(() => c.selectAudioTrack(row.id)),
    };
  }
  return {
    rows: rowsOf(() => el.getAudioLangs()).map((t) => ({
      id: null,
      lang: t.lang || "",
      active: !!t.active,
    })),
    select: (row) => safe(() => el.selectAudioLang(row.lang || "")),
  };
}

function subtitleSurface(el) {
  const c = core(el);
  const muxed = rowsOf(() => c && c.getSubtitleTracks());
  if (muxed.length) {
    const activeId = safe(() => c.trackManager.getActiveSubtitleTrack().id);
    return {
      rows: muxed.map((t, i) => {
        const id = typeof t.id === "number" ? t.id : i;
        return { id, lang: t.language || "", active: id === activeId };
      }),
      select: (row) =>
        settle(
          safe(() => el.pickSubtitleTrack(row.id)) ??
            safe(() => c.selectSubtitleTrack(row.id)),
        ),
      off: () =>
        settle(
          safe(() => el.pickSubtitleTrack(null)) ??
            safe(() => c.selectSubtitleTrack(null)),
        ),
    };
  }
  return {
    rows: rowsOf(() => el.getSubtitleLangs()).map((t) => ({
      id: null,
      lang: t.lang || "",
      active: !!t.active,
    })),
    select: (row) => settle(safe(() => el.selectSubtitleLang(row.lang || ""))),
    off: () => settle(safe(() => el.selectSubtitleLang(null))),
  };
}

/** id first, then language, then position. The id is exact when it is the same
 *  file — which it is, every time but a PiP window that changed reel. */
function findTrack(rows, want) {
  if (!rows.length || !want) return null;
  if (typeof want.id === "number") {
    const byId = rows.find((t) => t.id === want.id);
    if (byId) return byId;
  }
  if (want.lang) {
    const byLang = rows.find((t) => sameLang(t.lang, want.lang));
    if (byLang) return byLang;
  }
  if (typeof want.index === "number" && rows[want.index]) return rows[want.index];
  return null;
}

const keyOf = (rows, i) => ({ id: rows[i].id, lang: rows[i].lang || null, index: i });

/** Everything the window on the other side cannot work out for itself. */
export function captureSettings(el) {
  if (!el) return null;
  const audio = audioSurface(el);
  const subs = subtitleSurface(el);
  const audioAt = audio.rows.findIndex((t) => t.active);
  const subAt = subs.rows.findIndex((t) => t.active);
  return {
    audio: audioAt >= 0 ? keyOf(audio.rows, audioAt) : null,
    subtitle: subAt >= 0 ? keyOf(subs.rows, subAt) : null,
    // Off is an answer; not knowing is not. Without the distinction a file
    // whose default caption track is on would switch captions back on in the
    // other window every time, which is the opposite of what was asked for.
    subtitlesOff: subAt < 0 && subs.rows.length > 0,
    volume: typeof el.volume === "number" ? el.volume : null,
    muted: !!el.muted,
    rate: typeof el.playbackRate === "number" ? el.playbackRate : null,
  };
}

/**
 * Put a captured set back on a player, and keep trying for the parts that
 * cannot land yet.
 *
 * Volume, mute and speed apply straight away — they belong to the element, not
 * to the file. The track picks cannot go anywhere until the source has been
 * opened and has said what it carries, and "opened" happens more than once:
 * muxed tracks are known at the first trackschange, an external subtitle file
 * arrives at a later one. So each pick watches until its track turns up.
 *
 * Then it checks its own work once. The player restores its own remembered
 * language when the track list appears, and whichever of the two lands second
 * wins — so a pick that did not stick is re-issued a beat later, once. Twice is
 * the cap on purpose: past that it would be arguing with a viewer who has since
 * changed the track by hand.
 *
 * Returns a function that detaches early, for a caller that supersedes it.
 */
export function applySettings(el, settings) {
  if (!el || !settings) return () => {};

  if (typeof settings.volume === "number") safe(() => (el.volume = settings.volume));
  if (typeof settings.muted === "boolean") safe(() => (el.muted = settings.muted));
  if (typeof settings.rate === "number" && settings.rate > 0) {
    safe(() => (el.playbackRate = settings.rate));
  }

  const audioWant = settings.audio || null;
  const subWant = settings.subtitle || null;
  const subsOff = !!settings.subtitlesOff;
  let audioTries = 0;
  let subTries = 0;
  let audioDone = !audioWant;
  let subDone = !subWant && !subsOff;
  const timers = new Set();
  let stopped = false;

  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!stopped) fn();
    }, ms);
    timers.add(id);
  };

  function cleanup() {
    if (stopped) return;
    stopped = true;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    el.removeEventListener("trackschange", attempt);
  }

  function applyAudio() {
    if (audioDone) return;
    const surface = audioSurface(el);
    const hit = findTrack(surface.rows, audioWant);
    if (!hit) return;
    audioTries++;
    if (!hit.active) surface.select(hit);
    if (audioTries >= 2) {
      audioDone = true;
      return;
    }
    // Check it stuck: the player's own remembered language lands around now.
    later(() => {
      const now = findTrack(audioSurface(el).rows, audioWant);
      if (now && now.active) audioDone = true;
      else applyAudio();
      if (audioDone && subDone) cleanup();
    }, 900);
  }

  function applySub() {
    if (subDone) return;
    const surface = subtitleSurface(el);
    if (subsOff) {
      subDone = true;
      surface.off();
      return;
    }
    const hit = findTrack(surface.rows, subWant);
    if (!hit) return;
    subTries++;
    if (!hit.active) surface.select(hit);
    if (subTries >= 2) {
      subDone = true;
      return;
    }
    later(() => {
      const now = findTrack(subtitleSurface(el).rows, subWant);
      if (now && now.active) subDone = true;
      else applySub();
      if (audioDone && subDone) cleanup();
    }, 900);
  }

  function attempt() {
    applyAudio();
    applySub();
    if (audioDone && subDone) cleanup();
  }

  el.addEventListener("trackschange", attempt);
  // A track this file simply does not have would otherwise leave the listener
  // attached for the rest of the window's life.
  later(cleanup, 20000);
  // Coming BACK from PiP the main window never dropped its file, so there is no
  // trackschange left to wait for — the lists are already there.
  attempt();

  return cleanup;
}
