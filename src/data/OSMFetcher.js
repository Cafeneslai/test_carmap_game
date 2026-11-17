/**
 * OSMFetcher.js — High-performance OpenStreetMap fetcher using direct OSM API & Regional Prefetching
 */

import { OVERPASS_ENDPOINTS, OSM_REQUEST_INTERVAL } from '../config.js';
import { bboxToOverpass, getBoundingBox, latLngToMeters } from './GeoUtils.js';

let lastRequestTime = 0;
let currentEndpointIndex = 0;

// Regional in-memory cache to allow instantaneous chunk generation
let regionalCache = null;

/**
 * Wait to respect rate limiting if needed
 */
async function rateLimitWait(interval = OSM_REQUEST_INTERVAL) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < interval) {
    await new Promise((r) => setTimeout(r, interval - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Parse raw OSM XML into structured elements (roads, buildings, water, greenery)
 * Works in both browser and Node.js environments.
 */
function parseOsmXml(xml) {
  const nodes = new Map();
  const nodeRegex = /<node id="(\d+)"[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"/g;
  let match;
  while ((match = nodeRegex.exec(xml)) !== null) {
    nodes.set(match[1], { lat: parseFloat(match[2]), lon: parseFloat(match[3]) });
  }

  const wayRegex = /<way id="(\d+)"[\s\S]*?<\/way>/g;
  const roads = [];
  const buildings = [];
  const water = [];
  const greenery = [];

  while ((match = wayRegex.exec(xml)) !== null) {
    const wayXml = match[0];
    const ndRegex = /<nd ref="(\d+)"\/>/g;
    const geom = [];
    let ndMatch;
    while ((ndMatch = ndRegex.exec(wayXml)) !== null) {
      const node = nodes.get(ndMatch[1]);
      if (node) geom.push(node);
    }

    const tagRegex = /<tag k="([^"]+)" v="([^"]+)"\/>/g;
    const tags = {};
    let tagMatch;
    while ((tagMatch = tagRegex.exec(wayXml)) !== null) {
      tags[tagMatch[1]] = tagMatch[2];
    }

    const element = { id: match[1], geometry: geom, tags };

    if (tags.highway && geom.length >= 2) {
      roads.push(element);
    } else if (tags.building && geom.length >= 3) {
      buildings.push(element);
    } else if ((tags.natural === 'water' || tags.waterway) && geom.length >= 2) {
      water.push(element);
    } else if (
      (tags.landuse === 'forest' ||
        tags.landuse === 'grass' ||
        tags.leisure === 'park' ||
        tags.leisure === 'garden') &&
      geom.length >= 3
    ) {
      greenery.push(element);
    }
  }

  return { roads, buildings, water, greenery };
}

/**
 * Preload a large regional bounding box (e.g. 600m radius around location) in ONE single request.
 * Directly hits the official OSM API v0.6 which natively supports CORS and delivers full road/building data in <1s.
 *
 * @param {number} originLat
 * @param {number} originLng
 * @param {number} radiusMeters
 */
export async function preloadRegion(originLat, originLng, radiusMeters = 600) {
  const bbox = getBoundingBox(originLat, originLng, radiusMeters);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox.west.toFixed(6)},${bbox.south.toFixed(6)},${bbox.east.toFixed(6)},${bbox.north.toFixed(6)}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const xml = await response.text();
      const parsed = parseOsmXml(xml);

      if (parsed.roads.length > 0 || parsed.buildings.length > 0) {
        regionalCache = {
          originLat,
          originLng,
          bbox,
          ...parsed,
        };
        return regionalCache;
      }
    }
  } catch (err) {
    console.warn('Direct OSM API preload failed, will fallback to per-chunk queries:', err.message);
  }

  return null;
}

/**
 * Find the best road spawn point nearest to (originLat, originLng)
 * @param {number} originLat
 * @param {number} originLng
 * @returns {{ x: number, z: number, heading: number, roadType: string, name: string } | null}
 */
export function getBestSpawnPoint(originLat, originLng) {
  if (!regionalCache || !regionalCache.roads || regionalCache.roads.length === 0) {
    return null;
  }

  let minDistance = Infinity;
  let bestSpawn = null;

  for (const road of regionalCache.roads) {
    for (let i = 0; i < road.geometry.length - 1; i++) {
      const p1 = latLngToMeters(road.geometry[i].lat, road.geometry[i].lon, originLat, originLng);
      const p2 = latLngToMeters(road.geometry[i + 1].lat, road.geometry[i + 1].lon, originLat, originLng);

      const midX = (p1.x + p2.x) / 2;
      const midZ = (p1.z + p2.z) / 2;
      const dist = Math.hypot(midX, midZ);

      if (dist < minDistance) {
        minDistance = dist;
        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const heading = Math.atan2(dx, dz);
        bestSpawn = {
          x: midX,
          z: midZ,
          heading,
          roadType: road.tags.highway,
          name: road.tags.name || 'ถนน',
        };
      }
    }
  }

  return bestSpawn;
}

/**
 * Filter elements from regional cache that touch or intersect the given chunk bbox
 */
function filterFromRegionalCache(bbox) {
  if (!regionalCache) return null;

  // Check if bbox is within preloaded region
  const { south: regS, west: regW, north: regN, east: regE } = regionalCache.bbox;
  if (bbox.south < regS || bbox.north > regN || bbox.west < regW || bbox.east > regE) {
    return null; // outside preloaded region
  }

  // Slight padding so road polylines crossing chunk borders don't get cut
  const padLat = (bbox.north - bbox.south) * 0.15;
  const padLng = (bbox.east - bbox.west) * 0.15;
  const s = bbox.south - padLat;
  const n = bbox.north + padLat;
  const w = bbox.west - padLng;
  const e = bbox.east + padLng;

  const inBBox = (node) => node.lat >= s && node.lat <= n && node.lon >= w && node.lon <= e;

  const roads = regionalCache.roads.filter((el) => el.geometry.some(inBBox));
  const buildings = regionalCache.buildings.filter((el) => el.geometry.some(inBBox));
  const water = regionalCache.water.filter((el) => el.geometry.some(inBBox));
  const greenery = regionalCache.greenery.filter((el) => el.geometry.some(inBBox));

  return { roads, buildings, water, greenery };
}

/**
 * Send Overpass QL query as fallback
 */
async function queryOverpass(query) {
  const endpoints = [...OVERPASS_ENDPOINTS];

  for (let attempt = 0; attempt < endpoints.length; attempt++) {
    const endpointIndex = (currentEndpointIndex + attempt) % endpoints.length;
    const endpoint = endpoints[endpointIndex];

    try {
      await rateLimitWait(1000);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

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
        currentEndpointIndex = endpointIndex;
        return await response.json();
      }
    } catch {
      // try next
    }
  }

  return null;
}

