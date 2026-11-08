/**
 * Clock - the player's media clock.
 *
 * A thin shell over PlaybackTimeSource: the same time source the picture reads,
 * so the time on the seek bar and the frame on screen cannot disagree. It adds
 * what only the player needs — pause with a held time, a duration to clamp the
 * wall-clock fallback to, and the rate.
 */

import { Logger } from '../utils/Logger';
import { PlaybackTimeSource, type AudioTimeSource } from './TimeSource';

const TAG = 'Clock';

/** What the clock needs from the audio side. */
export type AudioClockProvider = AudioTimeSource;

export class Clock {
  private readonly source = new PlaybackTimeSource();
  private pausedTime: number = 0;
  private isRunning: boolean = false;
  private playbackRate: number = 1.0;
  private duration: number = 0; // Media duration for clamping

  /**
   * The time source behind this clock. The video renderer reads it directly, so
   * that there is exactly one answer to "what time is it" in the player.
   */
  get timeSource(): PlaybackTimeSource {
    return this.source;
  }

  /**
   * Set the audio side of the time source. Pass null to run on the wall clock
   * only (no track, audio disabled).
   */
  setAudioProvider(provider: AudioClockProvider | null): void {
    this.source.setAudio(provider);
    Logger.debug(
      TAG,
      provider ? 'Audio provider set' : 'Audio provider disabled - using wall clock only',
    );
  }

  /**
   * Set media duration for clock clamping
   */
  setDuration(duration: number): void {
    this.duration = duration;
    Logger.debug(TAG, `Duration set to ${duration}s`);
  }

  /**
   * Start/resume the clock
   */
  start(): void {
    if (this.isRunning) return;
    this.source.seek(this.pausedTime);
    this.source.start();
    this.isRunning = true;
    Logger.debug(TAG, `Started at ${this.pausedTime}s`);
  }

  /**
   * Pause the clock
   */
  pause(): void {
    if (!this.isRunning) return;

    this.pausedTime = this.getTime();
    this.source.stop();
    this.isRunning = false;
    Logger.debug(TAG, `Paused at ${this.pausedTime}s`);
  }

  /**
   * Seek to a specific time
   */
  seek(time: number): void {
    this.pausedTime = time;
    this.source.seek(time);
    Logger.debug(TAG, `Seeked to ${time}s`);
  }

  /**
   * The media time now: what is being heard while the sound is a usable
   * reference, a wall clock continuing from it otherwise.
   */
  getTime(): number {
    if (!this.isRunning) {
      return this.pausedTime;
    }
    let time = this.source.now();
    if (time < 0) return this.pausedTime;
    // The duration bounds the wall clock, which has no sound to stop it. The
    // sound is never clamped: it is what is actually being played.
    if (!this.source.isAudioDriven() && this.duration > 0) {
      time = Math.min(time, this.duration);
    }
    return time;
  }

  /**
   * Time for video frame presentation. The same reading as getTime(): there is
   * one time source, and the picture is not allowed a different opinion.
   */
  getVideoSyncTime(): number {
    return this.getTime();
  }

  /**
   * Set playback rate
   */
  setPlaybackRate(rate: number): void {
    // Continue from the current time; the sound carries its own rate per
    // segment, so only the wall-clock fallback has anything to change.
    if (this.isRunning) this.pausedTime = this.getTime();
    this.playbackRate = rate;
    this.source.setRate(rate);
    Logger.debug(TAG, `Playback rate set to ${rate}`);
  }

  /**
   * Get playback rate
   */
  getPlaybackRate(): number {
    return this.playbackRate;
  }

  /**
   * Check if clock is running
   */
  isPlaying(): boolean {
    return this.isRunning;
  }

  /**
   * Is the time being read from the sound (as opposed to the wall clock)?
   */
  isSyncedToAudio(): boolean {
    return this.source.isAudioDriven();
  }

  /**
   * Reset clock
   */
  reset(): void {
    this.pausedTime = 0;
    this.isRunning = false;
    this.playbackRate = 1.0;
    this.duration = 0;
    this.source.reset();
    Logger.debug(TAG, 'Reset');
  }
}
