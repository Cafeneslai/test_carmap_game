/**
 * BuildingGenerator.js — Generate 3D buildings from OSM data
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { DEFAULT_BUILDING_HEIGHT, METERS_PER_FLOOR } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { getElevationAt } from './ElevationUtils.js';
import { facadeStyle, getFacadeMaterials, WALL_COLORS, ROOF_FLAT, GROUND_H, WALL_SINK } from './Facades.js';
import { landcoverType } from '../data/OSMFetcher.js';

/**
 * Generate the buildings of one chunk: walls with a facade picked by building type (ground-floor
 * band + upper floors), flat or pitched roofs, and one static collider body.
 *
 * @param {object[]} buildings - OSM way/relation elements with building tag
 * @param {number[][]} elevationData - Chunk elevation grid
 * @returns {THREE.Group | null} meshes are grouped per shared facade material
 */
export function generateBuildings(buildings, elevationData, chunkWorldX, chunkWorldZ, originLat, originLng, baseElevation = null, landcover = [], roads = []) {
  const group = new THREE.Group();
  const byMaterial = new Map(); // "plain" | "style:upper" | "style:ground" -> geometries
  const add = (key, geometry) => {
    if (!geometry) return;
    if (!byMaterial.has(key)) byMaterial.set(key, []);
    byMaterial.get(key).push(geometry);
  };
  // One static body per chunk, one box per building, so the car cannot drive through walls
  const body = new CANNON.Body({ mass: 0 });
  const tropical = Math.abs(originLat) < 25;
  // Land-use areas (campus, industrial estate, shopping street) in metres, smallest first
  const areas = (landcover || []).map((el) => {
    const pts = el.geometry.map((n) => {
      const { x, z } = latLngToMeters(n.lat, n.lon, originLat, originLng);
      return new THREE.Vector2(x, z);
    });
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y); }
    return { kind: landcoverType(el.tags || {}), pts, minX, maxX, minZ, maxZ, size: Math.abs(polygonArea(pts)) };
  }).filter((a) => a.kind && a.kind !== 'amenity=parking').sort((a, b) => a.size - b.size);
  // Main-street segments: a building within a few metres of one has a shop front
  const streets = [];
  for (const road of roads || []) {
    if (!SHOP_STREETS.has(road.tags?.highway)) continue;
    const pts = road.geometry.map((n) => latLngToMeters(n.lat, n.lon, originLat, originLng));
    for (let i = 0; i < pts.length - 1; i++) streets.push([pts[i], pts[i + 1]]);
  }
  const nearStreet = (ring) => streets.some(([a, b]) => {
    const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
    return ring.some((p) => {
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.z) * dz) / len2));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.z - t * dz) < 12; // half a road width + a sidewalk
    });
  });
  const landuseAt = (x, z) => areas.find((a) => x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ && insidePolygon(x, z, a.pts))?.kind ?? null;

  for (const building of buildings) {
    if (!building.geometry || building.geometry.length < 3) continue;
    const height = buildingHeight(building);

    const shapePoints = building.geometry.map((node) => {
      const { x, z } = latLngToMeters(node.lat, node.lon, originLat, originLng);
      return new THREE.Vector2(x, z);
    });
    const first = shapePoints[0];
    if (first.distanceTo(shapePoints[shapePoints.length - 1]) > 0.01) shapePoints.push(first.clone());
    if (shapePoints.length < 4) continue;
    // Courtyards (inner rings of a building multipolygon)
    const holes = (building.holes || []).map((ring) => {
      const pts = ring.map((node) => {
        const { x, z } = latLngToMeters(node.lat, node.lon, originLat, originLng);
        return new THREE.Vector2(x, z);
      });
      if (pts[0].distanceTo(pts[pts.length - 1]) > 0.01) pts.push(pts[0].clone());
      return pts;
    }).filter((pts) => pts.length >= 4);

    let avgX = 0, avgZ = 0;
    for (const p of shapePoints) { avgX += p.x; avgZ += p.y; }
    avgX /= shapePoints.length;
    avgZ /= shapePoints.length;
    // Walls follow the terrain at every corner; the floor is level with the highest corner (the
    // street side on a slope), so the shop fronts are never buried. One centre height buried them.
    const groundAt = (x, z) => getElevationAt(x - chunkWorldX, z - chunkWorldZ, elevationData, baseElevation);
    let floorY = -Infinity, lowest = Infinity;
    for (const p of shapePoints) {
      const y = groundAt(p.x, p.y);
      floorY = Math.max(floorY, y);
      lowest = Math.min(lowest, y);
    }
    addCollisionBox(body, shapePoints, lowest - WALL_SINK, floorY + height - (lowest - WALL_SINK), holes);

    const area = Math.abs(polygonArea(shapePoints));
    const rect = orientedRect(shapePoints);
    const ratio = rect ? Math.max(rect.halfU, rect.halfV) / Math.max(Math.min(rect.halfU, rect.halfV), 0.1) : 1;
    const style = facadeStyle(building.tags, { floors: height / METERS_PER_FLOOR, area, ratio, tropical, landuse: landuseAt(avgX, avgZ), onStreet: tropical && nearStreet(shapePoints) });
    const id = idNumber(building.id);
    const wall = tagColor(building.tags?.['building:colour']) ?? new THREE.Color(pick(WALL_COLORS[style], id));

    for (const [ring, inward] of [[shapePoints, false], ...holes.map((h) => [h, true])]) {
      // Start each building at a different bay of the 12 m pattern, so neighbours do not match
      const uStart = (id % Math.round(12 / BAY[style])) * BAY[style];
      const walls = wallBands(ring, floorY, height, BAY[style], wall, inward, groundAt, uStart);
      add(`${style}:ground`, walls.ground);
      add(`${style}:upper`, walls.upper);
    }

    const roof = holes.length ? null : pitchedRoof(building, shapePoints, floorY + height);
    if (roof) add('plain', roof);
    else {
      const roofColor = tagColor(building.tags?.['roof:colour']) ?? new THREE.Color(pick(ROOF_FLAT[style] ?? ROOF_FLAT.default, id >>> 3));
      add('plain', flatRoof(shapePoints, floorY + height, roofColor, holes));
    }
  }

  if (byMaterial.size === 0) return null;
  const materials = getFacadeMaterials();
  for (const [key, geometries] of byMaterial) {
    const merged = mergeGeometries(geometries);
    geometries.forEach((g) => g.dispose());
    if (!merged) continue;
    const [style, part] = key.split(':');
    const mesh = new THREE.Mesh(merged, key === 'plain' ? materials.plain : materials[style][part]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.sharedMaterial = true; // city-wide materials; Chunk.dispose frees only the geometry
    mesh.userData.facade = key;
    group.add(mesh);
  }
  if (body.shapes.length > 0) group.userData.body = body;
  return group;
}

