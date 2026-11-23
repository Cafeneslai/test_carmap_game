/**
 * VegetationPlacer.js — trees that look like the place: coconut palms, wide rain trees and broadleaf
 * trees in the tropics, conifers and broadleaf trees elsewhere. Forests, parks and OSM street trees
 * (natural=tree, tree_row) are planted; roads, buildings and water are kept clear. Every species is
 * one instanced mesh per chunk, tinted per tree and swaying in the wind.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TREE_DENSITY, MAX_TREES_PER_CHUNK, CHUNK_SIZE } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { DRIVABLE } from '../data/OSMFetcher.js';
import { getElevationAt } from './ElevationUtils.js';

const MAX_CANDIDATES_PER_POLYGON = 40000;
const TROPICS_LAT = 25; // palms and rain trees up to here, conifers beyond

// ---------------------------------------------------------------------------------------------
// Species geometry (built once, vertex coloured, ~60-150 triangles each)
// ---------------------------------------------------------------------------------------------

function paint(geometry, hex) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const c = new THREE.Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

/** A lumpy leaf blob: an icosahedron with its corners pushed in and out (same push for shared corners) */
function blob(radius, sx, sy, sz, x, y, z, hex, seed) {
  const g = new THREE.IcosahedronGeometry(radius, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const h = Math.sin(Math.round(p.getX(i) * 10) * 12.9898 + Math.round(p.getY(i) * 10) * 78.233 + Math.round(p.getZ(i) * 10) * 37.719 + seed) * 43758.5453;
    const k = 0.82 + (h - Math.floor(h)) * 0.36;
    p.setXYZ(i, p.getX(i) * k * sx + x, p.getY(i) * k * sy + y, p.getZ(i) * k * sz + z);
  }
  g.computeVertexNormals();
  return paint(g, hex);
}

function trunk(r0, r1, height, hex, x = 0, z = 0, tiltX = 0, tiltZ = 0, y0 = 0) {
  const g = new THREE.CylinderGeometry(r1, r0, height, 6, 1);
  g.translate(0, height / 2, 0);
  g.rotateX(tiltX);
  g.rotateZ(tiltZ);
  g.translate(x, y0, z);
  return paint(g, hex);
}

function buildPalm() {
  const parts = [];
  // Curved, slightly leaning trunk in 5 pieces
  let x = 0, y = 0;
  const top = 9;
  for (let i = 0; i < 5; i++) {
    const lean = 0.05 + i * 0.045;
    const len = top / 5;
    parts.push(trunk(0.24 - i * 0.02, 0.22 - i * 0.02, len + 0.05, 0x8a7a66, x, 0, 0, -lean, y));
    x += Math.sin(lean) * len;
    y += Math.cos(lean) * len;
  }
  // Fronds: drooping, tapering strips around the crown
  const verts = [];
  for (let f = 0; f < 10; f++) {
    const a = (f / 10) * Math.PI * 2 + (f % 2) * 0.2;
    const lift = f % 2 ? 0.55 : 0.25;
    const dx = Math.cos(a), dz = Math.sin(a);
    const at = (t, side) => {
      const reach = t * 4.6;
      const w = 0.55 * Math.sin(Math.PI * Math.min(t * 1.15, 1)) * side;
      return [x + dx * reach - dz * w, y + lift * reach * 1.1 - 2.4 * t * t, dz * reach + dx * w];
    };
    for (let s = 0; s < 4; s++) {
      const t0 = s / 4, t1 = (s + 1) / 4;
      const a0 = at(t0, 1), b0 = at(t0, -1), a1 = at(t1, 1), b1 = at(t1, -1);
      verts.push(...a0, ...b0, ...a1, ...b0, ...b1, ...a1);
    }
  }
  const fronds = new THREE.BufferGeometry();
  fronds.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  fronds.computeVertexNormals();
  parts.push(paint(fronds, 0x5d8c2e));
  // Coconuts under the crown
  for (let i = 0; i < 3; i++) parts.push(blob(0.22, 1, 1, 1, x + Math.cos(i * 2.1) * 0.3, y - 0.4, Math.sin(i * 2.1) * 0.3, 0x6b6a2a, i));
  return mergeGeometries(parts);
}

function buildRainTree() {
  // Short thick trunk forking into an umbrella crown, much wider than tall (Samanea saman)
  const parts = [trunk(0.5, 0.4, 3, 0x5e4a3a)];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    parts.push(trunk(0.28, 0.16, 3.6, 0x5e4a3a, 0, 0, Math.sin(a) * 0.6, Math.cos(a) * 0.6, 2.6));
  }
  const greens = [0x3f6e2a, 0x4a7a30, 0x3a6526];
  parts.push(blob(3.4, 1.3, 0.5, 1.3, 0, 7.2, 0, greens[0], 1));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.push(blob(2.6, 1.2, 0.5, 1.2, Math.cos(a) * 4.2, 6.4 + (i % 2) * 0.6, Math.sin(a) * 4.2, greens[i % 3], i + 2));
  }
  return mergeGeometries(parts);
}

