/**
 * Towers.js — structures that are not buildings: lattice TV towers, masts, concrete TV towers,
 * chimneys and water towers, from OSM `man_made` (nodes, outlines and multipolygons).
 * Each kind gets its own simple shape at its real `height`; tall lattice towers and masts get the
 * orange/white aviation bands and a red light on top. Only the feet are solid, so you can drive
 * between the legs of a lattice tower.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { latLngToMeters } from '../data/GeoUtils.js';
import { getElevationAt } from './ElevationUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { chediGeometry } from './ThaiTemple.js';

const ORANGE = new THREE.Color(0xd4502a);
const WHITE = new THREE.Color(0xe8e6e0);
const STEEL = new THREE.Color(0x8d9196);
const CONCRETE = new THREE.Color(0xb8b4ab);
const BRICK = new THREE.Color(0x8a4a38);

const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 });
const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xff2010 });

/**
 * What to build for a tower element, in metres. Pure, for tests.
 * @param {{ tags: object, width?: number }} tower  width = footprint size (0 for a node)
 * @returns {{ shape: 'lattice'|'mast'|'tvtower'|'chimney'|'water'|'block', height: number, base: number, banded: boolean }}
 */
export function towerSpec(tower, tropical = false) {
  const t = tower.tags;
  const width = tower.width || 0;
  const tagged = parseFloat(t.height);
  const type = t['tower:type'];
  const kind = t.man_made;

  let shape = 'block';
  if (type === 'lighting') shape = 'pole'; // floodlight mast at a stadium or junction, not a radio mast
  else if (type === 'pagoda' && tropical) shape = 'chedi';
  else if (kind === 'mast') shape = 'mast';
  else if (kind === 'chimney') shape = 'chimney';
  else if (kind === 'water_tower') shape = 'water';
  else if (kind === 'communications_tower') shape = t['tower:construction'] === 'lattice' ? 'lattice' : 'tvtower';
  else if (t['tower:construction'] === 'lattice' || (type === 'communication' && width >= 20)) shape = 'lattice';
  else if (type === 'communication') shape = 'mast';

  const fallback = { lattice: 120, mast: 60, tvtower: 150, chimney: 50, water: 25, pole: 25, chedi: width > 0 ? Math.min(Math.max(8, width * 2.3), 90) : 12, block: type === 'observation' ? 30 : 18 }[shape];
  let height = tagged > 0 ? tagged : fallback;
  // shortcut: a big lattice tower whose outline is also a building is often tagged with the height
  // of the building between its legs (Tokyo Tower says 21 m); such towers stand ~3.8x their base.
  // Upgrade when OSM building:part heights are read.
  if (shape === 'lattice' && width >= 20 && height < 2 * width) height = Math.min(3.8 * width, 400);

  const base = shape === 'lattice' ? Math.min(Math.max(width / 2, 2), height / 8)
    : shape === 'mast' || shape === 'pole' ? 1
    : shape === 'water' ? Math.max(4, Math.min(width / 2, 12))
    : Math.max(width / 2, shape === 'chimney' ? 2 : 3);
  return { shape, height, base, banded: (shape === 'lattice' || shape === 'mast') && height >= 45 };
}

/** Box from a to b (a beam), `thick` metres square */
function beam(a, b, thick) {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(thick, thick, len);
  const m = new THREE.Matrix4().lookAt(a, b, Math.abs(b.y - a.y) > len * 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  return g.applyMatrix4(m);
}

const v = (x, y, z) => new THREE.Vector3(x, y, z);

/** Four legs (or three for a mast) leaning in from `r0` at y0 to `r1` at y1, braced every `step` metres */
function latticeSection(parts, r0, r1, y0, y1, legs, thick, step) {
  const corner = (r, y, k) => {
    const a = (k / legs) * Math.PI * 2 + Math.PI / 4;
    return v(Math.cos(a) * r, y, Math.sin(a) * r);
  };
  for (let k = 0; k < legs; k++) parts.push(beam(corner(r0, y0, k), corner(r1, y1, k), thick));
  const n = Math.max(1, Math.round((y1 - y0) / step));
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    const r = r0 + ((r1 - r0) * i) / n;
    for (let k = 0; k < legs; k++) {
      parts.push(beam(corner(r, y, k), corner(r, y, k + 1), thick * 0.5));
      // Diagonal bracing up to the next level
      if (i < n) {
        const yN = y0 + ((y1 - y0) * (i + 1)) / n, rN = r0 + ((r1 - r0) * (i + 1)) / n;
        parts.push(beam(corner(r, y, k), corner(rN, yN, k + 1), thick * 0.35));
      }
    }
  }
}

