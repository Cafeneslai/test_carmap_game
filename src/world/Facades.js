/**
 * Facades.js — what a building's walls look like, by what kind of building it is:
 * Thai shophouses (ตึกแถว) with shop shutters and sign boards, apartments with balconies and AC units,
 * glass offices, corrugated warehouses, schools/hospitals with ribbon windows, and houses.
 *
 * Every style has an upper-floor texture (2 floors, 12 m wide) and a ground-floor texture (one 3 m
 * band, 12 m wide), each with a matching night-glow map. Materials are shared by the whole city.
 */

import * as THREE from 'three';
import { registerBuildingMaterial } from './NightLights.js';

const hasDom = typeof document !== 'undefined';
export const TILE_W = 12;          // metres per texture repeat along the wall
export const UPPER_TILE_H = 6;     // two 3 m floors per repeat up the wall
export const GROUND_H = 3;         // height of the ground floor above the street
export const WALL_SINK = 0.5;      // walls start this far below the ground (no gaps on slopes)
const GROUND_TILE_H = GROUND_H + WALL_SINK;
const PX = 256 / TILE_W;           // texture pixels per metre

export const STYLES = ['generic', 'house', 'shophouse', 'apartment', 'office', 'industrial', 'civic'];

const HOUSE = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'cabin', 'farm', 'hut', 'villa']);
const SHOP = new Set(['retail', 'terrace', 'shop', 'kiosk', 'supermarket']);
const FLATS = new Set(['apartments', 'dormitory', 'hotel', 'residential', 'condominium']);
const OFFICE = new Set(['office', 'commercial', 'bank']);
const INDUSTRY = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'hangar', 'storage', 'garages', 'service', 'barn', 'shed']);
const CIVIC = new Set(['school', 'university', 'college', 'kindergarten', 'hospital', 'public', 'government', 'civic', 'train_station', 'transportation', 'sports_hall']);

/**
 * Pick the facade style from the OSM tags, the height and the footprint.
 * @param {object} tags
 * @param {{ floors: number, area: number, ratio: number, tropical: boolean }} info
 *   area in m², ratio = long side / short side of the footprint
 */
export function facadeStyle(tags = {}, { floors, area, ratio, tropical, landuse = null, onStreet = false }) {
  const b = tags.building;
  const shopOnGround = !!tags.shop || tags['building:use'] === 'retail';
  if (HOUSE.has(b)) return 'house';
  if (INDUSTRY.has(b)) return 'industrial';
  if (CIVIC.has(b) || tags.amenity === 'school' || tags.amenity === 'hospital') return 'civic';
  if (SHOP.has(b) || shopOnGround) return floors <= 6 ? 'shophouse' : 'office';
  if (OFFICE.has(b)) return floors <= 4 && tropical ? 'shophouse' : 'office';
  if (FLATS.has(b)) return floors <= 2 && area < 250 ? 'house' : 'apartment';
  if (floors >= 12) return 'office';
  // Untagged footprints (most Overture ones) take their style from the area they stand in
  if (/school|university|college|hospital|kindergarten/.test(landuse) && area > 120) return 'civic';
  if (/industrial|railway/.test(landuse)) return area > 300 ? 'industrial' : 'generic';
  if (/retail|commercial/.test(landuse)) return floors >= 6 ? 'office' : tropical ? 'shophouse' : 'generic';
  if (floors >= 6) return 'apartment';
  // Untagged ("yes"): small and low is a house; in the tropics a narrow 2-5 floor block is a shophouse row
  if (area < 160 && floors <= 2) return 'house';
  // in the tropics a 2-5 floor block that is narrow, or fronts a main street, is a shophouse row
  if (tropical && floors >= 2 && floors <= 5.5 && ((area < 900 && ratio >= 2.2) || (onStreet && area < 1500))) return 'shophouse';
  if (area > 2500 && floors <= 2) return 'industrial';
  return 'generic';
}

