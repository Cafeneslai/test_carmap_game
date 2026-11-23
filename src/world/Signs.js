/**
 * Signs.js — a sign board with the real name over the door of every shop, restaurant, pharmacy,
 * bank... that OpenStreetMap names (shop/amenity nodes, and named shop buildings).
 * All boards of a chunk share one canvas atlas and one material; they light up at night.
 */

import * as THREE from 'three';
import { registerBuildingMaterial } from './NightLights.js';
import { THAI_FONT, GROUND_H } from './Facades.js';

const MAX_SIGNS = 96;
const ROW_PX = 64, ATLAS_W = 1024, ATLAS_ROWS = MAX_SIGNS / 2; // two signs per atlas row
const BOARD_H = 0.8;
const REACH = 25; // metres from a shop node to the wall it hangs on
const COLORS = {
  'amenity=pharmacy': ['#1d8a3a', '#ffffff'], 'amenity=bank': ['#0b3d91', '#ffffff'], 'amenity=fuel': ['#d71920', '#ffffff'],
  'amenity=cafe': ['#5b3a29', '#f3e2c7'], 'amenity=restaurant': ['#c8102e', '#ffe08a'], 'amenity=fast_food': ['#e85d04', '#ffffff'],
  'shop=convenience': ['#1d8a3a', '#ffffff'], 'shop=supermarket': ['#e85d04', '#ffffff'], 'shop=jewelry': ['#7a0a0a', '#f2c94c'],
};
const FALLBACK = [['#c8102e', '#ffffff'], ['#0057a8', '#ffffff'], ['#f2b705', '#8a1010'], ['#ffffff', '#c8102e'], ['#1d8a3a', '#ffffff']];

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Closest point on segment ab to p, and the distance */
function closest(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  const q = new THREE.Vector2(a.x + dx * t, a.y + dy * t);
  return { q, t, d: q.distanceTo(p) };
}

/**
 * Where each sign hangs: on the nearest building wall to its shop point, centred on the closest
 * point of that wall, facing outwards, just above the ground floor. One sign per wall. Pure, for tests.
 * @param {{ x: number, z: number, name: string, kind: string }[]} anchors
 * @param {{ pts: THREE.Vector2[], floorY: number }[]} rings closed building outlines (first point repeated)
 */
export function signPlacements(anchors, rings) {
  const used = new Set();
  const out = [];
  for (const a of anchors) {
    if (out.length >= MAX_SIGNS) break;
    const p = new THREE.Vector2(a.x, a.z);
    let best = null;
    rings.forEach((ring, r) => {
      for (let i = 0; i < ring.pts.length - 1; i++) {
        const c = closest(p, ring.pts[i], ring.pts[i + 1]);
        if (c.d < REACH && (!best || c.d < best.d)) best = { ...c, r, i };
      }
    });
    if (!best || used.has(`${best.r}:${best.i}`)) continue;
    used.add(`${best.r}:${best.i}`);
    const ring = rings[best.r];
    const A = ring.pts[best.i], B = ring.pts[best.i + 1];
    const len = A.distanceTo(B);
    const dir = B.clone().sub(A).normalize();
    // Outward: the side away from the outline's centre
    const centre = ring.pts.slice(0, -1).reduce((s, q) => s.add(q), new THREE.Vector2()).divideScalar(ring.pts.length - 1);
    let n = new THREE.Vector2(-dir.y, dir.x);
    if (n.dot(best.q.clone().sub(centre)) < 0) n = n.negate();
    const width = Math.min(Math.max(1.6, 0.42 * a.name.length + 0.8), 7, len * 0.9);
    if (width < 1.2) continue;
    // Keep the board on the wall
    const along = Math.min(Math.max(best.t * len, width / 2), len - width / 2);
    const c = A.clone().addScaledVector(dir, along).addScaledVector(n, 0.12);
    out.push({ name: a.name, kind: a.kind, x: c.x, z: c.y, y: ring.floorY + GROUND_H + 0.15 + BOARD_H / 2, width, nx: n.x, nz: n.y });
  }
  return out;
}

/** One mesh with every sign of a chunk; null without signs or outside the browser */
export function generateSigns(anchors, rings) {
  const signs = signPlacements(anchors, rings);
  if (!signs.length || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ROW_PX * Math.ceil(signs.length / 2);
  const ctx = canvas.getContext('2d');
  const pos = [], uv = [], nor = [], idx = [];
  signs.forEach((s, k) => {
    const col = k % 2, row = Math.floor(k / 2);
    const [bg, fg] = COLORS[s.kind] ?? FALLBACK[hash(s.name) % FALLBACK.length];
    const x0 = col * (ATLAS_W / 2), y0 = row * ROW_PX;
    ctx.fillStyle = bg;
    ctx.fillRect(x0, y0, ATLAS_W / 2, ROW_PX);
    ctx.strokeStyle = fg; ctx.lineWidth = 3;
    ctx.strokeRect(x0 + 4, y0 + 4, ATLAS_W / 2 - 8, ROW_PX - 8);
    ctx.fillStyle = fg;
    ctx.font = `bold ${ROW_PX * 0.55}px ${THAI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.name, x0 + ATLAS_W / 4, y0 + ROW_PX / 2 + 2, ATLAS_W / 2 - 24);

    // Quad facing (nx, nz); its right-hand edge is to the right when you look at it
    const rx = s.nz, rz = -s.nx; // right when facing -n (looking at the sign)
    const hw = s.width / 2, hh = BOARD_H / 2;
    const base = pos.length / 3;
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(s.x + rx * hw * u, s.y + hh * v, s.z + rz * hw * u);
      nor.push(s.nx, 0, s.nz);
    }
    const u0 = col / 2, u1 = u0 + 0.5, v1 = 1 - row / Math.ceil(signs.length / 2), v0 = 1 - (row + 1) / Math.ceil(signs.length / 2);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(idx);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const material = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, roughness: 0.6, side: THREE.DoubleSide });
  registerBuildingMaterial(material); // boards light up at night
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'signs';
  mesh.userData.ownTexture = true;
  return mesh;
}