/** Geometry of one tower around (0, 0, 0), coloured per vertex. Pure, for tests. */
export function towerGeometry(spec) {
  const { shape, height: h, base: b } = spec;
  const parts = [];
  if (shape === 'lattice') {
    const waist = b * 0.28;
    latticeSection(parts, b, waist, 0, h * 0.45, 4, Math.max(0.6, b * 0.06), Math.max(6, h / 25));
    parts.push(new THREE.BoxGeometry(waist * 2.6, h * 0.025, waist * 2.6).translate(0, h * 0.45, 0)); // main deck
    latticeSection(parts, waist, b * 0.06, h * 0.45, h * 0.82, 4, Math.max(0.4, b * 0.04), Math.max(5, h / 30));
    parts.push(new THREE.BoxGeometry(waist * 1.2, h * 0.015, waist * 1.2).translate(0, h * 0.7, 0)); // top deck
    parts.push(new THREE.CylinderGeometry(0.25, Math.max(0.5, b * 0.04), h * 0.18, 6).translate(0, h * 0.91, 0));
  } else if (shape === 'mast') {
    latticeSection(parts, b, b * 0.7, 0, h, 3, 0.18, 4);
  } else if (shape === 'pole') {
    parts.push(new THREE.CylinderGeometry(0.22, 0.4, h, 8).translate(0, h / 2, 0));
    parts.push(new THREE.BoxGeometry(3, 1.2, 0.6).translate(0, h, 0)); // floodlight head
  } else if (shape === 'tvtower') {
    parts.push(new THREE.CylinderGeometry(b * 0.45, b, h * 0.75, 16).translate(0, h * 0.375, 0));
    parts.push(new THREE.CylinderGeometry(b * 1.6, b * 1.1, h * 0.06, 20).translate(0, h * 0.68, 0)); // pod
    parts.push(new THREE.CylinderGeometry(0.3, b * 0.3, h * 0.25, 8).translate(0, h * 0.875, 0));
  } else if (shape === 'chimney') {
    parts.push(new THREE.CylinderGeometry(b * 0.6, b, h, 16).translate(0, h / 2, 0));
  } else if (shape === 'water') {
    parts.push(new THREE.CylinderGeometry(b * 0.3, b * 0.35, h * 0.7, 12).translate(0, h * 0.35, 0));
    parts.push(new THREE.CylinderGeometry(b, b * 0.6, h * 0.3, 16).translate(0, h * 0.85, 0));
  } else {
    parts.push(new THREE.CylinderGeometry(b * 0.75, b, h, 4).rotateY(Math.PI / 4).translate(0, h / 2, 0));
  }

  const geometry = mergeIndexed(parts);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const bands = 11; // aviation marking: orange and white, orange at both ends
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    let c = shape === 'chimney' ? (y > h * 0.93 ? STEEL : BRICK) : shape === 'lattice' || shape === 'mast' ? STEEL : CONCRETE;
    if (spec.banded && y > h * 0.4) c = Math.floor((y / h) * bands) % 2 === 0 ? ORANGE : WHITE;
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function mergeIndexed(parts) {
  let count = 0, indexCount = 0;
  for (const p of parts) { count += p.attributes.position.count; indexCount += p.index.count; }
  const position = new Float32Array(count * 3), normal = new Float32Array(count * 3), index = new Uint32Array(indexCount);
  let vo = 0, io = 0;
  for (const p of parts) {
    position.set(p.attributes.position.array, vo * 3);
    normal.set(p.attributes.normal.array, vo * 3);
    for (let i = 0; i < p.index.count; i++) index[io + i] = p.index.array[i] + vo;
    vo += p.attributes.position.count;
    io += p.index.count;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

/**
 * Buildings without the pieces OSM uses to sketch a tower in 3D (floating sections, `building=roof`
 * legs) inside a tower's outline: the tower model replaces them. Pure, for tests.
 */
export function dropTowerParts(buildings, towers, originLat, originLng) {
  const big = (towers || []).filter((t) => t.width > 0).map((t) => ({ ...latLngToMeters(t.lat, t.lon, originLat, originLng), r: t.width / 2 }));
  if (!big.length) return buildings;
  return buildings.filter((b) => {
    const part = parseFloat(b.tags?.min_height) > 0 || b.tags?.building === 'roof';
    if (!part || !b.bounds) return true;
    const c = latLngToMeters((b.bounds.minLat + b.bounds.maxLat) / 2, (b.bounds.minLon + b.bounds.maxLon) / 2, originLat, originLng);
    return !big.some((t) => Math.hypot(c.x - t.x, c.z - t.z) < t.r);
  });
}

/**
 * Meshes and colliders for the towers whose centre is in this chunk.
 * @param {{ id: string, lat: number, lon: number, width: number, tags: object }[]} towers
 * @returns {THREE.Group | null} with userData.body (static feet)
 */
export function generateTowers(towers, elevationData, chunkWorldX, chunkWorldZ, originLat, originLng, base) {
  if (!towers?.length) return null;
  const group = new THREE.Group();
  group.name = 'towers';
  const body = new CANNON.Body({ mass: 0 });
  for (const tower of towers) {
    if (/roof/.test(tower.tags.location ?? '')) continue; // antennas on a roof are not drawn standing on the ground
    const spec = towerSpec(tower, Math.abs(originLat) < 25);
    const { x, z } = latLngToMeters(tower.lat, tower.lon, originLat, originLng);
    const y = getElevationAt(x - chunkWorldX, z - chunkWorldZ, elevationData, base);
    const geometry = spec.shape === 'chedi' ? mergeGeometries(chediGeometry(spec.height)) : towerGeometry(spec);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.sharedMaterial = true;
    mesh.userData.tower = spec.shape;
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    if (spec.banded) {
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.6, spec.height / 200), 8, 6), beaconMaterial);
      beacon.userData.sharedMaterial = true;
      beacon.position.set(x, y + spec.height, z);
      group.add(beacon);
    }

    // Colliders: the four feet of a lattice tower, otherwise the trunk
    if (spec.shape === 'lattice') {
      const foot = Math.max(1, spec.base * 0.08);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        body.addShape(new CANNON.Box(new CANNON.Vec3(foot, 5, foot)), new CANNON.Vec3(x + Math.cos(a) * (spec.base - foot), y + 5, z + Math.sin(a) * (spec.base - foot)));
      }
    } else {
      const r = spec.shape === 'water' ? spec.base * 0.35 : spec.base * 0.8;
      body.addShape(new CANNON.Box(new CANNON.Vec3(r, Math.min(spec.height, 30) / 2, r)), new CANNON.Vec3(x, y + Math.min(spec.height, 30) / 2, z));
    }
  }
  group.userData.body = body;
  return group;
}
