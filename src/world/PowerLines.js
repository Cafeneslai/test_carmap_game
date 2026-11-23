/**
 * PowerLines.js — concrete power poles and sagging overhead wires along streets, the look of
 * Thai (and South-East Asian) towns: one row of poles on the kerb side, three power wires on a
 * crossarm, a bundle of telecom cables lower down, and a transformer on every few poles.
 * Poles are instanced and solid; wires are thin lines (no collision).
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ROAD_WIDTHS, CHUNK_SIZE } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { getElevationAt } from './ElevationUtils.js';

const WIRED_ROADS = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service',
  'primary_link', 'secondary_link', 'tertiary_link']);
const NO_POLES_SERVICE = new Set(['driveway', 'parking_aisle', 'drive-through']);
const SPACING = 40;       // metres between poles
const POLE_HEIGHT = 9;
const MAX_POLES_PER_CHUNK = 300;
// [sideways offset from the pole, height, sag] per wire: three power wires, then the telecom bundle
const WIRES = [[-0.7, 8.6, 0.5], [0, 8.6, 0.5], [0.7, 8.6, 0.5], [0.15, 6.4, 0.9], [0.3, 6.2, 1.1], [0.05, 6.0, 1.3], [0.25, 5.8, 1.0]];

/**
 * Shortcut: mainland South-East Asia as a box (Thailand, Laos, Cambodia, Vietnam, Myanmar, Malaysia).
 * Upgrade to per-country data together with the driving-side roadmap item.
 */
export function hasOverheadWires(lat, lng) {
  return lat > 0.8 && lat < 28.5 && lng > 92 && lng < 110;
}

const poleGeometry = new THREE.CylinderGeometry(0.11, 0.17, POLE_HEIGHT, 4).rotateY(Math.PI / 4).translate(0, POLE_HEIGHT / 2, 0);
const armGeometry = new THREE.BoxGeometry(1.8, 0.12, 0.12).translate(0, 8.5, 0);
const transformerGeometry = new THREE.CylinderGeometry(0.35, 0.35, 1.1, 10).translate(0.45, 7.2, 0);
const concrete = new THREE.MeshStandardMaterial({ color: 0x9c9a94, roughness: 0.9, metalness: 0 });
const steel = new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.6, metalness: 0.1 });
const wireMaterial = new THREE.LineBasicMaterial({ color: 0x141414 });

/**
 * Poles along each road, every SPACING metres on the kerb side (left in left-hand traffic).
 * Each road's poles are numbered so a chunk can join a pole to the next one even in another chunk.
 * Pure, for tests.
 * @returns {{ x: number, z: number, ax: number, az: number, road: object, i: number }[][]} per road, all its poles
 */
export function poleRows(roads, originLat, originLng, leftHand) {
  const rows = [];
  for (const road of roads) {
    const t = road.tags || {};
    if (!WIRED_ROADS.has(t.highway) || t.bridge || t.tunnel || (t.highway === 'service' && NO_POLES_SERVICE.has(t.service))) continue;
    const side = ((ROAD_WIDTHS[t.highway] ?? 5) / 2 + 1.2) * (leftHand ? -1 : 1);
    const pts = road.geometry.map((n) => latLngToMeters(n.lat, n.lon, originLat, originLng));
    const row = [];
    let next = SPACING / 3, walked = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.01) continue;
      const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
      while (next <= walked + len) {
        const t2 = (next - walked) / len;
        // Right of the direction of travel is (-dz, dx)
        row.push({ x: a.x + (b.x - a.x) * t2 - dz * side, z: a.z + (b.z - a.z) * t2 + dx * side, ax: -dz, az: dx, road, i: row.length });
        next += SPACING;
      }
      walked += len;
    }
    if (row.length) rows.push(row);
  }
  return rows;
}

/** @returns {THREE.Group | null} with userData.body (pole colliders) */
export function generatePowerLines(roads, elevationData, chunkWorldX, chunkWorldZ, originLat, originLng, base, leftHand) {
  const half = CHUNK_SIZE / 2;
  const mine = (p) => p.x >= chunkWorldX - half && p.x < chunkWorldX + half && p.z >= chunkWorldZ - half && p.z < chunkWorldZ + half;
  const groundAt = (x, z) => getElevationAt(x - chunkWorldX, z - chunkWorldZ, elevationData, base);
  const poles = [];
  const wire = [];
  for (const row of poleRows(roads, originLat, originLng, leftHand)) {
    for (let k = 0; k < row.length && poles.length < MAX_POLES_PER_CHUNK; k++) {
      const p = row[k];
      if (!mine(p)) continue;
      p.y = groundAt(p.x, p.z);
      poles.push(p);
      const q = row[k + 1];
      if (!q) continue;
      const qy = groundAt(q.x, q.z); // may be just outside this chunk: clamped, close enough for a wire
      for (const [off, h, sag] of WIRES) {
        const SEG = 8;
        for (let s = 0; s < SEG; s++) {
          for (const t of [s / SEG, (s + 1) / SEG]) {
            const x = p.x + (q.x - p.x) * t + (p.ax + (q.ax - p.ax) * t) * off;
            const z = p.z + (q.z - p.z) * t + (p.az + (q.az - p.az) * t) * off;
            wire.push(x, p.y + (qy - p.y) * t + h - 4 * sag * t * (1 - t), z);
          }
        }
      }
    }
  }
  if (!poles.length) return null;

  const group = new THREE.Group();
  group.name = 'powerlines';
  const poleMesh = new THREE.InstancedMesh(poleGeometry, concrete, poles.length);
  const armMesh = new THREE.InstancedMesh(armGeometry, steel, poles.length);
  const transformers = poles.filter((p) => p.i % 6 === 3);
  const boxMesh = new THREE.InstancedMesh(transformerGeometry, steel, Math.max(1, transformers.length));
  boxMesh.count = transformers.length;
  for (const m of [poleMesh, armMesh, boxMesh]) { m.userData.shared = true; m.castShadow = true; }
  const body = new CANNON.Body({ mass: 0 });
  const shape = new CANNON.Box(new CANNON.Vec3(0.17, POLE_HEIGHT / 2, 0.17));
  const matrix = new THREE.Matrix4();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const place = (p) => matrix.makeRotationAxis(yAxis, Math.atan2(p.ax, p.az) + Math.PI / 2).setPosition(p.x, p.y, p.z);
  poles.forEach((p, i) => {
    place(p);
    poleMesh.setMatrixAt(i, matrix);
    armMesh.setMatrixAt(i, matrix);
    body.addShape(shape, new CANNON.Vec3(p.x, p.y + POLE_HEIGHT / 2, p.z));
  });
  transformers.forEach((p, i) => boxMesh.setMatrixAt(i, place(p)));
  group.add(poleMesh, armMesh, boxMesh);

  if (wire.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    const lines = new THREE.LineSegments(g, wireMaterial);
    lines.userData.sharedMaterial = true;
    group.add(lines);
  }
  group.userData.body = body;
  return group;
}
