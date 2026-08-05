/**
 * SettingsPanel.js — In-game settings overlay
 */

import { VIEW_DISTANCE } from '../config.js';

export class SettingsPanel {
  /**
   * @param {import('../core/Game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this.visible = false;

    // DOM elements
    this.el = document.getElementById('settings-panel');
    this.viewDistanceSlider = document.getElementById('setting-view-distance');
    this.viewDistanceVal = document.getElementById('view-distance-val');
    this.qualitySelect = document.getElementById('setting-quality');
    this.shadowsCheckbox = document.getElementById('setting-shadows');
    this.treesCheckbox = document.getElementById('setting-trees');
    this.resetBtn = document.getElementById('btn-reset-location');
    this.closeBtn = document.getElementById('btn-close-settings');

    this._bindEvents();
  }

  _bindEvents() {
    // View distance slider
    this.viewDistanceSlider.addEventListener('input', () => {
      const val = parseInt(this.viewDistanceSlider.value);
      this.viewDistanceVal.textContent = val;

      if (this.game.chunkManager) {
        // Dynamically update view distance (would need config to be mutable)
        // For now just display value
      }
    });

    // Shadows toggle
    this.shadowsCheckbox.addEventListener('change', () => {
      this.game.renderer.shadowMap.enabled = this.shadowsCheckbox.checked;
      // Update all lights
      if (this.game.sunLight) {
        this.game.sunLight.castShadow = this.shadowsCheckbox.checked;
      }
    });

    // Quality select
    this.qualitySelect.addEventListener('change', () => {
      const quality = this.qualitySelect.value;
      switch (quality) {
        case 'low':
          this.game.renderer.setPixelRatio(1);
          break;
        case 'medium':
          this.game.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
          break;
        case 'high':
          this.game.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
          break;
      }
    });

    // Reset location
    this.resetBtn.addEventListener('click', () => {
      this.game.resetToLocationSelect();
    });

    // Close button
    this.closeBtn.addEventListener('click', () => {
      this.hide();
      this.game.state = 'PLAYING';
    });
  }

  show() {
    this.visible = true;
    this.el.classList.remove('hidden');
  }

  hide() {
    this.visible = false;
    this.el.classList.add('hidden');
  }
}