const SHOP_STREETS = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'primary_link', 'secondary_link', 'tertiary_link']);

/** Metres between window bays per style: wall lengths are rounded to whole bays so no window is cut */
const BAY = { generic: 3, house: 6, shophouse: 4, apartment: 3, office: 1.5, industrial: 2, civic: 1.5 };
const pick = (list, n) => list[n % list.length];

/** OSM colour tag (name or hex) -> Color, or null when missing or unreadable */
export function tagColor(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) return new THREE.Color(`#${hex[1]}`);
  return THREE.Color.NAMES[v] !== undefined ? new THREE.Color(THREE.Color.NAMES[v]) : null;
}

/**
 * Wall quads for a footprint, split into the ground-floor band and the floors above.
 * The floor is level at floorY; each wall's bottom follows the terrain (groundAt) and reaches
 * WALL_SINK below it. uv is in metres: u along each wall (stretched to whole bays), v up the band,
 * with the ground band's v anchored at the floor so its shop fronts sit on the street.
 */
export function wallBands(points, floorY, height, bay, color, inward = false, groundAt = null, uStart = 0) {
  const n = points.length - 1;
  let area2 = 0;
  for (let i = 0; i < n; i++) area2 += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y;
  const bottomAt = (p) => Math.min(groundAt ? groundAt(p.x, p.y) : floorY, floorY) - WALL_SINK;
  const split = floorY + Math.min(GROUND_H, height);
  // [bottom y of a corner, top y, v at a given y]
  const bands = {
    ground: [bottomAt, () => split, (y) => WALL_SINK + (y - floorY)],
    upper: height > GROUND_H + 0.3 ? [() => split, () => floorY + height, (y) => y - split] : null,
  };
  const out = { ground: null, upper: null };
  for (const [name, band] of Object.entries(bands)) {
    if (!band) continue;
    const [lowAt, highAt, vAt] = band;
    const pos = [], nor = [], uv = [], col = [];
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      // Outward normal (x east, z south): which side is inside depends on the ring's direction
      // A courtyard ring faces into the courtyard, i.e. towards its own inside
      const s = (area2 > 0 ? 1 : -1) * (inward ? -1 : 1);
      const nx = (s * dz) / len, nz = (-s * dx) / len;
      const uLen = Math.max(1, Math.round(len / bay)) * bay;
      const u0 = uStart, u1 = uStart + uLen;
      const ya = lowAt(a), yb = lowAt(b), top = highAt();
      const A0 = [a.x, ya, a.y], B0 = [b.x, yb, b.y], B1 = [b.x, top, b.y], A1 = [a.x, top, a.y];
      const va0 = vAt(ya), vb0 = vAt(yb), v1 = vAt(top);
      // Wind the triangles so they face along the outward normal
      const ux = B0[0] - A0[0], uz = B0[2] - A0[2]; // along the wall; up is (0, 1, 0)
      const facing = -uz * nx + ux * nz; // (along x up) . normal
      const quad = facing > 0
        ? [[A0, u0, va0], [B0, u1, vb0], [B1, u1, v1], [A0, u0, va0], [B1, u1, v1], [A1, u0, v1]]
        : [[A0, u0, va0], [B1, u1, v1], [B0, u1, vb0], [A0, u0, va0], [A1, u0, v1], [B1, u1, v1]];
      for (const [p, u, v] of quad) {
        pos.push(p[0], p[1], p[2]); nor.push(nx, 0, nz); uv.push(u, v); col.push(color.r, color.g, color.b);
      }
    }
    if (pos.length === 0) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    out[name] = g;
  }
  return out;
}

