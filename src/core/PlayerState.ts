/**
 * PlayerState - State machine for player
 */

import type { PlayerState } from '../types';
import { EventEmitter } from '../events/EventEmitter';
import { Logger } from '../utils/Logger';

const TAG = 'PlayerState';

interface StateEvents {
  change: PlayerState;
}

// Valid state transitions
const VALID_TRANSITIONS: Record<PlayerState, PlayerState[]> = {
  idle: ['loading'],
  loading: ['ready', 'error'],
  ready: ['playing', 'paused', 'seeking', 'error'],
  playing: ['paused', 'seeking', 'buffering', 'ended', 'error'],
  paused: ['playing', 'seeking', 'error'],
  seeking: ['ready', 'playing', 'paused', 'buffering', 'error', 'seeking'],
  buffering: ['playing', 'paused', 'ended', 'error', 'seeking'],
  ended: ['seeking', 'idle'],
  error: ['idle'],
};

export class PlayerStateManager extends EventEmitter<StateEvents> {
  private state: PlayerState = 'idle';
  
  /**
   * Get current state
   */
  getState(): PlayerState {
    return this.state;
  }
  
  /**
   * Transition to a new state
   */
  setState(newState: PlayerState): boolean {
    if (newState === this.state) {
      return true;
    }
    
    const validTransitions = VALID_TRANSITIONS[this.state];
    if (!validTransitions.includes(newState)) {
      Logger.warn(TAG, `Invalid transition: ${this.state} -> ${newState}`);
      return false;
    }
    
    Logger.debug(TAG, `State: ${this.state} -> ${newState}`);
    this.state = newState;
    this.emit('change', newState);
    return true;
  }
  
  /**
   * Check if in a specific state
   */
  is(state: PlayerState): boolean {
    return this.state === state;
  }
  
  /**
   * Check if can play
   */
  canPlay(): boolean {
    return ['ready', 'paused', 'ended', 'buffering', 'seeking'].includes(this.state);
  }
  
  /**
   * Check if can pause
   *
   * "seeking" counts: a seek in flight can take seconds (software decode on a
   * phone, a keyframe hunt over a slow link), and dropping the user's pause for
   * that whole window meant the tap did nothing AND playback auto-resumed the
   * moment the seek landed. MoviPlayer.pause() honours it by clearing the
   * resume intent so the seek settles into "paused" instead.
   */
  canPause(): boolean {
    return (
      this.state === 'playing' ||
      this.state === 'buffering' ||
      this.state === 'seeking'
    );
  }
  
  /**
   * Check if can seek
   */
  canSeek(): boolean {
    return ['ready', 'playing', 'paused', 'ended', 'buffering', 'seeking'].includes(this.state);
  }
  
  /**
   * Reset to idle state
   */
  reset(): void {
    this.state = 'idle';
    Logger.debug(TAG, 'Reset to idle');
  }
}
