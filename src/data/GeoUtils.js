/**
 * GeoUtils.js — Lat/Lng ↔ Meters conversion utilities
 * 
 * Uses Equirectangular approximation for local areas.
 * Origin point is the player's selected location.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_RADIUS = 6371000; // meters

/**
 * Convert lat/lng to local XZ meters relative to an origin
 * X = East/West, Z = North/South (Three.js convention: -Z = forward/North)
 * 
 * @param {number} lat 
 * @param {number} lng 
 * @param {number} originLat 
 * @param {number} originLng 
 * @returns {{ x: number, z: number }}
 */
export function latLngToMeters(lat, lng, originLat, originLng) {
  const dLat = (lat - originLat) * DEG_TO_RAD;
  const dLng = (lng - originLng) * DEG_TO_RAD;
  const cosLat = Math.cos(originLat * DEG_TO_RAD);

  const x = dLng * EARTH_RADIUS * cosLat;
  const z = -dLat * EARTH_RADIUS; // Negate so north = -Z (Three.js forward)

  return { x, z };
}

/**
 * Convert local XZ meters back to lat/lng
 * 
 * @param {number} x 
 * @param {number} z 
 * @param {number} originLat 
 * @param {number} originLng 
 * @returns {{ lat: number, lng: number }}
 */
export function metersToLatLng(x, z, originLat, originLng) {
  const cosLat = Math.cos(originLat * DEG_TO_RAD);

  const lat = originLat + (-z / EARTH_RADIUS) * RAD_TO_DEG;
  const lng = originLng + (x / (EARTH_RADIUS * cosLat)) * RAD_TO_DEG;

  return { lat, lng };
}

/**
 * Get bounding box around a point
 * 
 * @param {number} lat 
 * @param {number} lng 
 * @param {number} radiusMeters 
 * @returns {{ south: number, west: number, north: number, east: number }}
 */
export function getBoundingBox(lat, lng, radiusMeters) {
  const dLat = (radiusMeters / EARTH_RADIUS) * RAD_TO_DEG;
  const dLng = (radiusMeters / (EARTH_RADIUS * Math.cos(lat * DEG_TO_RAD))) * RAD_TO_DEG;

  return {
    south: lat - dLat,
    west: lng - dLng,
    north: lat + dLat,
    east: lng + dLng,
  };
}

/**
 * Haversine distance between two points in meters
 * 
 * @param {number} lat1 
 * @param {number} lng1 
 * @param {number} lat2 
 * @param {number} lng2 
 * @returns {number}
 */
export function calculateDistance(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
    Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Convert bounding box to Overpass API format string
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 * @returns {string}
 */
export function bboxToOverpass(bbox) {
  return `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
}
