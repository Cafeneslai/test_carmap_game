/**
 * Minimap.js — Small Leaflet map overlay for the HUD
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { addBaseLayer } from './tiles.js';
import { headingToBearingDeg } from './compass.js';

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

    addBaseLayer(this.map, 'street');

    // Car marker (a directional arrow icon)
    const icon = L.divIcon({
      className: 'minimap-marker',
      html: '<div class="minimap-dot"><div class="minimap-dir"></div></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    this.marker = L.marker([0, 0], { icon }).addTo(this.map);
    this.map.on('click', () => this.toggleExpanded()); // touch screens have no M key
  }

  /**
   * Show the current checkpoint, or hide it with null
   * @param {{ lat: number, lng: number } | null} pos
   */
  setTarget(pos) {
    if (!this.map) return;
    if (!pos) {
      this.targetMarker?.remove();
      this.targetMarker = null;
      return;
    }
    if (!this.targetMarker) {
      this.targetMarker = L.circleMarker([pos.lat, pos.lng], {
        radius: 7, color: '#000', weight: 2, fillColor: '#ffcc00', fillOpacity: 1,
      }).addTo(this.map);
    } else {
      this.targetMarker.setLatLng([pos.lat, pos.lng]);
    }
  }

  /**
   * M key: grow the minimap into a big map (zoomed out, wheel zoom on), or shrink it back.
   * The car keeps driving underneath.
   */
  toggleExpanded() {
    if (!this.map) return;
    this.expanded = !this.expanded;
    this.container.parentElement.classList.toggle('expanded', this.expanded);
    this.zoom = this.expanded ? 15 : 16;
    this.map.scrollWheelZoom[this.expanded ? 'enable' : 'disable']();
    this.map.invalidateSize();
    this.lastPanLat = null; // re-centre on the next update
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
      dot.style.transform = `rotate(${headingToBearingDeg(heading)}deg)`;
    }

    // Throttle Leaflet setView to prevent tile flooding and blank tiles
    const now = performance.now();
    const shouldPan =
      this.lastPanLat === null ||
      now - this.lastPanTime > 150 ||
      Math.abs(lat - this.lastPanLat) > 0.0001 ||
      Math.abs(lng - this.lastPanLng) > 0.0001;

    if (shouldPan) {
      // Keep the zoom the player picked with the wheel on the big map
      if (this.expanded && this.lastPanLat !== null) this.zoom = this.map.getZoom();
      this.map.setView(pos, this.zoom ?? 16, { animate: false });
      this.lastPanLat = lat;
      this.lastPanLng = lng;
      this.lastPanTime = now;
    }
  }
}
