/**
 * HUD.js — In-game heads-up display
 */

import { Minimap } from './Minimap.js';

export class HUD {
  constructor() {
    this.el = document.getElementById('hud');
    this.locationEl = document.getElementById('hud-location');
    this.fpsEl = document.getElementById('hud-fps');
    this.speedNumber = document.getElementById('speed-number');
    this.gaugeFill = document.getElementById('gauge-fill');

    // Gauge circumference for stroke-dashoffset calculation
    this.gaugeCircumference = 2 * Math.PI * 90; // r=90

    // Minimap
    this.minimap = new Minimap('minimap');
  }

  /**
   * Show HUD with location name
   * @param {string} locationName
   */
  show(locationName) {
    this.el.classList.remove('hidden');
    this.locationEl.textContent = `📍 ${locationName}`;
  }

  hide() {
    this.el.classList.add('hidden');
  }

  /**
   * Update speed display
   * @param {number} speed - km/h
   */
  updateSpeed(speed) {
    const rounded = Math.round(speed);
    this.speedNumber.textContent = rounded;

    // Update gauge (max 200 km/h)
    const ratio = Math.min(speed / 200, 1);
    const offset = this.gaugeCircumference * (1 - ratio);
    this.gaugeFill.style.strokeDashoffset = offset;

    // Color change based on speed
    if (speed > 150) {
      this.gaugeFill.style.stroke = '#ff4444';
    } else if (speed > 80) {
      this.gaugeFill.style.stroke = '#ffaa00';
    } else {
      this.gaugeFill.style.stroke = '#00d4ff';
    }
  }

  /**
   * Update FPS counter
   * @param {number} fps
   */
  updateFps(fps) {
    this.fpsEl.textContent = `${fps} FPS`;
  }

  /**
   * Update minimap
   */
  updateMinimap(lat, lng, heading) {
    if (this.minimap) {
      this.minimap.update(lat, lng, heading);
    }
  }
}
