/**
 * ThaiTemple.js — Thai temple halls (ubosot, viharn, sala) and chedis.
 *
 * A temple hall: white walls under a steep roof in tiers that step down towards both gable ends,
 * orange tiles with a green tier, gilded gable boards and golden chofa horns on every gable tip.
 * A chedi: stepped square base, white bell, ringed spire and a golden tip.
 * Geometry is non-indexed with per-vertex colour, like the other building parts.
 */

import * as THREE from 'three';

const ORANGE = new THREE.Color(0xc8501e);
const GREEN = new THREE.Color(0x2f6b3c);
const GOLD = new THREE.Color(0xd9a520);
const WHITE = new THREE.Color(0xf2efe6);

/** Is this OSM building a Buddhist temple hall that should get a Thai roof? */
export function isThaiTemple(tags, tropical) {
  if (!tropical || !tags || tags.man_made === 'tower') return false;
  return tags.building === 'temple' || (tags.amenity === 'place_of_worship' && tags.religion === 'buddhist' && !!tags.building);
}

function colored(geometry, color) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  if (!g.attributes.normal) g.computeVertexNormals();
  const col = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) col.set([color.r, color.g, color.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Tiered roof over an oriented rectangle (BuildingGenerator's orientedRect: centre, long axis u, half sizes).
 * @returns {THREE.BufferGeometry[]}
 */
export function thaiTempleRoof(r, topY) {
  const out = [];
  const vx = -r.uz, vz = r.ux;
  const at = (u, v, y) => new THREE.Vector3(r.cx + r.ux * u + vx * v, y, r.cz + r.uz * u + vz * v);
  const hv = r.halfV * 1.15; // eaves overhang the walls
  const rise = Math.min(hv * 1.3, 14); // ~50° pitch
  const tiers = r.halfU > 9 ? 3 : r.halfU > 4 ? 2 : 1;
  const drop = rise * 0.22;
  const mid = new THREE.Vector3(r.cx, topY, r.cz);

  for (let k = 0; k < tiers; k++) {
    const hu = r.halfU * (tiers === 1 ? 1.05 : 0.62 + (0.43 * k) / (tiers - 1)); // lower tiers reach further out
    const ridge = topY + rise - k * drop, eave = topY - k * drop * 0.6;
    const half = hv * (ridge - eave) / rise; // same pitch on every tier
    const pos = [], gable = [];
    const tri = (list, a, b, c) => {
      const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
      const outw = a.clone().add(b).add(c).divideScalar(3).sub(mid);
      if (n.dot(outw) < 0) [b, c] = [c, b];
      list.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    };
    const c00 = at(-hu, -half, eave), c10 = at(hu, -half, eave), c11 = at(hu, half, eave), c01 = at(-hu, half, eave);
    const r0 = at(-hu, 0, ridge), r1 = at(hu, 0, ridge);
    tri(pos, c00, c10, r1); tri(pos, c00, r1, r0);
    tri(pos, c01, r0, r1); tri(pos, c01, r1, c11);
    // Gilded gable boards (na ban), set a little inside the tier's end so they show under the eave
    const g0 = at(-hu + 0.2, -half * 0.9, eave), g1 = at(-hu + 0.2, half * 0.9, eave), gr = at(-hu + 0.2, 0, ridge - 0.2);
    const h0 = at(hu - 0.2, -half * 0.9, eave), h1 = at(hu - 0.2, half * 0.9, eave), hr = at(hu - 0.2, 0, ridge - 0.2);
    tri(gable, g0, g1, gr); tri(gable, h0, hr, h1);
    for (const [list, color] of [[pos, k % 2 ? GREEN : ORANGE], [gable, GOLD]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
      g.computeVertexNormals();
      out.push(colored(g, color));
    }
    // Chofa: a golden horn on each gable tip, leaning outwards
    for (const sign of [-1, 1]) {
      const tip = at(sign * hu, 0, ridge);
      const horn = new THREE.ConeGeometry(0.18, Math.max(1, rise * 0.22), 6);
      horn.rotateZ(-sign * 0.5).rotateY(-Math.atan2(r.uz, r.ux));
      horn.translate(tip.x, tip.y + rise * 0.08, tip.z);
      out.push(colored(horn, GOLD));
    }
  }
  return out;
}

/** Wall height of a temple hall: tall single storey, lower than the roof above it */
export function templeWallHeight(tagsHeight, halfV) {
  return tagsHeight > 0 ? Math.min(tagsHeight * 0.4, 8) : Math.min(Math.max(3.5, halfV * 0.6), 7);
}

/**
 * Chedi (bell-shaped stupa) standing on the ground at (0, 0, 0), `height` metres tall.
 * @returns {THREE.BufferGeometry[]}
 */
export function chediGeometry(height) {
  const h = height, out = [];
  const b = h * 0.22; // half width of the lowest terrace
  // Three stepped square terraces
  for (let i = 0; i < 3; i++) {
    const s = b * (1 - i * 0.18), y0 = h * 0.06 * i;
    out.push(colored(new THREE.BoxGeometry(s * 2, h * 0.06, s * 2).translate(0, y0 + h * 0.03, 0), WHITE));
  }
  // Bell (anda) and the square throne (harmika) on top of it
  const bell = [[0, 0], [b * 0.62, 0], [b * 0.66, h * 0.05], [b * 0.6, h * 0.16], [b * 0.42, h * 0.25], [0, h * 0.28]].map(([x, y]) => new THREE.Vector2(x, y));
  out.push(colored(new THREE.LatheGeometry(bell, 20).translate(0, h * 0.18, 0), WHITE));
  out.push(colored(new THREE.BoxGeometry(b * 0.5, h * 0.05, b * 0.5).translate(0, h * 0.47, 0), WHITE));
  // Ringed spire (plong chanai) and gold tip
  out.push(colored(new THREE.CylinderGeometry(b * 0.06, b * 0.22, h * 0.3, 12, 6).translate(0, h * 0.64, 0), GOLD));
  out.push(colored(new THREE.CylinderGeometry(0.02, b * 0.06, h * 0.2, 8).translate(0, h * 0.89, 0), GOLD));
  return out;
}