function buildBroadleaf() {
  const parts = [trunk(0.26, 0.18, 4.5, 0x5b4636)];
  const greens = [0x44762c, 0x3d6c28, 0x4f8234];
  parts.push(blob(2.4, 1, 0.9, 1, 0, 6.2, 0, greens[0], 7));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    parts.push(blob(1.8, 1, 0.85, 1, Math.cos(a) * 1.5, 5.2 + i * 0.3, Math.sin(a) * 1.5, greens[(i + 1) % 3], i + 9));
  }
  return mergeGeometries(parts);
}

function buildConifer() {
  const parts = [trunk(0.22, 0.15, 3, 0x4f3a2a)];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.ConeGeometry(2.2 - i * 0.55, 3.2, 8, 1);
    g.translate(0, 3.2 + i * 2, 0);
    parts.push(paint(g, [0x2f5a32, 0x2c5530, 0x33603a][i]));
  }
  return mergeGeometries(parts);
}

let species = null;
let material = null;
/** Shared by every tree material: time and wind strength (0 calm .. 1 storm) */
export const windUniforms = { uTime: { value: 0 }, uWind: { value: 0.3 } };

function ensureSharedAssets() {
  if (species) return;
  species = { palm: buildPalm(), rainTree: buildRainTree(), broadleaf: buildBroadleaf(), conifer: buildConifer() };
  material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: true, side: THREE.DoubleSide });
  // Sway: the higher a vertex, the further it moves; each tree has its own phase
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.vertexShader = 'uniform float uTime;\nuniform float uWind;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        float phase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
        float bend = max(position.y - 2.0, 0.0) * (0.006 + 0.03 * uWind);
        transformed.x += sin(uTime * (1.1 + uWind) + phase) * bend;
        transformed.z += cos(uTime * (0.9 + uWind) + phase * 1.3) * bend * 0.6;
      #endif`);
  };
}

// ---------------------------------------------------------------------------------------------
// Choosing a species
// ---------------------------------------------------------------------------------------------

/** What grows here, from the tree's own OSM tags first, then the climate and the kind of area */
export function pickSpecies(tags, tropical, r) {
  const genus = `${tags?.genus || ''} ${tags?.species || ''} ${tags?.taxon || ''}`.toLowerCase();
  if (/cocos|palm|areca|roystonea|elaeis|phoenix/.test(genus)) return 'palm';
  if (/samanea|albizia|ficus|tamarind/.test(genus)) return 'rainTree';
  if (tags?.leaf_type === 'needleleaved') return 'conifer';
  if (tags?.leaf_type === 'broadleaved') return tropical && r < 0.3 ? 'rainTree' : 'broadleaf';
  const forest = tags?.landuse === 'forest' || tags?.natural === 'wood';
  if (tropical) {
    if (forest) return r < 0.75 ? 'broadleaf' : r < 0.9 ? 'rainTree' : 'palm';
    return r < 0.4 ? 'rainTree' : r < 0.75 ? 'broadleaf' : 'palm';
  }
  if (forest) return r < 0.5 ? 'conifer' : 'broadleaf';
  return r < 0.75 ? 'broadleaf' : 'conifer';
}

// ---------------------------------------------------------------------------------------------
// Keeping trees off roads, buildings and water
// ---------------------------------------------------------------------------------------------

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z, xj = polygon[j].x, zj = polygon[j].z;
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

