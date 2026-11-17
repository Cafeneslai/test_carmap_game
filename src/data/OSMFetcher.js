/**
 * OSMFetcher.js — Fetch road, building, water, greenery data with multi-endpoint fallback & procedural offline mode
 */

import { OVERPASS_ENDPOINTS, OSM_REQUEST_INTERVAL } from '../config.js';
import { bboxToOverpass } from './GeoUtils.js';

let lastRequestTime = 0;
let currentEndpointIndex = 0;

/**
 * Wait to respect rate limiting
 */
async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < OSM_REQUEST_INTERVAL) {
    await new Promise((r) => setTimeout(r, OSM_REQUEST_INTERVAL - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Send Overpass QL query with rotation and failover across endpoints
 * @param {string} query
 * @returns {Promise<object | null>}
 */
async function queryOverpass(query) {
  const endpoints = [...OVERPASS_ENDPOINTS];

  for (let attempt = 0; attempt < endpoints.length; attempt++) {
    const endpointIndex = (currentEndpointIndex + attempt) % endpoints.length;
    const endpoint = endpoints[endpointIndex];

    try {
      await rateLimitWait();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s timeout

      const response = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        currentEndpointIndex = endpointIndex; // remember working endpoint
        return await response.json();
      }

      console.warn(`Overpass endpoint ${endpoint} returned ${response.status}. Trying next...`);
    } catch (err) {
      console.warn(`Overpass query to ${endpoint} failed: ${err.message}. Trying next...`);
    }
  }

  return null;
}

/**
 * Generate synthetic road and building data if all external Overpass servers fail.
 * Ensures the world is never an empty void even if public APIs are down or rate-limited.
 */
function generateProceduralFallback(bbox) {
  const { south, west, north, east } = bbox;
  const midLat = (south + north) / 2;
  const midLng = (west + east) / 2;
  const latSpan = north - south;
  const lngSpan = east - west;

  // 1. Procedural Roads (a cross intersection)
  const roads = [
    {
      tags: { highway: 'primary' },
      geometry: [
        { lat: midLat, lon: west },
        { lat: midLat, lon: east },
      ],
    },
    {
      tags: { highway: 'secondary' },
      geometry: [
        { lat: south, lon: midLng },
        { lat: north, lon: midLng },
      ],
    },
    {
      tags: { highway: 'residential' },
      geometry: [
        { lat: south + latSpan * 0.25, lon: west },
        { lat: south + latSpan * 0.25, lon: east },
      ],
    },
  ];

  // 2. Procedural Buildings in quadrants
  const buildings = [];
  const buildingOffsets = [
    [0.15, 0.15],
    [0.35, 0.15],
    [0.15, 0.35],
    [0.65, 0.65],
    [0.8, 0.65],
    [0.65, 0.8],
    [0.15, 0.65],
    [0.65, 0.15],
  ];

  const bSizeLat = latSpan * 0.08;
  const bSizeLng = lngSpan * 0.08;

  for (const [oLat, oLng] of buildingOffsets) {
    const bLat = south + latSpan * oLat;
    const bLng = west + lngSpan * oLng;
    buildings.push({
      tags: {
        building: 'yes',
        'building:levels': String(Math.floor(2 + (oLat + oLng) * 5)),
      },
      geometry: [
        { lat: bLat, lon: bLng },
        { lat: bLat + bSizeLat, lon: bLng },
        { lat: bLat + bSizeLat, lon: bLng + bSizeLng },
        { lat: bLat, lon: bLng + bSizeLng },
        { lat: bLat, lon: bLng },
      ],
    });
  }

  // 3. Greenery park in top-left
  const greenery = [
    {
      tags: { leisure: 'park' },
      geometry: [
        { lat: south + latSpan * 0.6, lon: west + lngSpan * 0.1 },
        { lat: south + latSpan * 0.85, lon: west + lngSpan * 0.1 },
        { lat: south + latSpan * 0.85, lon: west + lngSpan * 0.35 },
        { lat: south + latSpan * 0.6, lon: west + lngSpan * 0.35 },
        { lat: south + latSpan * 0.6, lon: west + lngSpan * 0.1 },
      ],
    },
  ];

  return { roads, buildings, water: [], greenery };
}

/**
 * Fetch all data for a chunk in one combined query with fallback
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 * @returns {Promise<{ roads: object[], buildings: object[], water: object[], greenery: object[] }>}
 */
export async function fetchChunkData(bbox) {
  const b = bboxToOverpass(bbox);

  const query = `
    [out:json][timeout:12];
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

  if (!data || !data.elements || data.elements.length === 0) {
    // If Overpass returned nothing or failed, use procedural generation
    return generateProceduralFallback(bbox);
  }

  const roads = [];
  const buildings = [];
  const water = [];
  const greenery = [];

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

  // If real query had no roads or buildings in this area, complement with procedural roads
  if (roads.length === 0 && buildings.length === 0) {
    const fallback = generateProceduralFallback(bbox);
    return fallback;
  }

  return { roads, buildings, water, greenery };
}

/**
 * Fetch roads only
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 */
export async function fetchRoads(bbox) {
  const data = await fetchChunkData(bbox);
  return data.roads;
}

/**
 * Fetch buildings only
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 */
export async function fetchBuildings(bbox) {
  const data = await fetchChunkData(bbox);
  return data.buildings;
}
