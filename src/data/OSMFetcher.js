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
import { fetchOvertureBuildings, dropOverlapping } from './OvertureBuildings.js';

const PRELOAD_TIMEOUT_MS = 25000;
const CHUNK_TIMEOUT_MS = 10000;
const OVERPASS_TIMEOUT_MS = 8000;
const MAX_SPLIT_DEPTH = 3;
/** Roads a car can actually be placed on / driven along */
/** OSM man_made values built as towers (src/world/Towers.js) */
export const TOWER_KINDS = new Set(['tower', 'mast', 'communications_tower', 'chimney', 'water_tower']);

export const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
  'unclassified', 'service', 'living_street', 'road',
]);

/**
 * Downloaded areas, newest last. A chunk inside any of them is cut out of memory with no request.
 * @type {{ bbox: object, roads: object[], buildings: object[], water: object[], greenery: object[] }[]}
 */
let regions = [];
/** Region downloads in flight, so chunks that need the same area wait for one request */
let pendingRegions = [];
const MAX_REGIONS = 6;
const REGION_RADIUS_M = 600;
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

const LANDCOVER_KEYS = {
  landuse: new Set(['residential', 'commercial', 'retail', 'industrial', 'farmland', 'farmyard', 'meadow', 'grass',
    'forest', 'orchard', 'vineyard', 'cemetery', 'construction', 'brownfield', 'railway', 'military', 'recreation_ground',
    'village_green', 'allotments', 'aquaculture', 'salt_pond', 'plant_nursery', 'greenfield', 'religious']),
  natural: new Set(['wood', 'scrub', 'grassland', 'heath', 'beach', 'sand', 'bare_rock', 'scree', 'wetland', 'mud']),
  leisure: new Set(['park', 'garden', 'pitch', 'golf_course', 'playground', 'sports_centre', 'stadium', 'track']),
  amenity: new Set(['parking', 'school', 'university', 'hospital', 'college']),
};

/**
 * The ground-cover kind of an area, e.g. "landuse=farmland", or null when it has none we paint.
 */
export function landcoverType(tags) {
  for (const [key, values] of Object.entries(LANDCOVER_KEYS)) {
    if (values.has(tags[key])) return `${key}=${tags[key]}`;
  }
  return null;
}

const samePoint = (a, b) => a.lat === b.lat && a.lon === b.lon;

/**
 * Join way pieces end to end into closed rings (a big forest's outline is often 20+ ways).
 * Pieces that never close up are dropped.
 * @param {({lat: number, lon: number}[] | null)[]} pieces
 */
export function joinRings(pieces) {
  const left = pieces.filter((p) => p && p.length >= 2);
  const rings = [];
  while (left.length) {
    let ring = left.pop();
    let grown = true;
    while (grown && !samePoint(ring[0], ring.at(-1))) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        if (samePoint(p[0], ring.at(-1))) ring = ring.concat(p.slice(1));
        else if (samePoint(p.at(-1), ring.at(-1))) ring = ring.concat(p.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4 && samePoint(ring[0], ring.at(-1))) rings.push(ring);
  }
  return rings;
}

function insideRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > pt.lat) !== (b.lat > pt.lat) && pt.lon < ((b.lon - a.lon) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}

/**
 * A multipolygon relation (big forest, lake with islands, park in several pieces) becomes one area
 * per outer ring, tagged like the relation, with the inner rings inside it as `holes`.
 * @param {{ id: string, tags: object, members: { role: string, geometry: object[] | null }[] }} rel
 * @returns {boolean} false when member ways are missing from the download (the outline may not close)
 */
function classifyRelation(rel, out) {
  const tags = rel.tags || {};
  // Road areas are not drawn; buildings with courtyards are (walls inside the courtyard too)
  if (tags.type !== 'multipolygon' || tags.highway) return true;
  if (!landcoverType(tags) && tags.natural !== 'water' && !tags.waterway && !tags.building) return true;
  const outers = joinRings(rel.members.filter((m) => m.role !== 'inner').map((m) => m.geometry));
  const inners = joinRings(rel.members.filter((m) => m.role === 'inner').map((m) => m.geometry));
  outers.forEach((ring, i) => {
    const holes = inners.filter((h) => insideRing(h[0], ring));
    classify({ id: `r${rel.id}_${i}`, relation: String(rel.id), tags, geometry: ring, holes }, out);
  });
  return rel.members.every((m) => m.geometry);
}

