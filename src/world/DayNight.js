/**
 * DayNight.js — moves the sun through a 24 h day and tints sky, fog and lights to match.
 */

import * as THREE from 'three';

export const DAY_LENGTH_SECONDS = 600; // one full game day = 10 real minutes
const START_HOUR = 9;
const NOON_HOUR = 12;

const NIGHT_SKY = new THREE.Color(0x0b1026);
const DUSK_SKY = new THREE.Color(0xf08a4b);
const DAY_SKY = new THREE.Color(0x87ceeb);
const SUN_LOW = new THREE.Color(0xffb070);
const SUN_HIGH = new THREE.Color(0xfff4e6);

/**
 * Lighting for an hour of the day. Pure, so it can be checked without a renderer.
 * @param {number} hour 0..24
 * @returns {{ elevation: number, azimuth: number, daylight: number, sky: THREE.Color, sunColor: THREE.Color }}
 *   elevation: sine of the sun's height (-1..1); daylight: 0 at night .. 1 at noon
 */
export function lightingAt(hour) {
  const angle = ((hour - 6) / 12) * Math.PI; // 0 at 06:00 (sunrise), PI at 18:00 (sunset)
  const elevation = Math.sin(angle);
  const daylight = THREE.MathUtils.smoothstep(elevation, -0.1, 0.35);

  const sky = new THREE.Color();
  if (elevation < 0.15) {
    // Night -> dusk glow around the horizon
    sky.copy(NIGHT_SKY).lerp(DUSK_SKY, THREE.MathUtils.smoothstep(elevation, -0.15, 0.05));
  } else {
    sky.copy(DUSK_SKY).lerp(DAY_SKY, THREE.MathUtils.smoothstep(elevation, 0.05, 0.4));
  }
  const sunColor = SUN_LOW.clone().lerp(SUN_HIGH, THREE.MathUtils.clamp(elevation * 2, 0, 1));
  return { elevation, azimuth: angle, daylight, sky, sunColor };
}

export class DayNight {
  /**
   * @param {{ scene: THREE.Scene, sun: THREE.DirectionalLight, ambient: THREE.AmbientLight, hemi: THREE.HemisphereLight }} parts
   */
  constructor({ scene, sun, ambient, hemi }) {
    this.scene = scene;
    this.sun = sun;
    this.ambient = ambient;
    this.hemi = hemi;
    this.hour = START_HOUR;
    this.enabled = true;
    this.daylight = 1;
  }

  /**
   * @param {number} delta seconds
   * @param {{ x: number, z: number }} center keeps the sun (and its shadow box) above the car
   */
  update(delta, center) {
    if (this.enabled) this.hour = (this.hour + (delta * 24) / DAY_LENGTH_SECONDS) % 24;
    const l = lightingAt(this.enabled ? this.hour : NOON_HOUR);
    this.daylight = l.daylight;

    this.scene.background.copy(l.sky);
    this.scene.fog.color.copy(l.sky);

    // Sun rises in the east (+X) and sets in the west; below the horizon it only lights the moonlit fill
    const h = Math.max(l.elevation, 0.05);
    this.sun.position.set(center.x + Math.cos(l.azimuth) * 150, h * 150 + 10, center.z + 60);
    this.sun.target.position.set(center.x, 0, center.z);
    this.sun.color.copy(l.sunColor);
    this.sun.intensity = 1.2 * l.daylight;

    this.ambient.intensity = 0.15 + 0.35 * l.daylight;
    this.hemi.intensity = 0.15 + 0.45 * l.daylight;
  }

  /** "HH:MM" for the HUD */
  get clock() {
    const h = Math.floor(this.enabled ? this.hour : NOON_HOUR);
    const m = Math.floor(((this.enabled ? this.hour : NOON_HOUR) % 1) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