/** Wall colours per style (sRGB); picked by building id. building:colour wins when tagged. */
export const WALL_COLORS = {
  generic: [0xf2ede4, 0xe6dccb, 0xd9d4ca, 0xcfd8e0, 0xe4d7c2],
  house: [0xf4efe6, 0xefe2c9, 0xe9d9c4, 0xdfe6e1, 0xf1e4d8],
  // Thai shophouses: cream, pale yellow, salmon, mint, sky blue, weathered grey
  shophouse: [0xf0e3c4, 0xf3d98f, 0xe9b9a0, 0xc9e0c8, 0xbcd5e6, 0xcfcac0, 0xf2efe8],
  apartment: [0xf4f1ea, 0xe8e2d6, 0xdcd8d0, 0xeadccd],
  office: [0xe9ecef, 0xdfe3e7, 0xd2d6da],
  industrial: [0xd6dbe0, 0xc8d0d6, 0xe2e0da, 0xb9c4cc],
  civic: [0xf3ecd9, 0xf1f0ea, 0xe9dcc2, 0xe8e4f0],
};

/** Flat roof colours (sRGB) */
export const ROOF_FLAT = {
  industrial: [0x9aa3aa, 0x8e979e, 0xa78b6f],      // sheet metal, some rusty
  default: [0x9b9a95, 0x8f8e89, 0xa6a39b, 0x85837e], // concrete
};

// ---------------------------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------------------------

function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** Two canvases (colour, glow) with a y-up metre coordinate system */
function canvases(heightM, lift = 0) {
  const make = () => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = Math.round(heightM * PX);
    const ctx = c.getContext('2d');
    ctx.setTransform(PX, 0, 0, -PX, 0, c.height); // x right, y up, in metres
    ctx.translate(0, lift); // the ground tile starts underground: its drawings sit on the street level
    return { c, ctx };
  };
  const wall = make(), glow = make();
  wall.ctx.fillStyle = '#ffffff'; // multiplied by the building's own colour
  wall.ctx.fillRect(0, -lift, TILE_W, heightM);
  glow.ctx.fillStyle = '#000000';
  glow.ctx.fillRect(0, -lift, TILE_W, heightM);
  if (lift) { wall.ctx.fillStyle = '#9b978f'; wall.ctx.fillRect(0, -lift, TILE_W, lift + 0.08); } // plinth
  return { wall: wall.ctx, glow: glow.ctx, canvases: [wall.c, glow.c] };
}

const GLASS = '#a9bccd', FRAME = '#5d6670', SILL = '#8a8f96', DARK = '#3a3f45';

function windowAt(w, g, x, y, ww, wh, lit, warm = true) {
  w.fillStyle = FRAME; w.fillRect(x - 0.06, y - 0.06, ww + 0.12, wh + 0.12);
  w.fillStyle = GLASS; w.fillRect(x, y, ww, wh);
  w.fillStyle = 'rgba(255,255,255,0.25)'; w.fillRect(x, y + wh * 0.55, ww * 0.45, wh * 0.4); // sky reflection
  w.fillStyle = FRAME; w.fillRect(x + ww / 2 - 0.03, y, 0.06, wh); // mullion
  w.fillStyle = SILL; w.fillRect(x - 0.1, y - 0.12, ww + 0.2, 0.1);
  if (lit) { g.fillStyle = warm ? '#e9bd78' : '#c9d4e6'; g.fillRect(x, y, ww, wh); }
}

function acUnit(w, x, y) {
  w.fillStyle = '#e6e6e2'; w.fillRect(x, y, 0.8, 0.55);
  w.fillStyle = '#9a9a96'; w.beginPath(); w.arc(x + 0.5, y + 0.27, 0.18, 0, Math.PI * 2); w.fill();
}