/** Sort one way (OSM API) or element (Overpass) into the category the generators expect. */
function classify(element, out) {
  const tags = element.tags;
  // Towers, masts, chimneys: a point with the size of their outline (0 for a node)
  if (TOWER_KINDS.has(tags?.man_made)) {
    const g = element.type === 'node' ? [element] : element.geometry;
    if (g?.length) {
      const b = computeBounds(g);
      const size = latLngToMeters(b.maxLat, b.maxLon, b.minLat, b.minLon);
      out.towers.push({ id: `t${element.id}`, lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2, width: Math.min(Math.abs(size.x), Math.abs(size.z)), tags: { man_made: tags.man_made, height: tags.height, 'tower:type': tags['tower:type'], 'tower:construction': tags['tower:construction'], location: tags.location } });
    }
  }
  if (element.type === 'node') {
    if (tags?.highway === 'traffic_signals') out.signals.push({ id: element.id, lat: element.lat, lon: element.lon });
    if (tags?.natural === 'tree') out.trees.push({ id: element.id, lat: element.lat, lon: element.lon, tags: { genus: tags.genus, species: tags.species, leaf_type: tags.leaf_type, height: tags.height } });
    return;
  }
  const geom = element.geometry;
  if (!tags || !geom) return;

  // A row of street trees: one tree every 9 m along the line
  if (tags.natural === 'tree_row' && geom.length >= 2) {
    for (let i = 0; i < geom.length - 1; i++) {
      const a = geom[i], b = geom[i + 1];
      const len = latLngToMeters(b.lat, b.lon, a.lat, a.lon);
      const n = Math.max(1, Math.round(Math.hypot(len.x, len.z) / 9));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        out.trees.push({ id: `${element.id}_${i}_${k}`, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, tags: {} });
      }
    }
    return;
  }

  // What covers the ground (fields, beach, parking...) is painted onto the terrain; it is an extra
  // category, so a forest is both painted and planted with trees
  if (geom.length >= 3 && landcoverType(tags)) out.landcover.push(element);

  if (tags.highway && geom.length >= 2) {
    out.roads.push(element);
  } else if (tags.building && geom.length >= 3) {
    out.buildings.push(element);
  } else if ((tags.natural === 'water' || tags.waterway) && geom.length >= 2) {
    out.water.push(element);
  } else if (
    (tags.landuse === 'forest' || tags.landuse === 'grass' || tags.natural === 'wood' ||
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

  const out = emptyParsed();

  // Traffic lights are tagged nodes: <node id lat lon ...> <tag k="highway" v="traffic_signals"/> </node>
  // ([^>]*[^/]> skips self-closing <node .../> so a match never runs on into the next node)
  const taggedNodeRegex = /<node id="(\d+)"([^>]*[^/])>([\s\S]*?)<\/node>/g;
  while ((match = taggedNodeRegex.exec(xml)) !== null) {
    const signal = /<tag k="highway" v="traffic_signals"\s*\/>/.test(match[3]);
    const tree = /<tag k="natural" v="tree"\s*\/>/.test(match[3]);
    const manMade = /<tag k="man_made" v="([^"]*)"\s*\/>/.exec(match[3]);
    if (manMade && TOWER_KINDS.has(manMade[1])) {
      const tags = {};
      for (const [, k, val] of match[3].matchAll(/<tag k="([^"]*)" v="([^"]*)"\s*\/>/g)) tags[k] = val;
      const la = /lat="([^"]+)"/.exec(match[2]), lo = /lon="([^"]+)"/.exec(match[2]);
      if (la && lo) classify({ type: 'node', id: match[1], lat: parseFloat(la[1]), lon: parseFloat(lo[1]), tags }, out);
    }
    if (!signal && !tree) continue;
    const lat = /lat="([^"]+)"/.exec(match[2]);
    const lon = /lon="([^"]+)"/.exec(match[2]);
    if (!lat || !lon) continue;
    const point = { id: match[1], lat: parseFloat(lat[1]), lon: parseFloat(lon[1]) };
    if (signal) out.signals.push(point);
    if (tree) {
      // Street/garden tree: keep what says which species it is and how tall
      const tags = {};
      for (const [, k, v] of match[3].matchAll(/<tag k="(genus|species|taxon|leaf_type|height)" v="([^"]*)"\s*\/>/g)) tags[k] = v;
      out.trees.push({ ...point, tags });
    }
  }

  const wayGeometry = new Map(); // every way, tagged or not: relation outlines are mostly untagged ways
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

    wayGeometry.set(match[1], geometry);
    classify({ id: match[1], geometry, tags }, out);
  }

  const relationRegex = /<relation id="(\d+)"[^>]*>([\s\S]*?)<\/relation>/g;
  while ((match = relationRegex.exec(xml)) !== null) {
    const body = match[2];
    const members = [];
    const memberRegex = /<member type="way" ref="(\d+)" role="([^"]*)"\s*\/>/g;
    let m;
    while ((m = memberRegex.exec(body)) !== null) {
      // The map API only sends the member ways that touch the box; the others are missing
      members.push({ role: m[2], geometry: wayGeometry.get(m[1]) ?? null });
    }
    const tags = {};
    const tagRegex = /<tag k="([^"]*)" v="([^"]*)"\s*\/>/g;
    let tag;
    while ((tag = tagRegex.exec(body)) !== null) tags[tag[1]] = tag[2];
    if (!classifyRelation({ id: match[1], tags, members }, out)) out.partial.push({ id: match[1], members: members.length });
  }

  return out;
}

