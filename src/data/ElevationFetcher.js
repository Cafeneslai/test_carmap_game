/**
 * ElevationFetcher.js — Look up ground elevation for a list of coordinates.
 *
 * Open-Meteo is the primary provider (CORS enabled, one request for up to 100 points). It meters
 * usage per coordinate (about 600 per minute on the free tier), so callers should ask for as few
 * points as possible — see ElevationField. OpenTopoData is the fallback.
 */

import { ELEVATION_API, OPEN_METEO_ELEVATION_API } from '../config.js';

export const MAX_POINTS_PER_REQUEST = 100;
const TIMEOUT_MS = 8000;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fromOpenMeteo(points) {
  const lats = points.map((p) => p.lat.toFixed(5)).join(',');
  const lngs = points.map((p) => p.lng.toFixed(5)).join(',');
  const data = await getJson(`${OPEN_METEO_ELEVATION_API}?latitude=${lats}&longitude=${lngs}`);
  if (!Array.isArray(data.elevation) || data.elevation.length !== points.length) {
    throw new Error('Open-Meteo returned an unexpected payload');
  }
  return data.elevation.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0));
}

async function fromOpenTopoData(points) {
  const locations = points.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
  const data = await getJson(`${ELEVATION_API}?locations=${locations}`);
  if (!Array.isArray(data.results) || data.results.length !== points.length) {
    throw new Error('OpenTopoData returned an unexpected payload');
  }
  return data.results.map((r) => (typeof r.elevation === 'number' ? r.elevation : 0));
}

/**
 * Elevation in metres for each point, in the same order.
 * @param {{ lat: number, lng: number }[]} points at most MAX_POINTS_PER_REQUEST
 * @returns {Promise<number[]>}
 * @throws when every provider failed, so callers never mistake a failure for sea level
 */
export async function fetchElevations(points) {
  if (points.length === 0) return [];
  if (points.length > MAX_POINTS_PER_REQUEST) {
    throw new Error(`At most ${MAX_POINTS_PER_REQUEST} points per request`);
  }

  try {
    return await fromOpenMeteo(points);
  } catch (primaryError) {
    try {
      return await fromOpenTopoData(points);
    } catch (fallbackError) {
      throw new Error(`Elevation providers unavailable (${primaryError.message}; ${fallbackError.message})`);
    }
  }
}
