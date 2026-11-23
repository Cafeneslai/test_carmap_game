/**
 * HUD.js — In-game heads-up display
 */

import { Minimap } from './Minimap.js';

export class HUD {
  constructor() {
    this.el = document.getElementById('hud');
    this.locationEl = document.getElementById('hud-location');
    this.fpsEl = document.getElementById('hud-fps');
    this.clockEl = document.getElementById('hud-clock');
    this.speedNumber = document.getElementById('speed-number');
    this.gaugeFill = document.getElementById('gauge-fill');

    // Gauge circumference for stroke-dashoffset calculation
    this.gaugeCircumference = 2 * Math.PI * 90; // r=90

    this.missionEl = document.getElementById('hud-mission');
    this.missionArrow = document.getElementById('mission-arrow');
    this.missionMain = document.getElementById('mission-main');
    this.missionSub = document.getElementById('mission-sub');

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
    setTimeout(() => {
      if (this.minimap) {
        this.minimap.invalidateSize();
      }
    }, 100);
  }

  hide() {
    this.el.classList.add('hidden');
    this.missionEl.classList.add('hidden');
    this.minimap?.setTarget(null);
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
   * @param {ReturnType<import('../core/Mission.js').Mission['update']>} info
   * @param {number} carHeading
   */
  updateMission(info, carHeading) {
    this.missionEl.classList.remove('hidden');
    if (!info || info.distance === 0) {
      this.missionArrow.style.visibility = 'hidden';
      this.missionMain.textContent = info
        ? `✅ ถึงแล้ว! เช็กพอยต์ที่ ${info.count}${info.newRecord ? ' · 🏆 สถิติใหม่!' : ''}`
        : '🏁 กำลังหาจุดเช็กพอยต์...';
      if (info) this.missionSub.textContent = statsText(info);
      return;
    }
    // Screen up = straight ahead; a target to the car's left (+angle) turns the arrow counter-clockwise
    const rel = info.angle - carHeading;
    this.missionArrow.style.visibility = 'visible';
    this.missionArrow.style.transform = `rotate(${(-rel * 180) / Math.PI}deg)`;
    this.missionMain.textContent = `🏁 ${Math.round(info.distance)} ม. · ${formatTime(info.elapsed)}`;
    this.missionSub.textContent = `${info.name} · ${statsText(info)}`;
  }

  /** @param {string} text "HH:MM" */
  updateClock(text) {
    const label = `🕘 ${text}`;
    if (this.clockEl.textContent !== label) this.clockEl.textContent = label;
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

function formatTime(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "ผ่านแล้ว 3 (รวม 12) · ดีที่สุด 1:05/กม." */
function statsText(info) {
  const best = info.bestPace === null ? '' : ` · ดีที่สุด ${formatTime(info.bestPace)}/กม.`;
  return `ผ่านแล้ว ${info.count} (รวม ${info.total})${best}`;
}