function boxOf(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Road segments (with half-width + margin) and building/water outlines near this chunk */
function buildObstacles({ roads = [], buildings = [], water = [] }, rect, toM) {
  const grow = 12;
  const near = (b) => !(b.maxX < rect.minX - grow || b.minX > rect.maxX + grow || b.maxZ < rect.minZ - grow || b.minZ > rect.maxZ + grow);
  const segments = [];
  for (const road of roads) {
    const hw = road.tags?.highway;
    if (!hw || hw === 'footway' || hw === 'path' || hw === 'steps') continue;
    const clear = (DRIVABLE.has(hw) ? (/motorway|trunk|primary/.test(hw) ? 8 : /secondary|tertiary/.test(hw) ? 6 : 4.5) : 2) + 1;
    const pts = road.geometry.map(toM);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (near(boxOf([a, b]))) segments.push({ a, b, clear });
    }
  }
  const areas = [];
  for (const el of [...buildings, ...water.filter((w) => !w.tags?.waterway || w.tags.waterway === 'riverbank')]) {
    if (!el.geometry || el.geometry.length < 3) continue;
    const pts = el.geometry.map(toM);
    const box = boxOf(pts);
    if (near(box)) areas.push({ pts, box, pad: el.tags?.building ? 1.5 : 0 });
  }
  return (x, z) => {
    for (const { a, b, clear } of segments) {
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
      if (Math.hypot(x - a.x - t * dx, z - a.z - t * dz) < clear) return true;
    }
    for (const { pts, box, pad } of areas) {
      if (x < box.minX - pad || x > box.maxX + pad || z < box.minZ - pad || z > box.maxZ + pad) continue;
      if (pointInPolygon(x, z, pts) || (pad && (pointInPolygon(x + pad, z, pts) || pointInPolygon(x - pad, z, pts) || pointInPolygon(x, z + pad, pts) || pointInPolygon(x, z - pad, pts)))) return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------

const rng = (seed) => () => (seed = (seed * 16807 + 7) % 2147483647) / 2147483647;

/**
 * Plant the trees of one chunk.
 * @param {object[]} greeneryElements forests, parks, gardens (OSM areas, may carry `holes`)
 * @param {{ roads?: object[], buildings?: object[], water?: object[], trees?: object[] }} [context]
 *   what the trees must avoid, plus OSM street trees ({ lat, lon, tags })
 * @returns {THREE.Group | null}
 */
export function placeVegetation(greeneryElements, elevationData, chunkWorldX, chunkWorldZ, originLat, originLng, baseElevation = null, context = {}) {
  ensureSharedAssets();
  const tropical = Math.abs(originLat) < TROPICS_LAT;
  const toM = (n) => latLngToMeters(n.lat, n.lon, originLat, originLng);
  const half = CHUNK_SIZE / 2;
  const rect = { minX: chunkWorldX - half, maxX: chunkWorldX + half, minZ: chunkWorldZ - half, maxZ: chunkWorldZ + half };
  const blocked = buildObstacles(context, rect, toM);
  const trees = []; // { x, z, scale, rotation, kind, tint }

  // 1. Street and garden trees mapped one by one in OSM
  for (const t of context.trees || []) {
    const { x, z } = toM(t); // already picked for this chunk by OSMFetcher
    const r =rng(Math.abs(Math.floor(x * 131 + z * 71)) % 2147483646 + 1);
    const h = parseFloat(t.tags?.height);
    trees.push({ x, z, kind: pickSpecies(t.tags, tropical, r()), scale: h > 0 ? THREE.MathUtils.clamp(h / 8, 0.4, 2.2) : 0.75 + r() * 0.5, rotation: r() * Math.PI * 2, tint: r() });
  }

  // 2. Areas: sampled only where they overlap this chunk, so no tree is placed twice
  for (const element of greeneryElements) {
    if (!element.geometry || element.geometry.length < 3) continue;
    const polygon = element.geometry.map(toM);
    const box = boxOf(polygon);
    const x0 = Math.max(box.minX, rect.minX), x1 = Math.min(box.maxX, rect.maxX);
    const z0 = Math.max(box.minZ, rect.minZ), z1 = Math.min(box.maxZ, rect.maxZ);
    if (x0 >= x1 || z0 >= z1) continue;
    const holes = (element.holes || []).map((ring) => ring.map(toM));
    // Lawns get scattered trees, woods get dense ones
    const density = TREE_DENSITY * (element.tags?.landuse === 'grass' ? 0.25 : element.tags?.leisure ? 0.6 : 1);
    const numTrees = Math.min(Math.floor((x1 - x0) * (z1 - z0) * density), MAX_CANDIDATES_PER_POLYGON);
    const r = rng(Math.abs(Math.floor(box.minX * 100 + box.minZ * 77 + chunkWorldX * 13 + chunkWorldZ * 7)) % 2147483646 + 1);

    for (let i = 0; i < numTrees && trees.length < MAX_TREES_PER_CHUNK; i++) {
      const x = x0 + r() * (x1 - x0), z = z0 + r() * (z1 - z0);
      const scale = 0.65 + r() * 0.6, rotation = r() * Math.PI * 2, pick = r(), tint = r();
      if (!pointInPolygon(x, z, polygon) || holes.some((h) => pointInPolygon(x, z, h)) || blocked(x, z)) continue;
      trees.push({ x, z, kind: pickSpecies(element.tags, tropical, pick), scale, rotation, tint });
    }
  }

  if (trees.length === 0) return null;

  const group = new THREE.Group();
  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  for (const kind of Object.keys(species)) {
    const list = trees.filter((t) => t.kind === kind);
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(species[kind], material, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.shared = true; // geometry/material are reused by every chunk
    mesh.userData.species = kind;
    list.forEach((t, i) => {
      const y = elevationData ? getElevationAt(t.x - chunkWorldX, t.z - chunkWorldZ, elevationData, baseElevation) : 0;
      matrix.compose(new THREE.Vector3(t.x, y - 0.1, t.z), q.setFromAxisAngle(up, t.rotation), new THREE.Vector3(t.scale, t.scale, t.scale));
      mesh.setMatrixAt(i, matrix);
      // Slightly different shade per tree (multiplies the vertex colours)
      const k = 0.82 + t.tint * 0.32;
      mesh.setColorAt(i, color.setRGB(k * (0.92 + 0.16 * t.tint), k, k * 0.92));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  }
  return group;
}
