/**
 * OvertureBuildings.js — building footprints OpenStreetMap does not have yet.
 *
 * In much of the world (Burapha University in Bangsaen, for one) OSM has the roads but almost no
 * buildings, while the street map shows them all. Overture Maps publishes open building data that
 * merges OSM with Google Open Buildings and Microsoft ML footprints, as PMTiles readable straight
 * from the browser. We take only the non-OSM footprints and drop any that overlap an OSM building.
 */

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { OVERTURE_CATALOG } from '../config.js';

const ZOOM = 14;             // the archive's most detailed zoom (~2.4 km tiles at the equator)
const TIMEOUT_MS = 12000;
const MAX_CACHED_TILES = 8;

let archive = null;          // Promise<PMTiles | null>
const tiles = new Map();     // "x/y" -> Promise<VectorTile layer | null>

const withTimeout = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('Overture timeout')), TIMEOUT_MS)),
]);

/** Old releases are deleted after a few months, so the current one is looked up in the catalog */
function getArchive() {
  archive ??= withTimeout(fetch(OVERTURE_CATALOG).then((r) => r.json()))
    .then((catalog) => {
      const release = typeof catalog.latest === 'string'
        ? catalog.latest
        : catalog.links?.find((l) => l.latest === true)?.href.match(/\/([^/]+)\/catalog\.json$/)?.[1];
      if (!release) throw new Error('no Overture release in catalog');
      return new PMTiles(`https://tiles.overturemaps.org/${release}/buildings.pmtiles`);
    })
    .catch((err) => {
      console.warn('Overture buildings unavailable:', err.message);
      archive = null; // try again for the next area
      return null;
    });
  return archive;
}

function tileXY(lat, lng) {
  const n = 2 ** ZOOM;
  const r = (lat * Math.PI) / 180;
  return [
    Math.floor(((lng + 180) / 360) * n),
    Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
  ];
}

function loadTile(pm, x, y) {
  const key = `${x}/${y}`;
  if (!tiles.has(key)) {
    const promise = withTimeout(pm.getZxy(ZOOM, x, y))
      .then((t) => (t ? new VectorTile(new PbfReader(new Uint8Array(t.data))).layers.building ?? null : null))
      .catch((err) => {
        tiles.delete(key); // a failed tile is retried next time
        console.warn('Overture tile failed:', err.message);
        return null;
      });
    tiles.set(key, promise);
    if (tiles.size > MAX_CACHED_TILES) tiles.delete(tiles.keys().next().value);
  }
  return tiles.get(key);
}

/**
 * Footprints inside a box that did not come from OSM, as OSM-style building elements.
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 * @returns {Promise<object[]>} empty when the service is unreachable
 */
export async function fetchOvertureBuildings(bbox) {
  const pm = await getArchive();
  if (!pm) return [];
  const [x0, y0] = tileXY(bbox.north, bbox.west);
  const [x1, y1] = tileXY(bbox.south, bbox.east);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(loadTile(pm, x, y).then((layer) => ({ x, y, layer })));

  const out = [];
  const seen = new Set();
  for (const { x, y, layer } of await Promise.all(jobs)) {
    for (let i = 0; i < (layer?.length ?? 0); i++) {
      const feature = layer.feature(i);
      const p = feature.properties;
      // shortcut: a building cut by a tile edge keeps only the piece from the first tile; edges are 2.4 km apart.
      if (p['@geometry_source'] === 'OpenStreetMap' || p.is_underground === true || seen.has(p.id)) continue;
      seen.add(p.id);
      const geo = feature.toGeoJSON(x, y, ZOOM).geometry;
      const polygons = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : [];
      polygons.forEach((poly, k) => {
        const ring = poly[0].map(([lon, lat]) => ({ lat, lon }));
        if (ring.length < 4) return;
        const c = centroid(ring);
        if (c.lat < bbox.south || c.lat >= bbox.north || c.lon < bbox.west || c.lon >= bbox.east) return;
        const tags = { building: typeof p.class === 'string' ? p.class : 'yes' };
        if (p.height > 0) tags.height = String(p.height);
        if (p.num_floors > 0) tags['building:levels'] = String(p.num_floors);
        out.push({ id: `ov_${p.id}_${k}`, tags, geometry: ring });
      });
    }
  }
  return out;
}

function centroid(ring) {
  let lat = 0, lon = 0;
  for (const p of ring) { lat += p.lat; lon += p.lon; }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

function inside(pt, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > pt.lat) !== (b.lat > pt.lat) && pt.lon < ((b.lon - a.lon) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lon) hit = !hit;
  }
  return hit;
}

function boundsOf(ring) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of ring) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  return { minLat, maxLat, minLon, maxLon };
}

const within = (pt, b) => pt.lat >= b.minLat && pt.lat <= b.maxLat && pt.lon >= b.minLon && pt.lon <= b.maxLon;

/**
 * Drop the extra footprints that sit on an OSM building (OSM was edited after the Overture
 * release, or the AI traced the same house), so nothing is built twice.
 * Grid-bucketed, since a city region has thousands of each.
 */
export function dropOverlapping(extra, osmBuildings) {
  const CELL = 0.002; // ~200 m
  const grid = new Map();
  const osm = osmBuildings.filter((b) => b.geometry?.length >= 3).map((b) => ({ ring: b.geometry, b: boundsOf(b.geometry), c: centroid(b.geometry) }));
  for (const o of osm) {
    for (let la = Math.floor(o.b.minLat / CELL); la <= Math.floor(o.b.maxLat / CELL); la++) {
      for (let lo = Math.floor(o.b.minLon / CELL); lo <= Math.floor(o.b.maxLon / CELL); lo++) {
        const k = `${la},${lo}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(o);
      }
    }
  }
  return extra.filter((e) => {
    const c = centroid(e.geometry);
    const b = boundsOf(e.geometry);
    const near = new Set();
    for (let la = Math.floor(b.minLat / CELL); la <= Math.floor(b.maxLat / CELL); la++) {
      for (let lo = Math.floor(b.minLon / CELL); lo <= Math.floor(b.maxLon / CELL); lo++) for (const o of grid.get(`${la},${lo}`) || []) near.add(o);
    }
    for (const o of near) {
      if ((within(c, o.b) && inside(c, o.ring)) || (within(o.c, b) && inside(o.c, e.geometry))) return false;
    }
    return true;
  });
}
