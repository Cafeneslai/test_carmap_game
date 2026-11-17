/**
 * Minimap.js — Small Leaflet map overlay for the HUD
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export class Minimap {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.lastPanLat = null;
    this.lastPanLng = null;
    this.lastPanTime = 0;

    // Initialize Leaflet map
    this.map = L.map(containerId, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
    }).setView([0, 0], 16);

    // Use CartoDB Voyager or fallback for crisp, dark/clean game minimap
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(this.map);

    // Car marker (a directional arrow icon)
    const icon = L.divIcon({
      className: 'minimap-marker',
      html: '<div class="minimap-dot"><div class="minimap-dir"></div></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    this.marker = L.marker([0, 0], { icon }).addTo(this.map);
  }

  /**
   * Recalculate container dimensions when HUD is revealed
   */
  invalidateSize() {
    if (this.map) {
      this.map.invalidateSize();
    }
  }

  /**
   * Update minimap position and rotation smoothly
   * @param {number} lat
   * @param {number} lng
   * @param {number} heading - angle in radians
   */
  update(lat, lng, heading = 0) {
    if (!this.map || isNaN(lat) || isNaN(lng)) return;

    const pos = [lat, lng];

    // Marker position and rotation update smoothly every frame
    this.marker.setLatLng(pos);

    const dot = this.container.querySelector('.minimap-dot');
    if (dot) {
      const deg = (heading * 180 / Math.PI) * -1;
      dot.style.transform = `rotate(${deg}deg)`;
    }

    // Throttle Leaflet setView to prevent tile flooding and blank tiles
    const now = performance.now();
    const shouldPan =
      this.lastPanLat === null ||
      now - this.lastPanTime > 150 ||
      Math.abs(lat - this.lastPanLat) > 0.0001 ||
      Math.abs(lng - this.lastPanLng) > 0.0001;

    if (shouldPan) {
      this.map.setView(pos, 16, { animate: false });
      this.lastPanLat = lat;
      this.lastPanLng = lng;
      this.lastPanTime = now;
    }
  }
}