const UPPER = {
  generic(w, g, r) {
    for (let f = 0; f < 2; f++) for (let i = 0; i < 4; i++) windowAt(w, g, i * 3 + 0.9, f * 3 + 0.9, 1.2, 1.4, r() < 0.3);
  },
  house(w, g, r) {
    for (let f = 0; f < 2; f++) for (let i = 0; i < 2; i++) {
      const x = i * 6 + 2.2, y = f * 3 + 1;
      w.fillStyle = '#7b5a43'; w.fillRect(x - 0.5, y - 0.05, 0.4, 1.4); w.fillRect(x + 1.4, y - 0.05, 0.4, 1.4); // shutters
      windowAt(w, g, x, y, 1.2, 1.3, r() < 0.45);
    }
  },
  shophouse(w, g, r) {
    // 3 bays of ~4 m; a pilaster between bays, a wide window with a grille, AC units, a ledge per floor
    for (let f = 0; f < 2; f++) {
      const y0 = f * 3;
      w.fillStyle = 'rgba(0,0,0,0.12)'; w.fillRect(0, y0, TILE_W, 0.18); // floor ledge
      for (let b = 0; b < 3; b++) {
        const x0 = b * 4;
        w.fillStyle = 'rgba(0,0,0,0.08)'; w.fillRect(x0, y0, 0.25, 3); // pilaster
        windowAt(w, g, x0 + 0.7, y0 + 0.9, 2.6, 1.5, r() < 0.3);
        w.strokeStyle = '#4a4f55'; w.lineWidth = 0.05; // window grille
        for (let k = 1; k < 6; k++) { w.beginPath(); w.moveTo(x0 + 0.7 + k * 0.43, y0 + 0.9); w.lineTo(x0 + 0.7 + k * 0.43, y0 + 2.4); w.stroke(); }
        if (r() < 0.5) acUnit(w, x0 + 2.9 - r() * 2, y0 + 0.25);
        if (r() < 0.25) { w.fillStyle = '#c9c4b8'; w.fillRect(x0 + 0.6, y0 + 2.55, 2.8, 0.15); } // awning lip
      }
    }
  },
  apartment(w, g, r) {
    for (let f = 0; f < 2; f++) {
      const y0 = f * 3;
      for (let b = 0; b < 4; b++) {
        const x0 = b * 3;
        windowAt(w, g, x0 + 0.4, y0 + 0.75, 1.0, 1.7, r() < 0.35); // balcony door
        windowAt(w, g, x0 + 1.75, y0 + 1.1, 0.9, 1.1, r() < 0.3);
        // Balcony slab and railing
        w.fillStyle = '#cfcac0'; w.fillRect(x0 + 0.15, y0 + 0.55, 2.7, 0.2);
        w.fillStyle = 'rgba(90,95,100,0.55)'; w.fillRect(x0 + 0.15, y0 + 1.5, 2.7, 0.06);
        for (let k = 0; k < 10; k++) w.fillRect(x0 + 0.2 + k * 0.28, y0 + 0.75, 0.04, 0.75);
        if (r() < 0.35) acUnit(w, x0 + 1.9, y0 + 0.78);
        if (r() < 0.2) { w.fillStyle = ['#c0504d', '#4f81bd', '#e8e0c0'][Math.floor(r() * 3)]; w.fillRect(x0 + 0.5, y0 + 1.0, 0.8, 0.4); } // laundry
      }
    }
  },
  office(w, g, r) {
    // Curtain wall: glass with mullions every 1.5 m and a dark spandrel at each floor
    w.fillStyle = '#7f97ad'; w.fillRect(0, 0, TILE_W, UPPER_TILE_H);
    const grad = w.createLinearGradient(0, 0, 0, UPPER_TILE_H);
    grad.addColorStop(0, 'rgba(255,255,255,0.05)'); grad.addColorStop(1, 'rgba(255,255,255,0.22)');
    w.fillStyle = grad; w.fillRect(0, 0, TILE_W, UPPER_TILE_H);
    for (let f = 0; f < 2; f++) {
      w.fillStyle = '#4c5966'; w.fillRect(0, f * 3, TILE_W, 0.7);
      for (let i = 0; i < 8; i++) if (r() < 0.35) { g.fillStyle = '#eef3ff'; g.fillRect(i * 1.5 + 0.05, f * 3 + 0.7, 1.4, 2.3); }
    }
    w.fillStyle = '#c9d0d6';
    for (let i = 0; i <= 8; i++) w.fillRect(i * 1.5 - 0.04, 0, 0.08, UPPER_TILE_H);
  },
  industrial(w, g, r) {
    // Corrugated sheet: thin vertical ribs; one band of high windows
    for (let x = 0; x < TILE_W; x += 0.25) { w.fillStyle = 'rgba(0,0,0,0.07)'; w.fillRect(x, 0, 0.1, UPPER_TILE_H); }
    for (let i = 0; i < 6; i++) windowAt(w, g, i * 2 + 0.4, 4.2, 1.2, 0.7, r() < 0.2, false);
    w.fillStyle = 'rgba(0,0,0,0.1)'; w.fillRect(0, 0, TILE_W, 0.12);
  },
  civic(w, g, r) {
    // Long ribbon windows between solid floor bands, like Thai schools and hospitals
    for (let f = 0; f < 2; f++) {
      const y0 = f * 3;
      w.fillStyle = 'rgba(0,0,0,0.1)'; w.fillRect(0, y0 + 0.75, TILE_W, 0.12);
      w.fillStyle = FRAME; w.fillRect(0, y0 + 0.95, TILE_W, 1.5);
      w.fillStyle = GLASS; w.fillRect(0, y0 + 1.0, TILE_W, 1.4);
      w.fillStyle = 'rgba(255,255,255,0.2)'; w.fillRect(0, y0 + 1.75, TILE_W, 0.5);
      w.fillStyle = FRAME;
      for (let i = 0; i <= 8; i++) w.fillRect(i * 1.5 - 0.03, y0 + 1.0, 0.06, 1.4);
      for (let i = 0; i < 8; i++) if (r() < 0.3) { g.fillStyle = '#f4f7ff'; g.fillRect(i * 1.5 + 0.05, y0 + 1.0, 1.4, 1.4); }
    }
  },
};

