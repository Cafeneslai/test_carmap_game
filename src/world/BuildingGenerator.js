/**
 * BuildingGenerator.js — Generate 3D buildings from OSM data
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { DEFAULT_BUILDING_HEIGHT, METERS_PER_FLOOR, BUILDING_COLORS } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { getElevationAt } from './ElevationUtils.js';
import { getWindowTextures, registerBuildingMaterial } from './NightLights.js';

/** Roof/floor UV in metres that lands on the plain wall margin of the window texture */
const PLAIN_UV = 0.3;

/**
 * Generate merged building mesh from OSM building elements
 * 
 * @param {object[]} buildings - OSM way/relation elements with building tag
 * @param {number[][]} elevationData - Chunk elevation grid
 * @param {number} chunkWorldX
 * @param {number} chunkWorldZ
 * @param {number} originLat
 * @param {number} originLng
 * @returns {THREE.Group | null}
 */
export function generateBuildings(buildings, elevationData, chunkWorldX, chunkWorldZ, originLat, originLng, baseElevation = null) {
  const group = new THREE.Group();
  const geometries = [];
  const colorArrays = [];
  // One static body per chunk, one box per building, so the car cannot drive through walls
  const body = new CANNON.Body({ mass: 0 });

  for (const building of buildings) {
    if (!building.geometry || building.geometry.length < 3) continue;

    // Calculate height
    const height = buildingHeight(building);

    // Convert coordinates to local positions
    const shapePoints = [];
    for (const node of building.geometry) {
      const { x, z } = latLngToMeters(node.lat, node.lon, originLat, originLng);
      shapePoints.push(new THREE.Vector2(x, z));
    }

    // Ensure the polygon is closed
    if (shapePoints.length >= 3) {
      const first = shapePoints[0];
      const last = shapePoints[shapePoints.length - 1];
      if (first.distanceTo(last) > 0.01) {
        shapePoints.push(first.clone());
      }
    }

    // Create Three.js Shape
    try {
      const shape = new THREE.Shape();
      // rotateX(-PI/2) below maps shape-Y to world -Z, so feed -Z to land on the right side
      shape.moveTo(shapePoints[0].x, -shapePoints[0].y);
      for (let i = 1; i < shapePoints.length; i++) {
        shape.lineTo(shapePoints[i].x, -shapePoints[i].y);
      }

      // Extrude
      const extrudeSettings = {
        steps: 1,
        depth: height,
        bevelEnabled: false,
      };

      const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);

      // Rotate to make extrusion go up (Y axis)
      geometry.rotateX(-Math.PI / 2);

      // Calculate average local X, Z for elevation sampling
      let avgX = 0, avgZ = 0;
      for (const p of shapePoints) {
        avgX += p.x;
        avgZ += p.y;
      }
      avgX /= shapePoints.length;
      avgZ /= shapePoints.length;
      
      const baseY = getElevationAt(avgX - chunkWorldX, avgZ - chunkWorldZ, elevationData, baseElevation);
      
      // Translate to terrain height (sink it slightly to avoid gaps)
      geometry.translate(0, baseY - 0.5, 0);
      addCollisionBox(body, shapePoints, baseY - 0.5, height);

      // Pick a color for this building
      // Deterministic per building so a building drawn by two chunks never flickers
      const colorHex = BUILDING_COLORS[Math.abs(Number(building.id) || 0) % BUILDING_COLORS.length];
      const color = new THREE.Color(colorHex);

      // Add vertex colors; roofs get a UV on the plain part of the window texture
      const posCount = geometry.attributes.position.count;
      const uv = geometry.attributes.uv;
      const colorData = new Float32Array(posCount * 3);
      for (let i = 0; i < posCount; i++) {
        // Slight variation for walls vs roof
        const pos = new THREE.Vector3();
        pos.fromBufferAttribute(geometry.attributes.position, i);
        const normal = new THREE.Vector3();
        normal.fromBufferAttribute(geometry.attributes.normal, i);

        // Darken walls slightly, roof stays original color
        const isTopFace = Math.abs(normal.y) > 0.9;
        const factor = isTopFace ? 1.0 : 0.75;
        if (isTopFace && uv) uv.setXY(i, PLAIN_UV, PLAIN_UV);

        colorData[i * 3] = color.r * factor;
        colorData[i * 3 + 1] = color.g * factor;
        colorData[i * 3 + 2] = color.b * factor;
      }

      geometry.setAttribute('color', new THREE.BufferAttribute(colorData, 3));
      geometries.push(geometry);
      const roof = pitchedRoof(building, shapePoints, baseY - 0.5 + height);
      if (roof) geometries.push(roof);

    } catch (err) {
      // Skip invalid shapes
      continue;
    }
  }

  if (geometries.length === 0) return null;

  // Merge all building geometries for performance
  const mergedGeometry = mergeGeometries(geometries);

  if (!mergedGeometry) return null;

  const textures = getWindowTextures();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0.1,
    flatShading: true,
    map: textures?.map ?? null,
    emissive: textures ? 0xffffff : 0x000000,
    emissiveMap: textures?.emissiveMap ?? null,
  });
  if (textures) registerBuildingMaterial(material); // windows light up at night

  const mesh = new THREE.Mesh(mergedGeometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  group.add(mesh);
  if (body.shapes.length > 0) group.userData.body = body;

  // Dispose individual geometries
  for (const geom of geometries) {
    geom.dispose();
  }

  return group;
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
  const id = Math.abs(Number(building.id) || 0);
  return (2 + ((id * 7919) % 4)) * METERS_PER_FLOOR || DEFAULT_BUILDING_HEIGHT;
}

const COLLIDER_CELL = 2; // metres; strips this wide follow the outline of L/U/odd-shaped buildings

/**
 * Collision boxes for a footprint, aligned with its longest wall.
 * A near-rectangle gets one box. Other shapes (L, U, courtyards) are cut into 2 m strips across the
 * long axis; each run of strip cells inside the footprint becomes one box, so a courtyard or the
 * inside corner of an L stays open instead of being one big box over a road or yard.
 * @param {THREE.Vector2[]} points footprint in world x / z
 */
function addCollisionBox(body, points, bottomY, height) {
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

  if (Math.abs(polygonArea(points)) >= 0.9 * 4 * r.halfU * r.halfV) {
    add(0, 0, r.halfU, r.halfV);
    return;
  }

  // Footprint in (u, v) around the rectangle centre, for point-in-polygon tests
  const local = points.map((p) => {
    const dx = p.x - r.cx, dz = p.y - r.cz;
    return { u: dx * r.ux + dz * r.uz, v: dx * vx + dz * vz };
  });
  // Capped so a huge irregular building (a stadium, a mall) stays at most ~40 strips
  const nu = Math.min(40, Math.max(1, Math.round((2 * r.halfU) / COLLIDER_CELL)));
  const nv = Math.min(40, Math.max(1, Math.round((2 * r.halfV) / COLLIDER_CELL)));
  const du = (2 * r.halfU) / nu, dv = (2 * r.halfV) / nv;
  for (let i = 0; i < nu; i++) {
    const u = -r.halfU + (i + 0.5) * du;
    let runStart = -1;
    for (let j = 0; j <= nv; j++) {
      const inside = j < nv && insideLocal(local, u, -r.halfV + (j + 0.5) * dv);
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
  const [cr, cg, cb] = ROOF_COLORS[Math.abs(Number(building.id) || 0) % ROOF_COLORS.length];
  const count = pos.length / 3;
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Array(count).fill([cr, cg, cb]).flat(), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(count * 2).fill(PLAIN_UV), 2));
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