function emptyParsed() {
  return { roads: [], buildings: [], water: [], greenery: [], signals: [], landcover: [], trees: [], towers: [], partial: [] };
}

function merge(parts) {
  const out = emptyParsed();
  const seen = Object.fromEntries(Object.keys(out).map((k) => [k, new Set()]));
  for (const part of parts) {
    for (const key of Object.keys(out)) {
      for (const el of part[key] || []) {
        if (seen[key].has(el.id)) continue;
        seen[key].add(el.id);
        out[key].push(el);
      }
    }
  }
  return out;
}

/** Is p inside ring (x/z points)? */
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/**
 * Sets road.overWater on bridges that cross a lake/river area or a river line. Done on the whole
 * downloaded area so every chunk a bridge passes through agrees, even those without the water.
 */
export function markWaterBridges(parsed) {
  for (const road of parsed.roads) {
    if (!road.tags?.bridge || road.tags.bridge === 'no' || road.overWater !== undefined || !road.geometry?.length) continue;
    const o = road.geometry[0];
    const m = (n) => latLngToMeters(n.lat, n.lon, o.lat, o.lon);
    const samples = [];
    road.geometry.forEach((n, i) => {
      if (i === 0) return samples.push(m(n));
      const a = m(road.geometry[i - 1]), b = m(n);
      const k = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 3);
      for (let j = 1; j <= k; j++) samples.push({ x: a.x + ((b.x - a.x) * j) / k, z: a.z + ((b.z - a.z) * j) / k });
    });
    const b = computeBounds(road.geometry);
    road.overWater = parsed.water.some((w) => {
      if (!w.geometry || (w.bounds && !intersects(w.bounds, { south: b.minLat, north: b.maxLat, west: b.minLon, east: b.maxLon }, 0.0002))) return false;
      const pts = w.geometry.map(m);
      const line = !!w.tags?.waterway && w.tags.natural !== 'water' && w.tags.waterway !== 'riverbank';
      if (!line) return pts.length >= 3 && samples.some((p) => inRing(p, pts));
      const reach = w.tags.waterway === 'river' || w.tags.waterway === 'canal' ? 8 : 3;
      return samples.some((p) => pts.some((a, i) => i > 0 && distToSegment(p, pts[i - 1], a) < reach));
    });
  }
  // A long viaduct is several bridge ways in a row: only its outer ends ramp down to the ground
  const key = (n) => `${n.lat.toFixed(7)},${n.lon.toFixed(7)}`;
  const ends = new Map();
  for (const r of parsed.roads) if (r.overWater) for (const n of [r.geometry[0], r.geometry.at(-1)]) ends.set(key(n), (ends.get(key(n)) || 0) + 1);
  for (const r of parsed.roads) if (r.overWater) r.bridgeJoined = [r.geometry[0], r.geometry.at(-1)].map((n) => ends.get(key(n)) > 1);
}