/**
 * Generate synthetic road and building data if all external servers are unreachable.
 */
function generateProceduralFallback(bbox) {
  const { south, west, north, east } = bbox;
  const midLat = (south + north) / 2;
  const midLng = (west + east) / 2;
  const latSpan = north - south;
  const lngSpan = east - west;

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
  ];

  const buildings = [];
  const buildingOffsets = [
    [0.2, 0.2],
    [0.35, 0.2],
    [0.7, 0.7],
    [0.85, 0.7],
    [0.2, 0.7],
    [0.7, 0.2],
  ];

  const bSizeLat = latSpan * 0.1;
  const bSizeLng = lngSpan * 0.1;

  for (const [oLat, oLng] of buildingOffsets) {
    const bLat = south + latSpan * oLat;
    const bLng = west + lngSpan * oLng;
    buildings.push({
      tags: {
        building: 'yes',
        'building:levels': String(Math.floor(2 + (oLat + oLng) * 4)),
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

  const greenery = [
    {
      tags: { leisure: 'park' },
      geometry: [
        { lat: south + latSpan * 0.55, lon: west + lngSpan * 0.1 },
        { lat: south + latSpan * 0.85, lon: west + lngSpan * 0.1 },
        { lat: south + latSpan * 0.85, lon: west + lngSpan * 0.4 },
        { lat: south + latSpan * 0.55, lon: west + lngSpan * 0.4 },
        { lat: south + latSpan * 0.55, lon: west + lngSpan * 0.1 },
      ],
    },
  ];

  return { roads, buildings, water: [], greenery };
}

/**
 * Fetch all data for a chunk
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 * @returns {Promise<{ roads: object[], buildings: object[], water: object[], greenery: object[] }>}
 */
export async function fetchChunkData(bbox) {
  // 1. Try in-memory preloaded regional cache first (instant 0ms)
  const cached = filterFromRegionalCache(bbox);
  if (cached) {
    // If chunk in city has elements, return them
    if (cached.roads.length > 0 || cached.buildings.length > 0) {
      return cached;
    }
  }

  // 2. Direct OSM API query for this chunk
  try {
    const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox.west.toFixed(6)},${bbox.south.toFixed(6)},${bbox.east.toFixed(6)},${bbox.north.toFixed(6)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const xml = await response.text();
      const parsed = parseOsmXml(xml);
      if (parsed.roads.length > 0 || parsed.buildings.length > 0) {
        return parsed;
      }
    }
  } catch {
    // fallback to overpass
  }

  // 3. Fallback to Overpass API
  const b = bboxToOverpass(bbox);
  const query = `
    [out:json][timeout:8];
    (
      way["highway"](${b});
      way["building"](${b});
      relation["building"](${b});
      way["natural"="water"](${b});
      way["waterway"](${b});
      way["landuse"="forest"](${b});
      way["leisure"="park"](${b});
    );
    out geom;
  `;

  const data = await queryOverpass(query);
  if (data && data.elements && data.elements.length > 0) {
    const roads = [];
    const buildings = [];
    const water = [];
    const greenery = [];

    for (const element of data.elements) {
      if (!element.tags) continue;
      if (element.tags.highway) roads.push(element);
      else if (element.tags.building) buildings.push(element);
      else if (element.tags.natural === 'water' || element.tags.waterway) water.push(element);
      else if (element.tags.landuse || element.tags.leisure) greenery.push(element);
    }

    if (roads.length > 0 || buildings.length > 0) {
      return { roads, buildings, water, greenery };
    }
  }

  // 4. Procedural fallback to guarantee roads and buildings exist
  return generateProceduralFallback(bbox);
}
