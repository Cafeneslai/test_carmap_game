/**
 * Vehicles.js — NPC vehicle models. Everywhere: cars. In Thailand (and its neighbours) the street
 * mix is Thai: pickups, motorbikes with helmeted riders keeping to the kerb, tuk-tuks, songthaews
 * (pickup taxis with a roofed bench bed) and colourful metered taxis with a roof sign.
 * Every model faces +Z, sits on y = 0 and comes with a collider half-size.
 */

import * as THREE from 'three';

const mat = new Map();
/** Shared material per colour (NPCs come and go; materials are never disposed) */
function m(color, roughness = 0.5) {
  const key = `${color}:${roughness}`;
  if (!mat.has(key)) mat.set(key, new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.1 }));
  return mat.get(key);
}
const glass = () => m(0x3b4f63, 0.2);
const tyre = () => m(0x111111, 0.9);
const headMat = new THREE.MeshBasicMaterial({ color: 0xfff4d0 });
const tailMat = new THREE.MeshBasicMaterial({ color: 0xaa1010 });

const geo = new Map();
/** Shared box geometry per size and position */
function box(w, h, d, x = 0, y = 0, z = 0) {
  const key = [w, h, d, x, y, z].join(',');
  if (!geo.has(key)) geo.set(key, new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  return geo.get(key);
}
const wheelGeo = new Map();
function wheel(r, w) {
  const key = `${r},${w}`;
  if (!wheelGeo.has(key)) wheelGeo.set(key, new THREE.CylinderGeometry(r, r, w, 12).rotateZ(Math.PI / 2));
  return wheelGeo.get(key);
}

function part(group, geometry, material, shadow = true) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = shadow;
  group.add(mesh);
  return mesh;
}
function wheels(group, r, w, spots) {
  for (const [x, z] of spots) part(group, wheel(r, w), tyre(), false).position.set(x, r, z);
}
function lamps(group, x, yHead, zFront, yTail, zBack) {
  for (const s of [-x, x]) {
    part(group, box(0.32, 0.14, 0.05), headMat, false).position.set(s, yHead, zFront);
    part(group, box(0.32, 0.14, 0.05), tailMat, false).position.set(s, yTail, zBack);
  }
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const CAR_COLORS = [0xd8d8d8, 0x1d1f24, 0x8a1c1c, 0x1f4f8a, 0x9aa0a6, 0xe8e2d0, 0x2f5f3a];
const PICKUP_COLORS = [0xeeeeee, 0xc9cbcd, 0x2a2c30, 0x7b8188, 0x8c1b1b, 0x274d7a];
// Bangkok taxi liveries: pink, green-yellow, orange, blue, red-blue
const TAXI_LIVERIES = [[0xe8508f, 0xe8508f], [0x3aa655, 0xf2d031], [0xf07a1f, 0xf07a1f], [0x2a62b8, 0x2a62b8], [0xc8282e, 0x2a62b8]];
const TUKTUK_COLORS = [0x1f5fb0, 0x2c8a3e, 0xc22a2a, 0xe0b420, 0x20808a];
const SONGTHAEW_COLORS = [0xb3202a, 0x2a62b8, 0xe8e8e8, 0x3d8a3d];

const BUILD = {
  car() {
    const g = new THREE.Group();
    part(g, box(1.8, 0.7, 4.2, 0, 0.6, 0), m(pick(CAR_COLORS), 0.45));
    part(g, box(1.6, 0.6, 2.1, 0, 1.25, -0.2), glass());
    wheels(g, 0.33, 0.25, [[-0.85, 1.3], [0.85, 1.3], [-0.85, -1.3], [0.85, -1.3]]);
    lamps(g, 0.6, 0.7, 2.11, 0.75, -2.11);
    return { mesh: g, half: [0.9, 0.55, 2.1] };
  },
  taxi() {
    const [low, top] = pick(TAXI_LIVERIES);
    const g = new THREE.Group();
    part(g, box(1.75, 0.4, 4.4, 0, 0.45, 0), m(low, 0.4));
    part(g, box(1.75, 0.32, 4.4, 0, 0.81, 0), m(top, 0.4));
    part(g, box(1.55, 0.55, 2.2, 0, 1.25, -0.2), glass());
    part(g, box(0.7, 0.22, 0.35, 0, 1.64, -0.1), m(0xfafafa, 0.3)); // TAXI-METER roof sign
    wheels(g, 0.32, 0.24, [[-0.83, 1.35], [0.83, 1.35], [-0.83, -1.35], [0.83, -1.35]]);
    lamps(g, 0.6, 0.62, 2.21, 0.7, -2.21);
    return { mesh: g, half: [0.88, 0.55, 2.2] };
  },
  pickup() {
    const color = m(pick(PICKUP_COLORS), 0.45);
    const g = new THREE.Group();
    part(g, box(1.85, 0.75, 5.2, 0, 0.75, 0), color);
    part(g, box(1.75, 0.65, 2.2, 0, 1.45, 0.75), glass()); // cab
    part(g, box(1.75, 0.1, 2.3, 0, 1.15, -1.45), m(0x222222, 0.8)); // open bed floor
    for (const s of [-0.9, 0.9]) part(g, box(0.06, 0.4, 2.3, s, 1.33, -1.45), color);
    part(g, box(1.85, 0.4, 0.06, 0, 1.33, -2.6), color); // tailgate
    wheels(g, 0.38, 0.27, [[-0.88, 1.65], [0.88, 1.65], [-0.88, -1.6], [0.88, -1.6]]);
    lamps(g, 0.65, 0.95, 2.61, 1.0, -2.63);
    return { mesh: g, half: [0.93, 0.8, 2.6] };
  },
  songthaew() {
    const { mesh: g, half } = BUILD.pickup();
    const color = m(pick(SONGTHAEW_COLORS), 0.45);
    part(g, box(1.95, 0.12, 2.9, 0, 2.3, -1.25), color); // roof over the bed
    for (const [x, z] of [[-0.93, -2.6], [0.93, -2.6], [-0.93, 0.1], [0.93, 0.1]]) part(g, box(0.06, 1.1, 0.06, x, 1.75, z), color);
    for (const s of [-0.65, 0.65]) part(g, box(0.4, 0.4, 2.3, s, 1.4, -1.4), m(0x5a3a26, 0.8)); // benches
    return { mesh: g, half: [half[0], 1.1, half[2]] };
  },
  tuktuk() {
    const color = m(pick(TUKTUK_COLORS), 0.4);
    const g = new THREE.Group();
    part(g, box(1.3, 0.45, 2.1, 0, 0.55, -0.3), color);           // passenger tub
    part(g, box(0.75, 0.55, 0.8, 0, 0.6, 1.0), color);            // driver's nose
    part(g, box(1.4, 0.08, 2.6, 0, 1.85, -0.1), m(0x1d1d1d, 0.7)); // canopy
    part(g, box(1.42, 0.25, 2.62, 0, 1.72, -0.1), color);          // canopy trim
    for (const [x, z] of [[-0.62, 1.05], [0.62, 1.05], [-0.62, -1.3], [0.62, -1.3]]) part(g, box(0.05, 1.1, 0.05, x, 1.25, z), m(0xb8b8b8, 0.3));
    part(g, box(1.1, 0.3, 0.6, 0, 0.95, -0.8), m(0x8a1c1c, 0.8));  // seat
    wheels(g, 0.27, 0.18, [[0, 1.15], [-0.6, -1.0], [0.6, -1.0]]);
    part(g, box(0.25, 0.15, 0.05, 0, 0.85, 1.41), headMat, false);
    for (const s of [-0.55, 0.55]) part(g, box(0.2, 0.12, 0.05, s, 0.6, -1.36), tailMat, false);
    return { mesh: g, half: [0.68, 0.95, 1.45] };
  },
  motorbike() {
    const g = new THREE.Group();
    part(g, box(0.3, 0.35, 1.3, 0, 0.6, 0), m(pick([0xc8282e, 0x1d1f24, 0x2a62b8, 0xe8e8e8, 0x3d8a3d]), 0.4));
    part(g, box(0.28, 0.12, 0.7, 0, 0.85, -0.2), m(0x111111, 0.8)); // seat
    wheels(g, 0.3, 0.1, [[0, 0.7], [0, -0.65]]);
    // Rider: shirt, legs, arms to the bars, helmet
    part(g, box(0.42, 0.6, 0.28, 0, 1.25, -0.15), m(pick([0x2f6fb5, 0xe2e2e2, 0xd88a2a, 0x2f8f6f, 0x7a2a8a]), 0.9));
    part(g, box(0.34, 0.2, 0.55, 0, 0.92, 0.05), m(0x2b2f3a, 0.9));
    part(g, box(0.5, 0.1, 0.45, 0, 1.4, 0.2), m(0x2f6fb5, 0.9));
    const helmet = part(g, new THREE.SphereGeometry(0.17, 10, 8), m(pick([0xf2f2f2, 0x1a1a1a, 0xd8262e, 0xf2c200]), 0.3));
    helmet.position.set(0, 1.72, -0.1);
    part(g, box(0.15, 0.1, 0.05, 0, 0.85, 0.66), headMat, false);
    part(g, box(0.12, 0.08, 0.05, 0, 0.75, -0.66), tailMat, false);
    return { mesh: g, half: [0.35, 0.9, 1.0] };
  },
};

// Street mix [kind, weight]; Thai roads are roughly a third motorbikes
const THAI_MIX = [['car', 30], ['pickup', 20], ['motorbike', 28], ['taxi', 8], ['tuktuk', 8], ['songthaew', 6]];
const SPEED = { car: 1, taxi: 1, pickup: 0.95, songthaew: 0.8, tuktuk: 0.7, motorbike: 0.9 };
/** Metres a vehicle keeps towards the kerb from its lane centre (motorbikes ride the edge) */
export const KERB_SHIFT = { motorbike: 1.0 };

/** Which kind of vehicle to spawn; `random` in [0, 1) */
export function pickKind(thai, random = Math.random()) {
  if (!thai) return 'car';
  let r = random * THAI_MIX.reduce((n, [, w]) => n + w, 0);
  for (const [kind, w] of THAI_MIX) if ((r -= w) < 0) return kind;
  return 'car';
}

/** @returns {{ mesh: THREE.Group, half: number[], speed: number, kind: string }} */
export function buildVehicle(kind) {
  const v = BUILD[kind]();
  return { ...v, speed: SPEED[kind], kind };
}
