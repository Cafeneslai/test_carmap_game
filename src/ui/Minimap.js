/**
 * Minimap.js — Small Leaflet map overlay for the HUD
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export class Minimap {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    // Initialize Leaflet map
    this.map = L.map(containerId, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false
    }).setView([0, 0], 16);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(this.map);

    // Car marker (a simple red dot with heading)
    const icon = L.divIcon({
      className: 'minimap-marker',
      html: '<div class="minimap-dot"><div class="minimap-dir"></div></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    this.marker = L.marker([0, 0], { icon }).addTo(this.map);
  }

  /**
   * Update minimap position and rotation
   * @param {number} lat 
   * @param {number} lng 
   * @param {number} heading - angle in radians
   */
  update(lat, lng, heading = 0) {
    if (!this.map) return;
    const pos = [lat, lng];
    this.map.setView(pos, 16, { animate: false });
    this.marker.setLatLng(pos);

    // Rotate marker
    const dot = this.container.querySelector('.minimap-dot');
    if (dot) {
      // Invert heading for 2D map rotation
      const deg = (heading * 180 / Math.PI) * -1;
      dot.style.transform = `rotate(${deg}deg)`;
    }
  }
}
