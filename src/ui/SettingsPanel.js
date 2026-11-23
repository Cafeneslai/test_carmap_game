/**
 * SettingsPanel.js — In-game settings overlay. Values are kept in localStorage between visits.
 */

const STORAGE_KEY = 'carmap.settings';

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
    this.soundCheckbox = document.getElementById('setting-sound');
    this.dayNightCheckbox = document.getElementById('setting-daynight');
    this.trafficCheckbox = document.getElementById('setting-traffic');
    this.satelliteCheckbox = document.getElementById('setting-satellite');
    this.weatherCheckbox = document.getElementById('setting-weather');
    this.resetBtn = document.getElementById('btn-reset-location');
    this.closeBtn = document.getElementById('btn-close-settings');

    this._bindEvents();
    this._restore();
  }

  _restore() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      // corrupt or blocked storage: keep the defaults
    }
    if (saved.viewDistance) this.viewDistanceSlider.value = saved.viewDistance;
    if (saved.quality) this.qualitySelect.value = saved.quality;
    if (typeof saved.shadows === 'boolean') this.shadowsCheckbox.checked = saved.shadows;
    if (typeof saved.trees === 'boolean') this.treesCheckbox.checked = saved.trees;
    if (typeof saved.sound === 'boolean') this.soundCheckbox.checked = saved.sound;
    if (typeof saved.dayNight === 'boolean') this.dayNightCheckbox.checked = saved.dayNight;
    if (typeof saved.traffic === 'boolean') this.trafficCheckbox.checked = saved.traffic;
    if (typeof saved.satellite === 'boolean') this.satelliteCheckbox.checked = saved.satellite;
    if (typeof saved.weather === 'boolean') this.weatherCheckbox.checked = saved.weather;

    // Run the normal handlers so the renderer matches the panel (it starts at "high" otherwise)
    this.viewDistanceSlider.dispatchEvent(new Event('input'));
    for (const el of [this.qualitySelect, this.shadowsCheckbox, this.treesCheckbox, this.soundCheckbox, this.dayNightCheckbox, this.trafficCheckbox, this.satelliteCheckbox, this.weatherCheckbox]) {
      el.dispatchEvent(new Event('change'));
    }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        viewDistance: parseInt(this.viewDistanceSlider.value),
        quality: this.qualitySelect.value,
        shadows: this.shadowsCheckbox.checked,
        trees: this.treesCheckbox.checked,
        sound: this.soundCheckbox.checked,
        dayNight: this.dayNightCheckbox.checked,
        traffic: this.trafficCheckbox.checked,
        satellite: this.satelliteCheckbox.checked,
        weather: this.weatherCheckbox.checked,
      }));
    } catch {
      // private mode / storage full: settings just won't persist
    }
  }

  _bindEvents() {
    // View distance slider
    this.viewDistanceSlider.addEventListener('input', () => {
      const val = parseInt(this.viewDistanceSlider.value);
      this.viewDistanceVal.textContent = val;

      this.game.chunkManager?.setViewDistance(val);
    });

    // Trees toggle
    this.treesCheckbox.addEventListener('change', () => {
      this.game.chunkManager?.setTreesEnabled(this.treesCheckbox.checked);
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

    // Engine sound toggle
    this.soundCheckbox.addEventListener('change', () => {
      this.game.engineSound.enabled = this.soundCheckbox.checked;
    });

    // Day/night toggle
    this.dayNightCheckbox.addEventListener('change', () => {
      this.game.dayNight.enabled = this.dayNightCheckbox.checked;
    });

    // NPC traffic toggle (also applies to the next location)
    this.trafficCheckbox.addEventListener('change', () => {
      this.game.trafficEnabled = this.trafficCheckbox.checked;
      if (this.game.traffic) this.game.traffic.enabled = this.trafficCheckbox.checked;
    });

    // Aerial imagery on the ground (chunks built from now on)
    this.satelliteCheckbox.addEventListener('change', () => {
      if (this.game.chunkManager) this.game.chunkManager.worldBuilder.satelliteEnabled = this.satelliteCheckbox.checked;
    });

    // Live weather (off = clear skies)
    this.weatherCheckbox.addEventListener('change', () => {
      this.game.weather.enabled = this.weatherCheckbox.checked;
    });

    // Persist every change
    for (const el of [this.viewDistanceSlider, this.qualitySelect, this.shadowsCheckbox, this.treesCheckbox, this.soundCheckbox, this.dayNightCheckbox, this.trafficCheckbox, this.satelliteCheckbox, this.weatherCheckbox]) {
      el.addEventListener('change', () => this._save());
    }

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

  /** Push the current panel values into a freshly created ChunkManager */
  applyTo(chunkManager) {
    chunkManager.setViewDistance(parseInt(this.viewDistanceSlider.value));
    chunkManager.setTreesEnabled(this.treesCheckbox.checked);
    chunkManager.worldBuilder.satelliteEnabled = this.satelliteCheckbox.checked;
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
