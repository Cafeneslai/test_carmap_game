/**
 * ElevationFetcher.js — Fetch elevation data from Open Topo Data API
 */

import { ELEVATION_API, ELEVATION_REQUEST_INTERVAL } from '../config.js';

let lastRequestTime = 0;

/**
 * Rate limit wait
 */
async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < ELEVATION_REQUEST_INTERVAL) {
    await new Promise(r => setTimeout(r, ELEVATION_REQUEST_INTERVAL - elapsed));
  }
  lastRequestTime = Date.now();
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
  const points = [];
  const latStep = (north - south) / (resolution - 1);
  const lngStep = (east - west) / (resolution - 1);

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const lat = south + row * latStep;
      const lng = west + col * lngStep;
      points.push(`${lat.toFixed(6)},${lng.toFixed(6)}`);
    }
  }

  // Open Topo Data accepts max 100 points per request
  const batchSize = 100;
  const allElevations = [];

  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    const locations = batch.join('|');

    try {
      await rateLimitWait();

      const response = await fetch(`${ELEVATION_API}?locations=${locations}`);

      if (!response.ok) {
        console.warn(`Elevation API error: ${response.status}`);
        // Fill with zeros on failure
        allElevations.push(...batch.map(() => 0));
        continue;
      }

      const data = await response.json();

      if (data.results) {
        for (const result of data.results) {
          allElevations.push(result.elevation ?? 0);
        }
      } else {
        allElevations.push(...batch.map(() => 0));
      }
    } catch (err) {
      console.warn('Elevation fetch failed, using flat terrain:', err.message);
      allElevations.push(...batch.map(() => 0));
    }
  }

  // Reshape to 2D grid
  const grid = [];
  for (let row = 0; row < resolution; row++) {
    grid.push(allElevations.slice(row * resolution, (row + 1) * resolution));
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
    await rateLimitWait();
    const response = await fetch(`${ELEVATION_API}?locations=${lat},${lng}`);
    const data = await response.json();
    return data.results?.[0]?.elevation ?? 0;
  } catch {
    return 0;
  }
}