const SIGN_COLORS = ['#c8102e', '#0057a8', '#f2b705', '#1d8a3a', '#e85d04', '#ffffff'];

const GROUND = {
  generic(w, g, r) {
    w.fillStyle = 'rgba(0,0,0,0.12)'; w.fillRect(0, 0, TILE_W, 0.4); // plinth
    for (let i = 0; i < 4; i++) {
      if (i === 1) { w.fillStyle = '#5b4636'; w.fillRect(i * 3 + 0.9, 0, 1.2, 2.2); }
      else windowAt(w, g, i * 3 + 0.9, 0.9, 1.2, 1.4, r() < 0.4);
    }
  },
  house(w, g, r) {
    w.fillStyle = 'rgba(0,0,0,0.1)'; w.fillRect(0, 0, TILE_W, 0.35);
    w.fillStyle = '#6b4a33'; w.fillRect(2, 0, 1.0, 2.2);           // front door
    w.fillStyle = '#8a6a50'; w.fillRect(2.1, 0.1, 0.8, 2.0);
    windowAt(w, g, 4.5, 0.9, 1.6, 1.3, r() < 0.5);
    windowAt(w, g, 8.5, 0.9, 1.6, 1.3, r() < 0.5);
  },
  shophouse(w, g, r) {
    // Each 4 m bay: a sign board on top, then a rolled-down shutter or an open, lit shop
    for (let b = 0; b < 3; b++) {
      const x0 = b * 4;
      w.fillStyle = 'rgba(0,0,0,0.1)'; w.fillRect(x0, 0, 0.25, GROUND_H);
      w.fillStyle = SIGN_COLORS[(b * 2 + Math.floor(r() * 2)) % SIGN_COLORS.length];
      w.fillRect(x0 + 0.3, 2.45, 3.4, 0.5);
      w.fillStyle = 'rgba(255,255,255,0.75)'; // lettering stripes
      for (let k = 0; k < 4; k++) w.fillRect(x0 + 0.6 + k * 0.75, 2.6, 0.5, 0.18);
      if (r() < 0.45) {
        // Steel roller shutter
        w.fillStyle = '#a7abae'; w.fillRect(x0 + 0.3, 0, 3.4, 2.4);
        w.fillStyle = 'rgba(0,0,0,0.12)';
        for (let y = 0.1; y < 2.4; y += 0.12) w.fillRect(x0 + 0.3, y, 3.4, 0.04);
      } else {
        // Open shop: dark interior, goods on shelves, lit at night
        w.fillStyle = '#2f3235'; w.fillRect(x0 + 0.3, 0, 3.4, 2.4);
        for (let s = 0; s < 3; s++) {
          w.fillStyle = ['#b85c38', '#d9c27b', '#4f7cac', '#7da453'][Math.floor(r() * 4)];
          w.fillRect(x0 + 0.5, 0.5 + s * 0.6, 3.0, 0.35);
        }
        g.fillStyle = '#f2cf92'; g.fillRect(x0 + 0.3, 0, 3.4, 2.4);
        g.fillStyle = '#ffffff'; g.fillRect(x0 + 0.3, 2.45, 3.4, 0.5); // sign lights up
      }
    }
  },
  apartment(w, g, r) {
    w.fillStyle = '#c9c4ba'; w.fillRect(0, 0, TILE_W, 0.5);
    for (let i = 0; i < 4; i++) {
      w.fillStyle = '#bdb7ac'; w.fillRect(i * 3, 0, 0.4, GROUND_H); // columns
      w.fillStyle = '#56636e'; w.fillRect(i * 3 + 0.6, 0.5, 1.8, 2.1); // lobby glass
      w.fillStyle = 'rgba(255,255,255,0.2)'; w.fillRect(i * 3 + 0.6, 1.6, 0.8, 1.0);
      g.fillStyle = '#ffe9c0'; if (r() < 0.6) g.fillRect(i * 3 + 0.6, 0.5, 1.8, 2.1);
    }
  },
  office(w, g, r) {
    w.fillStyle = '#4e5d6b'; w.fillRect(0, 0, TILE_W, GROUND_H);
    w.fillStyle = 'rgba(255,255,255,0.15)'; w.fillRect(0, 1.6, TILE_W, 1.2);
    w.fillStyle = '#c9d0d6';
    for (let i = 0; i <= 4; i++) w.fillRect(i * 3 - 0.08, 0, 0.16, GROUND_H);
    w.fillRect(0, 2.75, TILE_W, 0.25);
    g.fillStyle = '#f2f5ff'; for (let i = 0; i < 4; i++) if (r() < 0.7) g.fillRect(i * 3 + 0.1, 0, 2.8, 2.7);
  },
  industrial(w, g, r) {
    for (let x = 0; x < TILE_W; x += 0.25) { w.fillStyle = 'rgba(0,0,0,0.07)'; w.fillRect(x, 0, 0.1, GROUND_H); }
    // A big roller door per tile, and a small side door
    w.fillStyle = '#9ea4a8'; w.fillRect(2, 0, 4.5, 2.9);
    w.fillStyle = 'rgba(0,0,0,0.14)'; for (let y = 0.1; y < 2.9; y += 0.15) w.fillRect(2, y, 4.5, 0.05);
    w.fillStyle = '#e1b12c'; w.fillRect(1.9, 0, 0.1, 2.9); w.fillRect(6.5, 0, 0.1, 2.9); // safety posts
    w.fillStyle = '#56606a'; w.fillRect(9, 0, 1, 2.1);
    if (r() < 0.3) { g.fillStyle = '#fff4d0'; g.fillRect(9, 0, 1, 2.1); }
  },
  civic(w, g, r) {
    // Open corridor behind columns, as in Thai school buildings
    w.fillStyle = '#5a5e60'; w.fillRect(0, 0, TILE_W, 2.6);
    w.fillStyle = 'rgba(255,255,255,0.1)'; w.fillRect(0, 0, TILE_W, 0.3);
    for (let i = 0; i < 3; i++) {
      w.fillStyle = '#efe9da'; w.fillRect(i * 4, 0, 0.45, GROUND_H); // columns (tinted by wall colour)
      windowAt(w, g, i * 4 + 1.4, 0.9, 1.6, 1.2, r() < 0.5, false); // classroom windows at the back
    }
    w.fillStyle = '#efe9da'; w.fillRect(0, 2.6, TILE_W, 0.4); // beam
  },
};