function insidePolygon(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > z) !== (b.y > z) && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Flat roof cap facing up */
function flatRoof(points, topY, color, holes = []) {
  try {
    // rotateX(-PI/2) maps shape-Y to world -Z, so feed -Z to land on the right side
    const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, -p.y)));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, -p.y))));
    const g = new THREE.ShapeGeometry(shape).toNonIndexed();
    g.rotateX(-Math.PI / 2);
    g.translate(0, topY, 0);
    const count = g.attributes.position.count;
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) col.set([color.r, color.g, color.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  } catch {
    return null;
  }
}

/**
 * Height from OSM tags; untagged buildings get 2-5 floors picked from their id, so a block of
 * untagged buildings is not one flat slab (deterministic, the same on every visit).
 */
export function buildingHeight(building) {
  const tags = building.tags || {};
  const h = parseFloat(tags.height);
  if (h > 0) return h;
  const levels = parseInt(tags['building:levels']);
  if (levels > 0) return levels * METERS_PER_FLOOR;
  if (tags.building === 'house' || tags.building === 'detached' || tags.building === 'garage' || tags.building === 'shed') {
    return tags.building === 'garage' || tags.building === 'shed' ? METERS_PER_FLOOR : 2 * METERS_PER_FLOOR;
  }
  const id = idNumber(building.id);
  return (2 + ((id * 7919) % 4)) * METERS_PER_FLOOR || DEFAULT_BUILDING_HEIGHT;
}

