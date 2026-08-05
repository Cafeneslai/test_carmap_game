/**
 * LocationPicker.js — Location selection UI
 */

import { PRESET_LOCATIONS, NOMINATIM_API } from '../config.js';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export class LocationPicker {
  /**
   * @param {import('../core/Game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this.selectedLocation = null;

    // DOM elements
    this.el = document.getElementById('location-picker');
    this.searchInput = document.getElementById('location-search');
    this.searchBtn = document.getElementById('search-btn');
    this.searchResults = document.getElementById('search-results');
    this.presetGrid = document.getElementById('preset-grid');
    this.selectedEl = document.getElementById('selected-location');
    this.locationName = document.getElementById('location-name');
    this.startBtn = document.getElementById('start-btn');
    this.mapContainer = document.getElementById('interactive-map');

    this.map = null;
    this.marker = null;

    this._buildPresets();
    this._initMap();
    this._bindEvents();
  }

  _buildPresets() {
    this.presetGrid.innerHTML = '';

    for (const loc of PRESET_LOCATIONS) {
      const card = document.createElement('div');
      card.className = 'preset-card';
      card.innerHTML = `<span>${loc.name}</span>`;
      card.addEventListener('click', () => {
        this._selectLocation(loc);
        if (this.map) {
          this.map.setView([loc.lat, loc.lng], 15);
          this._updateMarker(loc.lat, loc.lng);
        }
      });
      this.presetGrid.appendChild(card);
    }
  }

  _initMap() {
    if (!this.mapContainer) return;

    // Default to Thailand center
    this.map = L.map('interactive-map').setView([13.7563, 100.5018], 5);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(this.map);

    // Fix for Leaflet marker icon path issues in Vite
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    });

    this.map.on('click', async (e) => {
      const lat = e.latlng.lat;
      const lng = e.latlng.lng;
      this._updateMarker(lat, lng);
      await this._reverseGeocode(lat, lng);
    });
  }

  _updateMarker(lat, lng) {
    if (!this.marker) {
      this.marker = L.marker([lat, lng]).addTo(this.map);
    } else {
      this.marker.setLatLng([lat, lng]);
    }
  }

  async _reverseGeocode(lat, lng) {
    this.locationName.textContent = 'กำลังค้นหาชื่อสถานที่...';
    this.selectedEl.classList.remove('hidden');

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14`,
        { headers: { 'Accept-Language': 'th,en' } }
      );
      const data = await response.json();
      
      const name = data.display_name ? data.display_name.split(',')[0] : 'ตำแหน่งที่เลือกบนแผนที่';
      
      this._selectLocation({
        name: '📍 ' + name,
        lat: lat,
        lng: lng,
      }, false); // don't update map view since user just clicked it
    } catch (err) {
      this._selectLocation({
        name: '📍 ตำแหน่งบนแผนที่',
        lat: lat,
        lng: lng,
      }, false);
    }
  }

  _bindEvents() {
    // Search
    this.searchBtn.addEventListener('click', () => this._search());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._search();
    });

    // Start button
    this.startBtn.addEventListener('click', () => {
      if (this.selectedLocation) {
        this.hide();
        this.game.startGame(this.selectedLocation);
      }
    });
  }

  async _search() {
    const query = this.searchInput.value.trim();
    if (!query) return;

    this.searchResults.innerHTML = '<div class="search-result-item">กำลังค้นหา...</div>';
    this.searchResults.classList.remove('hidden');

    try {
      const response = await fetch(
        `${NOMINATIM_API}?format=json&q=${encodeURIComponent(query)}&limit=5`,
        {
          headers: {
            'Accept-Language': 'th,en',
          },
        }
      );

      const results = await response.json();

      if (results.length === 0) {
        this.searchResults.innerHTML = '<div class="search-result-item">ไม่พบสถานที่</div>';
        return;
      }

      this.searchResults.innerHTML = '';
      for (const result of results) {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.textContent = result.display_name;
        item.addEventListener('click', () => {
          const loc = {
            name: '📍 ' + result.display_name.split(',')[0],
            lat: parseFloat(result.lat),
            lng: parseFloat(result.lon),
          };
          this._selectLocation(loc);
          if (this.map) {
            this.map.setView([loc.lat, loc.lng], 15);
            this._updateMarker(loc.lat, loc.lng);
          }
          this.searchResults.classList.add('hidden');
        });
        this.searchResults.appendChild(item);
      }
    } catch (err) {
      this.searchResults.innerHTML = `<div class="search-result-item">เกิดข้อผิดพลาด: ${err.message}</div>`;
    }
  }

  _selectLocation(loc, updateMap = true) {
    this.selectedLocation = loc;

    // Update UI
    this.locationName.textContent = loc.name;
    this.selectedEl.classList.remove('hidden');

    // Highlight selected preset
    const cards = this.presetGrid.querySelectorAll('.preset-card');
    cards.forEach(card => card.classList.remove('selected'));
    cards.forEach(card => {
      if (card.textContent.includes(loc.name.replace('📍 ', ''))) {
        card.classList.add('selected');
      }
    });
  }

  show() {
    this.el.classList.add('active');
    if (this.map) {
      // Fix Leaflet map sizing issue when div is initially hidden
      setTimeout(() => this.map.invalidateSize(), 100);
    }
  }

  hide() {
    this.el.classList.remove('active');
  }
}
