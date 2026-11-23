/**
 * StreetLamps.js — lamp posts along real roads, with a glowing bulb and a light pool that show at night.
 * No real lights: hundreds of PointLights would kill the frame rate, so the glow is a ground decal.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ROAD_WIDTHS, CHUNK_SIZE } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { getElevationAt } from './ElevationUtils.js';
import { bridgeLiftAt } from './RoadGenerator.js';
import { lampBulbMaterial, lampPoleMaterial, lampGlowMaterial } from './NightLights.js';

const LIT_ROADS = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
  'residential', 'unclassified', 'living_street',
  'service', // campus and estate roads; driveways and parking aisles stay dark (below)
]);
const DARK_SERVICE = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access']);
const SPACING = 35;            // metres between lamps along a road
const POLE_HEIGHT = 7;
const MAX_LAMPS_PER_CHUNK = 400; // dense city chunks are thinned evenly beyond this

const poleGeometry = new THREE.CylinderGeometry(0.08, 0.12, POLE_HEIGHT, 6).translate(0, POLE_HEIGHT / 2, 0);
const bulbGeometry = new THREE.BoxGeometry(0.5, 0.2, 0.9).translate(0, POLE_HEIGHT, 0);
const glowGeometry = new THREE.CircleGeometry(7, 20).rotateX(-Math.PI / 2).translate(0, 0.12, 0);

/**
 * Positions of the lamps that belong to this chunk. Pure, for tests.
 * Lamps alternate sides and stand just off the road edge; a lamp belongs to the chunk it stands in,
 * so a road crossing several chunks gets each lamp exactly once.
 * @returns {{ x: number, z: number }[]}
 */
export function lampPositions(roads, chunkWorldX, chunkWorldZ, originLat, originLng) {
  const out = [];
  const half = CHUNK_SIZE / 2;
  for (const road of roads) {
    const type = road.tags?.highway;
    // OSM `lit` wins: lit=yes lights service roads too, lit=no leaves a country road dark
    const lit = road.tags?.lit;
    if (lit === 'no' || road.tags?.tunnel === 'yes' || (!LIT_ROADS.has(type) && lit !== 'yes')) continue;
    if (lit !== 'yes' && type === 'service' && DARK_SERVICE.has(road.tags.service)) continue;
    const side = (ROAD_WIDTHS[type] ?? 5) / 2 + 1;
    const pts = road.geometry.map((n) => latLngToMeters(n.lat, n.lon, originLat, originLng));

    let next = SPACING / 2; // distance along the road of the next lamp
    let walked = 0;
    let count = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.01) continue;
      const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
      while (next <= walked + len) {
        const t = (next - walked) / len;
        const s = count % 2 ? side : -side;
        const x = a.x + (b.x - a.x) * t + nx * s;
        const z = a.z + (b.z - a.z) * t + nz * s;
        if (x >= chunkWorldX - half && x < chunkWorldX + half && z >= chunkWorldZ - half && z < chunkWorldZ + half) {
          out.push({ x, z, road });
        }
        count++;
        next += SPACING;
      }
      walked += len;
    }
  }
  // Bug: the old cap stopped at the first 150 lamps, so streets listed later in a dense chunk had none
  if (out.length <= MAX_LAMPS_PER_CHUNK) return out;
  const keep = out.length / MAX_LAMPS_PER_CHUNK;
  return out.filter((_, i) => Math.floor(i % keep) === 0);
}

/** @returns {THREE.Group | null} */
export function generateStreetLamps(roads, elevationData, chunkWorldX, chunkWorldZ, originLat, originLng, baseElevation) {
  const positions = lampPositions(roads, chunkWorldX, chunkWorldZ, originLat, originLng);
  if (positions.length === 0) return null;

  const group = new THREE.Group();
  group.name = 'streetlamps';
  const poles = new THREE.InstancedMesh(poleGeometry, lampPoleMaterial, positions.length);
  const bulbs = new THREE.InstancedMesh(bulbGeometry, lampBulbMaterial, positions.length);
  const glows = new THREE.InstancedMesh(glowGeometry, lampGlowMaterial, positions.length);
  poles.castShadow = true;
  for (const m of [poles, bulbs, glows]) m.userData.shared = true; // geometry/material shared by all chunks

  // One static body per chunk with a thin box per pole, so the car hits poles instead of passing through
  const body = new CANNON.Body({ mass: 0 });
  const poleShape = new CANNON.Box(new CANNON.Vec3(0.15, POLE_HEIGHT / 2, 0.15));

  const matrix = new THREE.Matrix4();
  positions.forEach(({ x, z, road }, i) => {
    const y = getElevationAt(x - chunkWorldX, z - chunkWorldZ, elevationData, baseElevation) + bridgeLiftAt(road, x, z);
    body.addShape(poleShape, new CANNON.Vec3(x, y + POLE_HEIGHT / 2, z));
    matrix.makeTranslation(x, y, z);
    poles.setMatrixAt(i, matrix);
    bulbs.setMatrixAt(i, matrix);
    glows.setMatrixAt(i, matrix);
  });
  group.add(poles, bulbs, glows);
  group.userData.body = body;
  return group;
}