/**
 * A stable number from a building id, for picking colours and guessed heights. OSM ids are numbers;
 * Overture ids ("ov_1972641f-...") are hashed, before they all came out NaN -> 0: same colour, 2 floors.
 */
export function idNumber(id) {
  const n = Number(id);
  if (Number.isFinite(n)) return Math.abs(n);
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const COLLIDER_CELL = 2; // metres; strips this wide follow the outline of L/U/odd-shaped buildings

/**
 * Collision boxes for a footprint, aligned with its longest wall.
 * A near-rectangle gets one box. Other shapes (L, U, courtyards) are cut into 2 m strips across the
 * long axis; each run of strip cells inside the footprint becomes one box, so a courtyard or the
 * inside corner of an L stays open instead of being one big box over a road or yard.
 * @param {THREE.Vector2[]} points footprint in world x / z
 */
function addCollisionBox(body, points, bottomY, height, holes = []) {
  const r = orientedRect(points);
  if (!r || r.halfU < 0.25 || r.halfV < 0.25) return;
  const q = new CANNON.Quaternion();
  // Rotating local +X about +Y by a gives (cos a, 0, -sin a); we want (ux, 0, uz)
  q.setFromEuler(0, Math.atan2(-r.uz, r.ux), 0);
  const y = bottomY + height / 2;
  const vx = -r.uz, vz = r.ux;
  const add = (cu, cv, hu, hv) => body.addShape(
    new CANNON.Box(new CANNON.Vec3(hu, height / 2, hv)),
    new CANNON.Vec3(r.cx + r.ux * cu + vx * cv, y, r.cz + r.uz * cu + vz * cv),
    q,
  );

  if (!holes.length && Math.abs(polygonArea(points)) >= 0.9 * 4 * r.halfU * r.halfV) {
    add(0, 0, r.halfU, r.halfV);
    return;
  }

  // Footprint in (u, v) around the rectangle centre, for point-in-polygon tests
  const toLocal = (ring) => ring.map((p) => {
    const dx = p.x - r.cx, dz = p.y - r.cz;
    return { u: dx * r.ux + dz * r.uz, v: dx * vx + dz * vz };
  });
  const local = toLocal(points);
  const localHoles = holes.map(toLocal); // courtyards stay open
  // Capped so a huge irregular building (a stadium, a mall) stays at most ~40 strips
  const nu = Math.min(40, Math.max(1, Math.round((2 * r.halfU) / COLLIDER_CELL)));
  const nv = Math.min(40, Math.max(1, Math.round((2 * r.halfV) / COLLIDER_CELL)));
  const du = (2 * r.halfU) / nu, dv = (2 * r.halfV) / nv;
  for (let i = 0; i < nu; i++) {
    const u = -r.halfU + (i + 0.5) * du;
    let runStart = -1;
    for (let j = 0; j <= nv; j++) {
      const vj = -r.halfV + (j + 0.5) * dv;
      const inside = j < nv && insideLocal(local, u, vj) && !localHoles.some((h) => insideLocal(h, u, vj));
      if (inside && runStart < 0) runStart = j;
      if (!inside && runStart >= 0) {
        const v0 = -r.halfV + runStart * dv, v1 = -r.halfV + j * dv;
        add(u, (v0 + v1) / 2, du / 2, (v1 - v0) / 2);
        runStart = -1;
      }
    }
  }
}

function insideLocal(poly, u, v) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.v > v) !== (b.v > v) && u < ((b.u - a.u) * (v - a.v)) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

/**
 * Smallest box around the footprint aligned with its longest wall.
 * @param {THREE.Vector2[]} points footprint in world x / z (vector .y holds z)
 * @returns {{ ux: number, uz: number, cx: number, cz: number, halfU: number, halfV: number } | null}
 *   u = along the longest wall, v = across it
 */
function orientedRect(points) {
  let bestLen = 0, ux = 1, uz = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dz = points[i + 1].y - points[i].y;
    const len = Math.hypot(dx, dz);
    if (len > bestLen) { bestLen = len; ux = dx / len; uz = dz / len; }
  }
  if (bestLen < 0.5) return null;

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of points) {
    const u = p.x * ux + p.y * uz;
    const v = -p.x * uz + p.y * ux;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  return { ux, uz, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, halfU: (maxU - minU) / 2, halfV: (maxV - minV) / 2 };
}

