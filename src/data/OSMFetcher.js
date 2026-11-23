/**
 * OSMFetcher.js — OpenStreetMap data for the world.
 *
 * Primary source: the official OSM API (api.openstreetmap.org/api/0.6/map). It sends CORS headers,
 * so it works from the browser, unlike the public Overpass servers which often answer 406/429/5xx.
 * One big request around the start point is prefetched; chunks are then cut out of it in memory.
 * Overpass is only a fallback, and synthetic data is only a last resort (flagged `synthetic`).
 */

import { OVERPASS_ENDPOINTS, OSM_MAP_API } from '../config.js';
import { bboxToOverpass, getBoundingBox, latLngToMeters } from './GeoUtils.js';

const PRELOAD_TIMEOUT_MS = 25000;
const CHUNK_TIMEOUT_MS = 10000;
const OVERPASS_TIMEOUT_MS = 8000;
const MAX_SPLIT_DEPTH = 3;
/** Roads a car can actually be placed on / driven along */
export const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
  'unclassified', 'service', 'living_street', 'road',
]);

/** @type {{ bbox: object, roads: object[], buildings: object[], water: object[], greenery: object[] } | null} */
let regionalCache = null;
let lastOverpassTime = 0;
let overpassIndex = 0;

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

function computeBounds(geometry) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of geometry) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

/** Sort one way (OSM API) or element (Overpass) into the category the generators expect. */
function classify(element, out) {
  const tags = element.tags;
  const geom = element.geometry;
  if (!tags || !geom) return;

  if (tags.highway && geom.length >= 2) {
    out.roads.push(element);
  } else if (tags.building && geom.length >= 3) {
    out.buildings.push(element);
  } else if ((tags.natural === 'water' || tags.waterway) && geom.length >= 2) {
    out.water.push(element);
  } else if (
    (tags.landuse === 'forest' || tags.landuse === 'grass' ||
      tags.leisure === 'park' || tags.leisure === 'garden') && geom.length >= 3
  ) {
    out.greenery.push(element);
  }
}

/**
 * Parse OSM API XML. Regex based so it also runs in Node for tests.
 * @returns {{ roads: object[], buildings: object[], water: object[], greenery: object[] }}
 */
