/**
 * EngineSound.js — synthesized engine hum (Web Audio, no sound files).
 * Pitch follows speed through a simple 5-gear box; volume rises with throttle.
 */

const GEAR_TOP_KMH = [20, 45, 75, 110, 160];
const IDLE_HZ = 38;
const REDLINE_HZ = 120;

export class EngineSound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  /** Must be called from a user gesture (the Start button), or browsers keep the audio muted. */
  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.sub = ctx.createOscillator();
    this.sub.type = 'square';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.4;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 400;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    this.osc.connect(this.filter);
    this.sub.connect(subGain).connect(this.filter);
    this.filter.connect(this.gain).connect(ctx.destination);
    this.osc.start();
    this.sub.start();
    this.ctx = ctx;
  }

  /**
   * @param {number} speedKmh
   * @param {boolean} throttle accelerator held
   * @param {boolean} active false while paused / not driving
   */
  update(speedKmh, throttle, active) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const on = active && this.enabled;

    let low = 0;
    let gear = GEAR_TOP_KMH.findIndex((top) => speedKmh < top);
    if (gear < 0) gear = GEAR_TOP_KMH.length - 1;
    if (gear > 0) low = GEAR_TOP_KMH[gear - 1];
    const rpm = Math.min(1, (speedKmh - low) / (GEAR_TOP_KMH[gear] - low));
    const hz = IDLE_HZ + (REDLINE_HZ - IDLE_HZ) * rpm;

    this.osc.frequency.setTargetAtTime(hz, now, 0.05);
    this.sub.frequency.setTargetAtTime(hz / 2, now, 0.05);
    this.filter.frequency.setTargetAtTime(throttle ? 900 : 450, now, 0.1);
    this.gain.gain.setTargetAtTime(on ? (throttle ? 0.12 : 0.06) : 0, now, 0.1);
  }
}
