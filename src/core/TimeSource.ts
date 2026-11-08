/**
 * PlaybackTimeSource - the one clock the picture and the UI both read.
 *
 * This is Chromium's TimeSource (media/base/time_source.h) reduced to what a
 * browser page can do. There, the audio renderer is the time source, and the
 * video renderer never keeps a clock of its own: each frame asks the audio
 * renderer where on the wall clock it belongs (AudioRendererImpl::
 * GetWallClockTimes, audio_renderer_impl.cc). A second free-running clock that
 * is nudged towards the audio one now and then is what this replaces — however
 * it is corrected, it is a different clock, and the difference between the two
 * is the error the viewer sees.
 *
 * Here the audio side answers `mediaTimeAt(perfNow)`: the media time that is
 * being HEARD at that instant. When it cannot answer (no track, audio disabled,
 * the browser refusing to start the context, the track ended before the file)
 * the source falls back to a wall clock — Chromium's WallClockTimeSource — that
 * carries on from the last media time the audio gave. Every read from the audio
 * re-bases that wall clock, so the moment the audio drops away is the moment it
 * continues from, and there is no stale anchor to fall back onto.
 */

/** What the audio side must answer; AudioRenderer implements it. */
export interface AudioTimeSource {
  /**
   * The media time (seconds) the listener is hearing at `perfNowMs`
   * (performance.now() ms), or -1 when the sound is not a usable reference.
   */
  mediaTimeAt(perfNowMs: number): number;
}

export class PlaybackTimeSource {
  private audio: AudioTimeSource | null = null;
  /** The wall clock line: it was `media` seconds into the file at `perf` ms. */
  private media = 0;
  private perf = 0;
  private rate = 1;
  private ticking = false;
  /** Has anything given the wall clock a position yet? */
  private anchored = false;
  private _fromAudio = false;

  setAudio(audio: AudioTimeSource | null): void {
    this.audio = audio;
    if (!audio) this._fromAudio = false;
  }

  /**
   * Media seconds at `perfNowMs`, or -1 when there is no reference at all (the
   * audio cannot answer and nothing has ever positioned the wall clock).
   */
  now(perfNowMs: number = performance.now()): number {
    if (this.audio) {
      const heard = this.audio.mediaTimeAt(perfNowMs);
      if (heard >= 0) {
        // Whatever the wall clock believed, this is what is being heard. Take
        // it as the line to continue from if the audio is lost.
        this.media = heard;
        this.perf = perfNowMs;
        this.anchored = true;
        this._fromAudio = true;
        return heard;
      }
    }
    this._fromAudio = false;
    if (!this.anchored) return -1;
    if (!this.ticking) return this.media;
    return this.media + ((perfNowMs - this.perf) / 1000) * this.rate;
  }

  /** Did the last read come from the sound rather than the wall clock? */
  isAudioDriven(): boolean {
    return this._fromAudio && this.audio !== null;
  }

  /** Let the wall clock run from where it stands (see stop()). */
  start(perfNowMs: number = performance.now()): void {
    if (this.ticking) return;
    this.perf = perfNowMs;
    this.ticking = true;
  }

  /** Hold at the current time. */
  stop(perfNowMs: number = performance.now()): void {
    if (!this.ticking) return;
    const t = this.now(perfNowMs);
    if (t >= 0) this.media = t;
    this.ticking = false;
  }

  /** Put the wall clock at `mediaTime`. The audio, if any, is unaffected. */
  seek(mediaTime: number, perfNowMs: number = performance.now()): void {
    this.media = mediaTime;
    this.perf = perfNowMs;
    this.anchored = true;
  }

  /** Change how fast the wall clock runs, continuing from the current time. */
  setRate(rate: number, perfNowMs: number = performance.now()): void {
    const t = this.now(perfNowMs);
    if (t >= 0) {
      this.media = t;
      this.perf = perfNowMs;
    }
    this.rate = rate;
  }

  reset(): void {
    this.media = 0;
    this.perf = 0;
    this.rate = 1;
    this.ticking = false;
    this.anchored = false;
    this._fromAudio = false;
  }
}
