/**
 * ElevationFetcher.js — Fetch elevation data with Open-Meteo primary and OpenTopoData fallback
 */

import {
  ELEVATION_API,
  OPEN_METEO_ELEVATION_API,
  ELEVATION_REQUEST_INTERVAL,
} from '../config.js';

let lastRequestTime = 0;

/**
 * Rate limit wait
 */
async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < ELEVATION_REQUEST_INTERVAL) {
    await new Promise((r) => setTimeout(r, ELEVATION_REQUEST_INTERVAL - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Fetch elevation for a grid using Open-Meteo (fast, single batch, CORS-enabled)
 * @param {Array<{lat: number, lng: number}>} points
 * @returns {Promise<number[] | null>}
 */
async function fetchFromOpenMeteo(points) {
  try {
    const lats = points.map(p => p.lat.toFixed(5)).join(',');
    const lngs = points.map(p => p.lng.toFixed(5)).join(',');
    const url = `${OPEN_METEO_ELEVATION_API}?latitude=${lats}&longitude=${lngs}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json();
    if (Array.isArray(data.elevation) && data.elevation.length === points.length) {
      return data.elevation.map(v => (typeof v === 'number' && !isNaN(v) ? v : 0));
    }
  } catch (err) {
    // silently fail to next provider
  }
  return null;
}

/**
 * Fetch elevation for a grid of points within a bounding box
 *
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 * @param {number} resolution - Number of points per side (e.g., 8 = 8x8 grid)
 * @returns {Promise<number[][]>} 2D array of elevation values [row][col]
 */
export async function fetchElevationGrid(bbox, resolution = 8) {
  const { south, west, north, east } = bbox;

  // Build coordinate pairs
  const pointCoords = [];
  const latStep = (north - south) / (resolution - 1);
  const lngStep = (east - west) / (resolution - 1);

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const lat = south + row * latStep;
      const lng = west + col * lngStep;
      pointCoords.push({ lat, lng });
    }
  }

  // 1. Try Open-Meteo first (fastest, 1 request for the entire grid)
  let elevations = await fetchFromOpenMeteo(pointCoords);

  // 2. Fallback to OpenTopoData if Open-Meteo returned null
  if (!elevations) {
    const points = pointCoords.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`);
    const batchSize = 100;
    elevations = [];

    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      const locations = batch.join('|');

      try {
        await rateLimitWait();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const response = await fetch(`${ELEVATION_API}?locations=${locations}`, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
          elevations.push(...batch.map(() => 0));
          continue;
        }

        const data = await response.json();
        if (data.results) {
          for (const result of data.results) {
            elevations.push(result.elevation ?? 0);
          }
        } else {
          elevations.push(...batch.map(() => 0));
        }
      } catch (err) {
        elevations.push(...batch.map(() => 0));
      }
    }
  }

  // Ensure elevations has full length
  const total = resolution * resolution;
  while (elevations.length < total) {
    elevations.push(0);
  }

  // Reshape to 2D grid
  const grid = [];
  for (let row = 0; row < resolution; row++) {
    grid.push(elevations.slice(row * resolution, (row + 1) * resolution));
  }

  return grid;
}

/**
 * Fetch elevation at a single point
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<number>}
 */
export async function getElevationAtPoint(lat, lng) {
  try {
    const fromMeteo = await fetchFromOpenMeteo([{ lat, lng }]);
    if (fromMeteo && typeof fromMeteo[0] === 'number') {
      return fromMeteo[0];
    }
    await rateLimitWait();
    const response = await fetch(`${ELEVATION_API}?locations=${lat},${lng}`);
    const data = await response.json();
    return data.results?.[0]?.elevation ?? 0;
  } catch {
    return 0;
  }
}
