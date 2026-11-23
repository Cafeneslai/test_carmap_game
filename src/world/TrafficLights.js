/**
 * TrafficLights.js — signal heads at OSM `highway=traffic_signals` nodes, and their shared cycle.
 *
 * Every road through a signal node gets a pole on each approach, on the side traffic drives on,
 * facing the oncoming cars. Roads running mostly east-west and mostly north-south use opposite
 * phases, so crossing streets are never green together. NPC cars read the same `signalState`.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ROAD_WIDTHS } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { DRIVABLE } from '../data/OSMFetcher.js';
import { getElevationAt } from './ElevationUtils.js';

export const CYCLE_SECONDS = 24;
const GREEN_SECONDS = 9;
const YELLOW_SECONDS = 3;
const POLE_HEIGHT = 5.4;
const STOP_BACK = 6; // metres before the signal node where the pole stands

/**
 * @param {0 | 1} phase which axis (see signalPhase)
 * @param {number} time seconds since the game started
 * @returns {'green' | 'yellow' | 'red'}
 */
export function signalState(phase, time) {
  const t = (((time + phase * (CYCLE_SECONDS / 2)) % CYCLE_SECONDS) + CYCLE_SECONDS) % CYCLE_SECONDS;
  if (t < GREEN_SECONDS) return 'green';
  if (t < GREEN_SECONDS + YELLOW_SECONDS) return 'yellow';
  return 'red';
}

/** Phase of a road direction: 0 for mostly east-west, 1 for mostly north-south */
export function signalPhase(dx, dz) {
  return Math.abs(dx) >= Math.abs(dz) ? 0 : 1;
}

export const signalKey = (n) => `${n.lat.toFixed(7)},${n.lon.toFixed(7)}`;

// ---- Shared look: one material per (phase, colour), switched on/off by updateTrafficLights ----
const COLORS = { red: 0xff2a1a, yellow: 0xffb000, green: 0x22ff66 };
const OFF = 0x2a2a2a;
const lampMaterials = [0, 1].map(() => ({
  red: new THREE.MeshBasicMaterial({ color: OFF }),
  yellow: new THREE.MeshBasicMaterial({ color: OFF }),
  green: new THREE.MeshBasicMaterial({ color: OFF }),
}));
const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x6b6f75, roughness: 0.7, metalness: 0.1 }); // no env map: metal would render black
const housingMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.7 });
const poleGeometry = new THREE.CylinderGeometry(0.09, 0.11, POLE_HEIGHT, 6).translate(0, POLE_HEIGHT / 2, 0);
const housingGeometry = new THREE.BoxGeometry(0.45, 1.25, 0.3).translate(0, POLE_HEIGHT - 0.3, 0);
const lampGeometry = new THREE.CircleGeometry(0.15, 12);
const LAMP_Y = { red: POLE_HEIGHT + 0.08, yellow: POLE_HEIGHT - 0.3, green: POLE_HEIGHT - 0.68 };

let shown = [null, null];
/** Switch every signal head in the world to the state at this time */
export function updateTrafficLights(time) {
  for (const phase of [0, 1]) {
    const state = signalState(phase, time);
    if (shown[phase] === state) continue;
    shown[phase] = state;
    for (const c of ['red', 'yellow', 'green']) lampMaterials[phase][c].color.setHex(c === state ? COLORS[c] : OFF);
  }
}

/**
 * Where the signal heads of a chunk stand. Pure, for tests.
 * @returns {{ x: number, z: number, yaw: number, phase: 0 | 1 }[]} yaw turns the head's front (+Z) towards oncoming cars
 */
export function signalHeads(signals, roads, originLat, originLng, leftHand) {
  const heads = [];
  for (const signal of signals) {
    const key = signalKey(signal);
    const at = latLngToMeters(signal.lat, signal.lon, originLat, originLng);
    for (const road of roads) {
      if (!DRIVABLE.has(road.tags?.highway)) continue;
      const i = road.geometry.findIndex((n) => signalKey(n) === key);
      if (i < 0) continue;
      const side = (ROAD_WIDTHS[road.tags.highway] ?? 5) / 2 + 0.8;
      const oneway = road.tags.oneway === 'yes';
      // Approaches: from the previous node (travelling forwards) and, on two-way roads, from the next one
      const approaches = [];
      if (i > 0) approaches.push(road.geometry[i - 1]);
      if (i < road.geometry.length - 1 && !oneway) approaches.push(road.geometry[i + 1]);
      for (const from of approaches) {
        const p = latLngToMeters(from.lat, from.lon, originLat, originLng);
        let dx = at.x - p.x, dz = at.z - p.z; // direction of travel towards the signal
        const len = Math.hypot(dx, dz);
        if (len < 1) continue;
        dx /= len; dz /= len;
        // Facing +Z, +X is the driver's left: left = (dz, -dx), right = (-dz, dx)
        const sx = leftHand ? dz : -dz, sz = leftHand ? -dx : dx;
        const back = Math.min(STOP_BACK, len * 0.5);
        heads.push({
          x: at.x - dx * back + sx * side,
          z: at.z - dz * back + sz * side,
          yaw: Math.atan2(-dx, -dz),
          phase: signalPhase(dx, dz),
        });
      }
    }
  }
  return heads;
}

/** @returns {THREE.Group | null} with userData.body holding the pole colliders */
export function generateTrafficLights(signals, roads, elevationData, chunkWorldX, chunkWorldZ, originLat, originLng, baseElevation, leftHand) {
  if (!signals?.length) return null;
  const heads = signalHeads(signals, roads, originLat, originLng, leftHand);
  if (heads.length === 0) return null;

  const group = new THREE.Group();
  group.name = 'trafficlights';
  const poles = new THREE.InstancedMesh(poleGeometry, poleMaterial, heads.length);
  const housings = new THREE.InstancedMesh(housingGeometry, housingMaterial, heads.length);
  poles.castShadow = housings.castShadow = true;
  const lamps = [];
  for (const phase of [0, 1]) {
    const count = heads.filter((h) => h.phase === phase).length;
    if (!count) continue;
    for (const c of ['red', 'yellow', 'green']) lamps.push({ phase, c, mesh: new THREE.InstancedMesh(lampGeometry, lampMaterials[phase][c], count), n: 0 });
  }

  const body = new CANNON.Body({ mass: 0 });
  const poleShape = new CANNON.Box(new CANNON.Vec3(0.15, POLE_HEIGHT / 2, 0.15));
  const m = new THREE.Matrix4();
  const lampM = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  heads.forEach((h, i) => {
    const y = getElevationAt(h.x - chunkWorldX, h.z - chunkWorldZ, elevationData, baseElevation);
    q.setFromAxisAngle(up, h.yaw);
    m.compose(new THREE.Vector3(h.x, y, h.z), q, new THREE.Vector3(1, 1, 1));
    poles.setMatrixAt(i, m);
    housings.setMatrixAt(i, m);
    for (const l of lamps) {
      if (l.phase !== h.phase) continue;
      lampM.makeTranslation(0, LAMP_Y[l.c], 0.16).premultiply(m); // just in front of the housing
      l.mesh.setMatrixAt(l.n++, lampM);
    }
    body.addShape(poleShape, new CANNON.Vec3(h.x, y + POLE_HEIGHT / 2, h.z));
  });

  for (const mesh of [poles, housings, ...lamps.map((l) => l.mesh)]) {
    mesh.userData.shared = true; // geometry and materials are shared by every chunk
    group.add(mesh);
  }
  group.userData.body = body;
  return group;
}