export function parseOsmXml(xml) {
  const nodes = new Map();
  const nodeRegex = /<node id="(\d+)"[^>]*?lat="([^"]+)"[^>]*?lon="([^"]+)"/g;
  let match;
  while ((match = nodeRegex.exec(xml)) !== null) {
    nodes.set(match[1], { lat: parseFloat(match[2]), lon: parseFloat(match[3]) });
  }

  const out = { roads: [], buildings: [], water: [], greenery: [] };
  const wayRegex = /<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g;
  while ((match = wayRegex.exec(xml)) !== null) {
    const body = match[2];

    const geometry = [];
    const ndRegex = /<nd ref="(\d+)"\s*\/>/g;
    let nd;
    while ((nd = ndRegex.exec(body)) !== null) {
      const node = nodes.get(nd[1]);
      if (node) geometry.push(node);
    }

    const tags = {};
    const tagRegex = /<tag k="([^"]*)" v="([^"]*)"\s*\/>/g;
    let tag;
    while ((tag = tagRegex.exec(body)) !== null) {
      tags[tag[1]] = tag[2];
    }

    classify({ id: match[1], geometry, tags }, out);
  }

  return out;
}

function merge(parts) {
  const seen = { roads: new Set(), buildings: new Set(), water: new Set(), greenery: new Set() };
  const out = { roads: [], buildings: [], water: [], greenery: [] };
  for (const part of parts) {
    for (const key of Object.keys(out)) {
      for (const el of part[key]) {
        if (seen[key].has(el.id)) continue;
        seen[key].add(el.id);
        out[key].push(el);
      }
    }
  }
  return out;
}

function withBounds(parsed) {
  for (const key of ['roads', 'buildings', 'water', 'greenery']) {
    for (const el of parsed[key]) {
      if (!el.bounds || el.bounds.minLat === undefined) el.bounds = computeBounds(el.geometry);
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------------

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one box from the OSM API. The API refuses boxes with more than 50,000 nodes (HTTP 400),
 * in which case the box is split in four and the results are merged.
 * @returns {Promise<object | null>} parsed data, or null when the service is unreachable
 */
async function fetchOsmBox(bbox, timeoutMs, depth = 0) {
  const url = `${OSM_MAP_API}?bbox=${bbox.west.toFixed(6)},${bbox.south.toFixed(6)},${bbox.east.toFixed(6)},${bbox.north.toFixed(6)}`;

  let response;
  try {
    response = await fetchWithTimeout(url, {}, timeoutMs);
  } catch (err) {
    console.warn('OSM API request failed:', err.message);
    return null;
  }

  if (response.ok) {
    return parseOsmXml(await response.text());
  }

  if (response.status === 400 && depth < MAX_SPLIT_DEPTH) {
    const midLat = (bbox.south + bbox.north) / 2;
    const midLng = (bbox.west + bbox.east) / 2;
    const quarters = [
      { south: bbox.south, north: midLat, west: bbox.west, east: midLng },
      { south: bbox.south, north: midLat, west: midLng, east: bbox.east },
      { south: midLat, north: bbox.north, west: bbox.west, east: midLng },
      { south: midLat, north: bbox.north, west: midLng, east: bbox.east },
    ];
    const results = await Promise.all(quarters.map((q) => fetchOsmBox(q, timeoutMs, depth + 1)));
    if (results.some((r) => r === null)) return null;
    return merge(results);
  }

  console.warn(`OSM API answered ${response.status}`);
  return null;
}

async function fetchOverpassBox(bbox) {
  const b = bboxToOverpass(bbox);
  const query = `[out:json][timeout:8];(way["highway"](${b});way["building"](${b});way["natural"="water"](${b});way["waterway"](${b});way["landuse"~"forest|grass"](${b});way["leisure"~"park|garden"](${b}););out geom;`;

  for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
    const index = (overpassIndex + attempt) % OVERPASS_ENDPOINTS.length;
    const wait = 1000 - (Date.now() - lastOverpassTime);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastOverpassTime = Date.now();

    try {
      const response = await fetchWithTimeout(OVERPASS_ENDPOINTS[index], {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, OVERPASS_TIMEOUT_MS);
      if (!response.ok) continue;

      const json = await response.json();
      overpassIndex = index;
      const out = { roads: [], buildings: [], water: [], greenery: [] };
      for (const el of json.elements || []) classify(el, out);
      return out;
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Selecting what belongs to a chunk
// ---------------------------------------------------------------------------------------------

const ROAD_MARGIN_DEG = 0.0001; // ~11 m so road ribbons are not cut at chunk borders

function intersects(b, bbox, margin = 0) {
  return !(
    b.maxLat < bbox.south - margin || b.minLat > bbox.north + margin ||
    b.maxLon < bbox.west - margin || b.minLon > bbox.east + margin
  );
}

/**
 * Pick the elements a chunk must draw.
 * - roads / water / greenery: everything touching the chunk (identical geometry, so overlap is harmless)
 * - buildings: only those whose centre is inside the chunk, so each building is built exactly once
 */
function selectForChunk(parsed, bbox) {
  const roads = parsed.roads.filter((el) => intersects(el.bounds, bbox, ROAD_MARGIN_DEG));
  const water = parsed.water.filter((el) => intersects(el.bounds, bbox));
  const greenery = parsed.greenery.filter((el) => intersects(el.bounds, bbox));
  const buildings = parsed.buildings.filter((el) => {
    const lat = (el.bounds.minLat + el.bounds.maxLat) / 2;
    const lon = (el.bounds.minLon + el.bounds.maxLon) / 2;
    return lat >= bbox.south && lat < bbox.north && lon >= bbox.west && lon < bbox.east;
  });
  return { roads, buildings, water, greenery };
}

function containsBox(outer, inner) {
  return inner.south >= outer.south && inner.north <= outer.north &&
    inner.west >= outer.west && inner.east <= outer.east;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Download a large area once (default radius 600 m) so chunks inside it are instant.
 * @returns {Promise<boolean>} true when the area is cached
 */
export async function preloadRegion(originLat, originLng, radiusMeters = 600) {
  const bbox = getBoundingBox(originLat, originLng, radiusMeters);
  const parsed = await fetchOsmBox(bbox, PRELOAD_TIMEOUT_MS);
  if (!parsed) {
    regionalCache = null;
    return false;
  }
  regionalCache = { bbox, ...withBounds(parsed) };
  return true;
}

export function clearRegion() {
  regionalCache = null;
}

/**
 * Data for one chunk.
 * @param {{ south: number, west: number, north: number, east: number }} bbox exact chunk box
 * @returns {Promise<{ roads: object[], buildings: object[], water: object[], greenery: object[], synthetic?: boolean }>}
 *   `synthetic: true` marks made-up data; callers must not cache it.
 */
export async function fetchChunkData(bbox) {
  // 1. Inside the prefetched area: cut it out of memory. Empty is a valid answer (sea, fields).
  if (regionalCache && containsBox(regionalCache.bbox, bbox)) {
    return selectForChunk(regionalCache, bbox);
  }

  // 2. Outside it: ask the OSM API for a slightly larger box, then select the same way.
  const pad = 0.0002;
  const padded = { south: bbox.south - pad, north: bbox.north + pad, west: bbox.west - pad, east: bbox.east + pad };
  const fromApi = await fetchOsmBox(padded, CHUNK_TIMEOUT_MS);
  if (fromApi) return selectForChunk(withBounds(fromApi), bbox);

  // 3. Overpass as a fallback
  const fromOverpass = await fetchOverpassBox(padded);
  if (fromOverpass) return selectForChunk(withBounds(fromOverpass), bbox);

  // 4. Offline: something to drive on, clearly flagged as fake
  console.warn('All map services unreachable — using synthetic chunk');
  return { ...generateProceduralFallback(bbox), synthetic: true };
}

/**
 * Closest drivable road to the origin and the heading along it.
 * @param {object[]} roads OSM-style ways ({ geometry: [{lat, lon}], tags })
 * @returns {{ x: number, z: number, heading: number, name: string } | null}
 *   heading is the yaw about +Y for a car whose nose points along +Z, so that
 *   the car's forward vector is (sin(heading), cos(heading)).
 */
export function findSpawnPoint(roads, originLat, originLng) {
  let best = null;
  let bestDist = Infinity;

  for (const road of roads) {
    if (!DRIVABLE.has(road.tags?.highway)) continue;

    for (let i = 0; i < road.geometry.length - 1; i++) {
      const a = latLngToMeters(road.geometry[i].lat, road.geometry[i].lon, originLat, originLng);
      const b = latLngToMeters(road.geometry[i + 1].lat, road.geometry[i + 1].lon, originLat, originLng);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      if (len2 < 25) continue; // skip segments shorter than 5 m

      // Closest point on the segment to the origin (0, 0)
      const t = Math.max(0, Math.min(1, -(a.x * dx + a.z * dz) / len2));
      const px = a.x + t * dx;
      const pz = a.z + t * dz;
      const dist = Math.hypot(px, pz);

      if (dist < bestDist) {
        bestDist = dist;
        best = { x: px, z: pz, heading: Math.atan2(dx, dz), name: road.tags.name || 'ถนน' };
      }
    }
  }

  return best;
}

/** Offline-only placeholder: a crossroads with a few blocks. Never cached. */
function generateProceduralFallback(bbox) {
  const { south, west, north, east } = bbox;
  const midLat = (south + north) / 2;
  const midLng = (west + east) / 2;
  const latSpan = north - south;
  const lngSpan = east - west;

  const roads = [
    { id: `syn-r1-${midLat}`, tags: { highway: 'primary' }, geometry: [{ lat: midLat, lon: west }, { lat: midLat, lon: east }] },
    { id: `syn-r2-${midLng}`, tags: { highway: 'secondary' }, geometry: [{ lat: south, lon: midLng }, { lat: north, lon: midLng }] },
  ];

  const buildings = [];
  const offsets = [[0.2, 0.2], [0.35, 0.2], [0.7, 0.7], [0.85, 0.7], [0.2, 0.7], [0.7, 0.2]];
  offsets.forEach(([oLat, oLng], i) => {
    const bLat = south + latSpan * oLat;
    const bLng = west + lngSpan * oLng;
    const sLat = latSpan * 0.1;
    const sLng = lngSpan * 0.1;
    buildings.push({
      id: i + 1,
      tags: { building: 'yes', 'building:levels': String(2 + (i % 4)) },
      geometry: [
        { lat: bLat, lon: bLng }, { lat: bLat + sLat, lon: bLng },
        { lat: bLat + sLat, lon: bLng + sLng }, { lat: bLat, lon: bLng + sLng }, { lat: bLat, lon: bLng },
      ],
    });
  });

  return withBounds({ roads, buildings, water: [], greenery: [] });
}
