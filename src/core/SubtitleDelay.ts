/**
 * Subtitle delay (mpv's sub-delay, VLC's convention: a positive value shows the
 * subtitles later) for the subtitle files the player holds whole.
 */

/**
 * Index of the external cue on screen at media time `time` with `delay`
 * applied, or -1. A cue from `start` to `end` shows from `start + delay` to
 * `end + delay`. The renderer that paints it matches against the same shifted
 * time, so a cue picked by the unshifted time is one it then refuses to show.
 */
export function externalCueIndex(
  cues: readonly { start: number; end: number }[],
  time: number,
  delay: number,
): number {
  const t = time - delay;
  return cues.findIndex((c) => t >= c.start && t <= c.end);
}

/**
 * Whether the delay can be offered for what is showing. A subtitle file
 * (`<track>`, whatever the video source) is held whole, so shifting it is
 * arithmetic on cues already there. An in-band track is shifted from cues
 * read out of the container, and a delay ahead of what has been read needs
 * the whole stream read first (prefetchActiveSubtitleStream): only a local
 * file can afford that, a network source would download the whole video.
 */
export function canDelaySubtitles(state: {
  fileSource: boolean;
  externalActive: boolean;
}): boolean {
  return state.externalActive || state.fileSource;
}