const PITCHED_TYPES = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'farm', 'cabin', 'hut']);
const ROOF_COLORS = [[0.55, 0.22, 0.16], [0.42, 0.24, 0.2], [0.32, 0.33, 0.36], [0.5, 0.3, 0.18]];

/**
 * Gable roof for small, roughly rectangular houses; the ridge runs along the longest wall.
 * @returns {THREE.BufferGeometry | null}
 */
export function pitchedRoof(building, points, topY) {
  const tags = building.tags || {};
  const shape = tags['roof:shape'];
  if (shape === 'flat') return null;
  if (!PITCHED_TYPES.has(tags.building) && shape !== 'gabled' && shape !== 'hipped') return null;

  const r = orientedRect(points);
  if (!r || r.halfV < 1) return null;
  const rectArea = 4 * r.halfU * r.halfV;
  if (rectArea > 400 || Math.abs(polygonArea(points)) < 0.8 * rectArea) return null; // not house-like

  const rise = Math.min(r.halfV * 0.8, 3.5);
  const vx = -r.uz, vz = r.ux; // across the ridge
  const at = (u, v, y) => new THREE.Vector3(r.cx + r.ux * u + vx * v, y, r.cz + r.uz * u + vz * v);
  const { halfU: hu, halfV: hv } = r;
  const c00 = at(-hu, -hv, topY), c10 = at(hu, -hv, topY), c11 = at(hu, hv, topY), c01 = at(-hu, hv, topY);
  const r0 = at(-hu, 0, topY + rise), r1 = at(hu, 0, topY + rise);
  const mid = new THREE.Vector3(r.cx, topY, r.cz);

  const pos = [];
  // Wind every triangle so it faces away from the house centre (outwards / upwards)
  const tri = (a, b, c) => {
    const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    const out = a.clone().add(b).add(c).divideScalar(3).sub(mid);
    if (n.dot(out) < 0) [b, c] = [c, b];
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  tri(c00, c10, r1); tri(c00, r1, r0);   // slope on the -v side
  tri(c01, r0, r1); tri(c01, r1, c11);   // slope on the +v side
  tri(c00, r0, c01); tri(c10, c11, r1);  // gable ends

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.computeVertexNormals();
  const tagged = tagColor(tags['roof:colour']);
  const [cr, cg, cb] = tagged ? [tagged.r, tagged.g, tagged.b] : ROOF_COLORS[idNumber(building.id) % ROOF_COLORS.length];
  const count = pos.length / 3;
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Array(count).fill([cr, cg, cb]).flat(), 3));
  return geometry;
}

function polygonArea(points) {
  let a = 0;
  for (let i = 0; i < points.length - 1; i++) a += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y;
  return a / 2;
}

/**
 * Merge buffer geometries
 */
function mergeGeometries(geometries) {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0].clone();

  let totalVerts = 0;
  let totalIndices = 0;

  for (const g of geometries) {
    totalVerts += g.attributes.position.count;
    if (g.index) totalIndices += g.index.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;

  for (const g of geometries) {
    const pc = g.attributes.position.count;

    // Positions
    positions.set(g.attributes.position.array, vOffset * 3);

    // Normals
    if (g.attributes.normal) {
      normals.set(g.attributes.normal.array, vOffset * 3);
    }

    // Colors
    if (g.attributes.color) {
      colors.set(g.attributes.color.array, vOffset * 3);
    }

    if (g.attributes.uv) {
      uvs.set(g.attributes.uv.array, vOffset * 2);
    }

    // Indices
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        indices[iOffset + i] = g.index.array[i] + vOffset;
      }
      iOffset += g.index.count;
    }

    vOffset += pc;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (totalIndices > 0) {
    merged.setIndex(new THREE.BufferAttribute(indices, 1));
  }

  return merged;
}
