/**
 * NightLights.js — everything that glows after dark: building windows, street lamp bulbs and the
 * light pools under them. Shared materials, so one call per frame dims or lights the whole city.
 */

import * as THREE from 'three';

const hasDom = typeof document !== 'undefined'; // the verify script runs in Node without a canvas

/** Building materials currently alive; each removes itself when its chunk is disposed */
const buildingMaterials = new Set();
let level = 0;

const BULB_OFF = new THREE.Color(0x777766);
const BULB_ON = new THREE.Color(0xffe9a8);

export const lampBulbMaterial = new THREE.MeshBasicMaterial({ color: BULB_OFF.clone() });
export const lampPoleMaterial = new THREE.MeshStandardMaterial({ color: 0x8a8e93, roughness: 0.7, metalness: 0.1 }); // no env map: metal would render black
export const lampGlowMaterial = new THREE.MeshBasicMaterial({
  color: 0xffd27a,
  map: hasDom ? radialTexture() : null,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  polygonOffset: true,
  polygonOffsetFactor: -4,
  polygonOffsetUnits: -4,
});

/** @param {THREE.Material} material building material that has an emissive window map */
export function registerBuildingMaterial(material) {
  material.emissiveIntensity = level;
  buildingMaterials.add(material);
  material.addEventListener('dispose', () => buildingMaterials.delete(material));
}

/** @param {number} night 0 = full daylight .. 1 = dark night */
export function setNightLevel(night) {
  if (Math.abs(night - level) < 0.01) return;
  level = night;
  for (const m of buildingMaterials) m.emissiveIntensity = night;
  lampBulbMaterial.color.copy(BULB_OFF).lerp(BULB_ON, night);
  lampGlowMaterial.opacity = 0.55 * night;
}

// -------------------------------------------------------------------------------------------
// Window textures for building walls: 4 x 4 windows per tile, one window per 3 m floor
// -------------------------------------------------------------------------------------------

export const WINDOW_TILE_METERS = 12;
let windowTextures = null;

/** @returns {{ map: THREE.Texture, emissiveMap: THREE.Texture } | null} null outside the browser */
export function getWindowTextures() {
  if (!hasDom) return null;
  if (windowTextures) return windowTextures;

  const size = 256, cell = size / 4;
  const wall = document.createElement('canvas');
  const glow = document.createElement('canvas');
  wall.width = wall.height = glow.width = glow.height = size;
  const w = wall.getContext('2d');
  const g = glow.getContext('2d');
  w.fillStyle = '#ffffff'; // multiplied by the building's own colour
  w.fillRect(0, 0, size, size);
  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);

  // Fixed pattern so the city looks the same every visit
  const lit = [1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      // 1.2 x 1.3 m windows on a 3 m grid, light sky-reflecting glass with a thin frame
      const x = col * cell + cell * 0.3, y = row * cell + cell * 0.25;
      const ww = cell * 0.4, wh = cell * 0.43;
      w.fillStyle = '#5d6670';
      w.fillRect(x - 2, y - 2, ww + 4, wh + 4);
      w.fillStyle = '#a9bccd';
      w.fillRect(x, y, ww, wh);
      w.fillStyle = '#8a8f96';
      w.fillRect(x, y + wh, ww, 3); // sill
      if (lit[row * 4 + col]) {
        g.fillStyle = row % 2 ? '#ffd890' : '#fff0c8';
        g.fillRect(x, y, ww, wh);
      }
    }
  }

  const make = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / WINDOW_TILE_METERS, 1 / WINDOW_TILE_METERS);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  windowTextures = { map: make(wall, true), emissiveMap: make(glow, true) };
  return windowTextures;
}

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