let materials = null;

function texture(canvas, repeatY, clampY = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  // The ground band can reach far below the floor on a slope: clamp so it shows more plinth there
  t.wrapT = clampY ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.repeat.set(1 / TILE_W, 1 / repeatY); // uv is in metres
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Shared materials: `plain` for roofs, then { upper, ground } per style.
 * Outside the browser (verify script) they have no textures.
 */
export function getFacadeMaterials() {
  if (materials) return materials;
  const make = (map, emissiveMap) => {
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.8, metalness: 0.05, flatShading: true,
      map, emissive: emissiveMap ? 0xffffff : 0x000000, emissiveMap,
    });
    if (emissiveMap) registerBuildingMaterial(m); // windows and shops light up at night
    return m;
  };
  materials = { plain: make(null, null) };
  STYLES.forEach((style, si) => {
    if (!hasDom) {
      materials[style] = { upper: materials.plain, ground: materials.plain };
      return;
    }
    const up = canvases(UPPER_TILE_H);
    UPPER[style](up.wall, up.glow, seeded(101 + si * 7));
    const gr = canvases(GROUND_TILE_H, WALL_SINK);
    GROUND[style](gr.wall, gr.glow, seeded(211 + si * 13));
    materials[style] = {
      upper: make(texture(up.canvases[0], UPPER_TILE_H), texture(up.canvases[1], UPPER_TILE_H)),
      ground: make(texture(gr.canvases[0], GROUND_TILE_H, true), texture(gr.canvases[1], GROUND_TILE_H, true)),
    };
  });
  return materials;
}