function withBounds(parsed) {
  for (const key of ['roads', 'buildings', 'water', 'greenery', 'landcover']) {
    for (const el of parsed[key]) {
      if (!el.bounds || el.bounds.minLat === undefined) el.bounds = computeBounds(el.geometry);
    }
  }
  markWaterBridges(parsed);
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
    const parsed = parseOsmXml(await response.text());
    return depth === 0 ? completeRelations(parsed) : parsed;
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
    const merged = merge(results);
    return depth === 0 ? completeRelations(merged) : merged;
  }

  console.warn(`OSM API answered ${response.status}`);
  return null;
}

const RELATION_API = OSM_MAP_API.replace(/map$/, 'relation');
const MAX_RELATION_FETCHES = 12;
const MAX_RELATION_MEMBERS = 400; // bigger ones (national forests) would be megabytes per cached chunk

/**
 * Relations reaching outside the box arrive with only their nearby ways, so the outline never closes.
 * Fetch each of them whole (/relation/{id}/full) and swap it in.
 */
// shortcut: relations over MAX_RELATION_MEMBERS stay incomplete; clip them server-side if big ones matter.
async function completeRelations(parsed) {
  const todo = parsed.partial.filter((r) => r.members <= MAX_RELATION_MEMBERS).slice(0, MAX_RELATION_FETCHES);
  if (todo.length === 0) return parsed;
  const fulls = await Promise.all(todo.map(async (r) => {
    try {
      const response = await fetchWithTimeout(`${RELATION_API}/${r.id}/full`, {}, CHUNK_TIMEOUT_MS);
      return response.ok ? parseOsmXml(await response.text()) : null;
    } catch {
      return null; // keep whatever rings did close
    }
  }));
  const done = new Set(todo.filter((_, i) => fulls[i]).map((r) => r.id));
  for (const key of ['water', 'greenery', 'landcover']) parsed[key] = parsed[key].filter((el) => !done.has(el.relation));
  parsed.partial = parsed.partial.filter((r) => !done.has(r.id));
  // Member ways that are tagged for themselves come along too; merge drops the ones already there
  return merge([parsed, ...fulls.filter(Boolean).map((f) => ({ ...f, partial: [] }))]);
}

