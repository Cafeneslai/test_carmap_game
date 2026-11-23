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
