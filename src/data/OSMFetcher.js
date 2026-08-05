/**
 * OSMFetcher.js — Fetch road, building, water, greenery data from Overpass API
 */

import { OVERPASS_API, OSM_REQUEST_INTERVAL } from '../config.js';
import { bboxToOverpass } from './GeoUtils.js';

let lastRequestTime = 0;

/**
 * Wait to respect rate limiting
 */
async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < OSM_REQUEST_INTERVAL) {
    await new Promise(r => setTimeout(r, OSM_REQUEST_INTERVAL - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Send Overpass QL query
 * @param {string} query 
 * @returns {Promise<object>}
 */
async function queryOverpass(query) {
  await rateLimitWait();

  const response = await fetch(OVERPASS_API, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  if (!response.ok) {
    throw new Error(`Overpass API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch all data for a chunk in one combined query
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 * @returns {Promise<{ roads: object[], buildings: object[], water: object[], greenery: object[] }>}
 */
export async function fetchChunkData(bbox) {
  const b = bboxToOverpass(bbox);

  // Combined query for all data types in one request (saves API calls)
  const query = `
    [out:json][timeout:30];
    (
      way["highway"](${b});
      way["building"](${b});
      relation["building"](${b});
      way["natural"="water"](${b});
      way["waterway"](${b});
      relation["natural"="water"](${b});
      way["landuse"="forest"](${b});
      way["landuse"="grass"](${b});
      way["leisure"="park"](${b});
      way["leisure"="garden"](${b});
    );
    out geom;
  `;

  const data = await queryOverpass(query);

  // Categorize elements
  const roads = [];
  const buildings = [];
  const water = [];
  const greenery = [];

  if (data && data.elements) {
    for (const element of data.elements) {
      if (!element.tags) continue;

    if (element.tags.highway) {
      roads.push(element);
    } else if (element.tags.building) {
      buildings.push(element);
    } else if (element.tags.natural === 'water' || element.tags.waterway) {
      water.push(element);
    } else if (
      element.tags.landuse === 'forest' ||
      element.tags.landuse === 'grass' ||
      element.tags.leisure === 'park' ||
      element.tags.leisure === 'garden'
    ) {
      greenery.push(element);
    }
  }

  return { roads, buildings, water, greenery };
}

/**
 * Fetch roads only
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 */
export async function fetchRoads(bbox) {
  const b = bboxToOverpass(bbox);
  const query = `[out:json][timeout:25];way["highway"](${b});out geom;`;
  const data = await queryOverpass(query);
  return data.elements || [];
}

/**
 * Fetch buildings only
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 */
export async function fetchBuildings(bbox) {
  const b = bboxToOverpass(bbox);
  const query = `[out:json][timeout:25];(way["building"](${b});relation["building"](${b}););out geom;`;
  const data = await queryOverpass(query);
  return data.elements || [];
}