async function fetchOverpassBox(bbox) {
  const b = bboxToOverpass(bbox);
  const query = `[out:json][timeout:8];(way["highway"](${b});way["building"](${b});way["natural"="water"](${b});way["waterway"](${b});way["landuse"~"forest|grass"](${b});way["leisure"~"park|garden"](${b});node["highway"="traffic_signals"](${b});node["natural"="tree"](${b});way["natural"="tree_row"](${b});nwr["man_made"~"^(tower|mast|communications_tower|chimney|water_tower)$"](${b});way["landuse"](${b});way["natural"~"wood|scrub|grassland|heath|beach|sand|bare_rock|scree|wetland|mud"](${b});way["leisure"~"pitch|golf_course|playground|sports_centre|stadium|track"](${b});way["amenity"~"parking|school|university|hospital|college"](${b});rel["type"="multipolygon"]["natural"~"water|wood|scrub|grassland|heath|beach|sand|wetland"](${b});rel["type"="multipolygon"]["landuse"](${b});rel["type"="multipolygon"]["leisure"~"park|garden|golf_course"](${b});rel["type"="multipolygon"]["building"](${b}););out geom;`;

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
      const out = emptyParsed();
      for (const el of json.elements || []) {
        if (el.type !== 'relation') classify(el, out);
        // `out geom` gives every member way its whole geometry, so these outlines close
        else classifyRelation({ id: el.id, tags: el.tags, members: (el.members || []).filter((m) => m.type === 'way').map((m) => ({ role: m.role, geometry: m.geometry?.length >= 2 ? m.geometry : null })) }, out);
      }
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
  const landcover = (parsed.landcover || []).filter((el) => intersects(el.bounds, bbox));
  const buildings = parsed.buildings.filter((el) => {
    const lat = (el.bounds.minLat + el.bounds.maxLat) / 2;
    const lon = (el.bounds.minLon + el.bounds.maxLon) / 2;
    return lat >= bbox.south && lat < bbox.north && lon >= bbox.west && lon < bbox.east;
  });
  // Points (signals, single trees) belong to exactly one chunk
  const inChunk = (n) => n.lat >= bbox.south && n.lat < bbox.north && n.lon >= bbox.west && n.lon < bbox.east;
  const signals = (parsed.signals || []).filter(inChunk);
  const trees = (parsed.trees || []).filter(inChunk);
  const towers = (parsed.towers || []).filter(inChunk);
  return { roads, buildings, water, greenery, signals, landcover, trees, towers };
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
export async function preloadRegion(originLat, originLng, radiusMeters = REGION_RADIUS_M) {
  const bbox = getBoundingBox(originLat, originLng, radiusMeters);
  const parsed = await fetchRegionBox(bbox);
  if (!parsed) return false;
  addRegion({ bbox, ...withBounds(parsed) });
  return true;
}

/** OSM for an area, plus the Overture footprints of buildings OSM is missing (downloaded side by side) */
async function fetchRegionBox(bbox) {
  const [parsed, extra] = await Promise.all([
    fetchOsmBox(bbox, PRELOAD_TIMEOUT_MS),
    fetchOvertureBuildings(bbox).catch(() => []),
  ]);
  if (parsed && extra.length) parsed.buildings.push(...dropOverlapping(extra, parsed.buildings));
  return parsed;
}

function addRegion(region) {
  regions.push(region);
  if (regions.length > MAX_REGIONS) regions.shift(); // forget the oldest area; chunks are cached in IndexedDB anyway
}

/**
 * Download the 1.2 km area around a chunk once, instead of one request per 200 m chunk.
 * Chunks that need the same area while it downloads share the request.
 * @returns {Promise<object | null>} the region, or null when the download failed
 */
// shortcut: a failed area is retried by the next chunk that needs it; remember failures if the API is often down.
function regionFor(bbox) {
  const pending = pendingRegions.find((p) => containsBox(p.bbox, bbox));
  if (pending) return pending.promise;

  const lat = (bbox.south + bbox.north) / 2;
  const lng = (bbox.west + bbox.east) / 2;
  const regionBox = getBoundingBox(lat, lng, REGION_RADIUS_M);
  const entry = { bbox: regionBox, promise: null };
  entry.promise = fetchRegionBox(regionBox)
    .then((parsed) => {
      if (!parsed) return null;
      const region = { bbox: regionBox, ...withBounds(parsed) };
      addRegion(region);
      return region;
    })
    .finally(() => {
      pendingRegions = pendingRegions.filter((p) => p !== entry);
    });
  pendingRegions.push(entry);
  return entry.promise;
}

export function clearRegion() {
  regions = [];
  pendingRegions = [];
}

/**
 * Data for one chunk.
 * @param {{ south: number, west: number, north: number, east: number }} bbox exact chunk box
 * @returns {Promise<{ roads: object[], buildings: object[], water: object[], greenery: object[], synthetic?: boolean }>}
 *   `synthetic: true` marks made-up data; callers must not cache it.
 */
export async function fetchChunkData(bbox) {
  // 1. Inside a downloaded area: cut it out of memory. Empty is a valid answer (sea, fields).
  const known = regions.find((r) => containsBox(r.bbox, bbox));
  if (known) return selectForChunk(known, bbox);

  // 2. Download the whole area around this chunk once; its neighbours will be instant
  const region = await regionFor(bbox);
  if (region) return selectForChunk(region, bbox);

  // 3. That failed (too dense, timeout): ask the OSM API for just this chunk, then select the same way.
  const pad = 0.0002;
  const padded = { south: bbox.south - pad, north: bbox.north + pad, west: bbox.west - pad, east: bbox.east + pad };
  const fromApi = await fetchOsmBox(padded, CHUNK_TIMEOUT_MS);
  if (fromApi) return selectForChunk(withBounds(fromApi), bbox);

  // 4. Overpass as a fallback
  const fromOverpass = await fetchOverpassBox(padded);
  if (fromOverpass) return selectForChunk(withBounds(fromOverpass), bbox);

  // 5. Offline: something to drive on, clearly flagged as fake
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

  return withBounds({ ...emptyParsed(), roads, buildings });
}
