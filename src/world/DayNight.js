/**
 * DayNight.js — the real sun for the place and date being driven, a physically scattered sky,
 * stars at night, and image-based lighting taken from that sky so everything picks up its tint.
 */

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export const DAY_LENGTH_SECONDS = 600; // one full game day = 10 real minutes
const NOON_HOUR = 12;
const RAD = Math.PI / 180;

const NIGHT_SKY = new THREE.Color(0x0b1026);
const DUSK_SKY = new THREE.Color(0xe39a68);
const DAY_HAZE = new THREE.Color(0xb3c4ca);   // the sky shader's horizon colour, so fog melts into it
const OVERCAST = new THREE.Color(0x9ea7ae);
const SUN_LOW = new THREE.Color(0xffa860);
const SUN_HIGH = new THREE.Color(0xfff6ea);

/** Day of the year, 1..366 */
export function dayOfYear(date = new Date()) {
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);
}

/** Local solar time at a longitude right now (the sun is highest at 12:00) */
export function solarHourNow(lng, date = new Date()) {
  const utc = date.getUTCHours() + date.getUTCMinutes() / 60;
  return (((utc + lng / 15) % 24) + 24) % 24;
}

/**
 * Unit vector towards the sun in world axes (+X east, +Y up, +Z south) for a solar hour,
 * latitude and day of the year (standard declination / hour-angle formula).
 */
export function sunDirection(hour, lat, day) {
  const decl = 23.44 * RAD * Math.sin((2 * Math.PI * (284 + day)) / 365);
  const ha = (hour - 12) * 15 * RAD;
  const phi = lat * RAD;
  const east = -Math.cos(decl) * Math.sin(ha);
  const north = Math.sin(decl) * Math.cos(phi) - Math.cos(decl) * Math.cos(ha) * Math.sin(phi);
  const up = Math.sin(decl) * Math.sin(phi) + Math.cos(decl) * Math.cos(ha) * Math.cos(phi);
  return new THREE.Vector3(east, up, -north).normalize();
}

/**
 * Lighting for an hour of the day. Pure, so it can be checked without a renderer.
 * @param {number} hour 0..24 local solar time
 * @param {number} [lat] degrees; the default (equator at the equinox) rises at 06:00 and sets at 18:00
 * @param {number} [day] day of the year
 * @param {number} [cloud] 0 clear .. 1 overcast
 * @returns {{ elevation: number, direction: THREE.Vector3, daylight: number, sky: THREE.Color, sunColor: THREE.Color }}
 *   elevation: sine of the sun's height (-1..1); daylight: 0 at night .. 1 in full day; sky: horizon colour
 */
export function lightingAt(hour, lat = 0, day = 80, cloud = 0) {
  const direction = sunDirection(hour, lat, day);
  const elevation = direction.y;
  const daylight = THREE.MathUtils.smoothstep(elevation, -0.08, 0.2);

  const sky = new THREE.Color();
  if (elevation < 0.15) {
    sky.copy(NIGHT_SKY).lerp(DUSK_SKY, THREE.MathUtils.smoothstep(elevation, -0.15, 0.05));
  } else {
    sky.copy(DUSK_SKY).lerp(DAY_HAZE, THREE.MathUtils.smoothstep(elevation, 0.05, 0.4));
  }
  sky.lerp(OVERCAST.clone().multiplyScalar(0.25 + 0.75 * daylight), cloud * 0.7);
  const sunColor = SUN_LOW.clone().lerp(SUN_HIGH, THREE.MathUtils.clamp(elevation * 2.5, 0, 1));
  return { elevation, direction, daylight, sky, sunColor };
}

function makeStars() {
  const count = 1500;
  const pos = new Float32Array(count * 3);
  let seed = 12345;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    // Upper hemisphere only, on a sphere inside the far plane
    const y = 0.05 + rand() * 0.95, a = rand() * Math.PI * 2, r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * r * 900, y * 900, Math.sin(a) * r * 900], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
  const stars = new THREE.Points(geo, mat);
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  return stars;
}

export class DayNight {
  /**
   * @param {{ scene: THREE.Scene, sun: THREE.DirectionalLight, ambient: THREE.AmbientLight, hemi: THREE.HemisphereLight,
   *   renderer?: THREE.WebGLRenderer, camera?: THREE.Camera }} parts
   */
  constructor({ scene, sun, ambient, hemi, renderer = null, camera = null }) {
    this.scene = scene;
    this.sun = sun;
    this.ambient = ambient;
    this.hemi = hemi;
    this.renderer = renderer;
    this.camera = camera;
    this.hour = 9;
    this.lat = 0;
    this.day = dayOfYear();
    this.enabled = true;
    this.daylight = 1;
    /** Live weather (see Weather.js): 0..1 */
    this.cloud = 0;
    this.rain = 0;

    // Physical sky. Through ACES it came out grey-white, so it skips tone mapping and gets its own
    // gain and a saturation lift (values measured off screen: ~120,160,195 overhead at 10:00).
    this.sky = new Sky();
    this.sky.scale.setScalar(1800);
    this.sky.material.toneMapped = false;
    this.sky.material.uniforms.skyGain = { value: 0.2 };
    this.sky.material.uniforms.skySat = { value: 1.4 };
    this.sky.material.fragmentShader = 'uniform float skyGain;\nuniform float skySat;\n' +
      this.sky.material.fragmentShader.replace('gl_FragColor = vec4( retColor, 1.0 );',
        'vec3 c = retColor * skyGain; float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );\n' +
        'gl_FragColor = vec4( max( mix( vec3( lum ), c, skySat ), 0.0 ), 1.0 );');
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -2;
    scene.add(this.sky);
    this.stars = makeStars();
    scene.add(this.stars);

    // Sky-only scene that the environment map is baked from
    if (renderer) {
      this.pmrem = new THREE.PMREMGenerator(renderer);
      this.envScene = new THREE.Scene();
      const envSky = new Sky();
      envSky.material.uniforms = this.sky.material.uniforms;
      envSky.material.fragmentShader = this.sky.material.fragmentShader;
      envSky.scale.setScalar(50);
      this.envScene.add(envSky);
      this.envTarget = null;
      this.envKey = '';
    }
  }

  /** Real sun for this place: today's date, and the clock starts at the local solar time right now */
  setLocation(lat, lng) {
    this.lat = lat;
    this.day = dayOfYear();
    this.hour = solarHourNow(lng);
  }

  /**
   * @param {number} delta seconds
   * @param {{ x: number, z: number }} center keeps the sun (and its shadow box) above the car
   */
  update(delta, center) {
    if (this.enabled) this.hour = (this.hour + (delta * 24) / DAY_LENGTH_SECONDS) % 24;
    const hour = this.enabled ? this.hour : NOON_HOUR;
    const l = lightingAt(hour, this.lat, this.day, this.cloud);
    // Thick cloud blocks most of the direct sun but scatters it into soft light from everywhere,
    // so an overcast day is still bright. Lamps and headlights follow the sun only.
    const direct = l.daylight * (1 - 0.7 * this.cloud);
    const diffuse = l.daylight * this.cloud;
    this.daylight = l.daylight;

    this.scene.background = null;
    this.scene.fog.color.copy(l.sky);
    // Haze: clear air sees far, rain closes it in
    this.scene.fog.near = 150 - 100 * this.rain;
    this.scene.fog.far = 900 - 500 * this.rain - 200 * this.cloud;

    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(l.direction);
    u.turbidity.value = 2.5 + 8 * this.cloud;
    u.rayleigh.value = 1.2 * (1 - 0.6 * this.cloud);
    u.mieCoefficient.value = 0.004 + 0.02 * this.cloud;
    u.mieDirectionalG.value = 0.8;
    u.skyGain.value = 0.2 * (1 + 0.5 * this.cloud);
    u.skySat.value = 1.4 - 0.9 * this.cloud; // overcast skies are grey
    const eye = this.camera?.position ?? center;
    this.sky.position.set(eye.x, 0, eye.z);
    this.stars.position.set(eye.x, 0, eye.z);
    this.stars.material.opacity = (1 - THREE.MathUtils.smoothstep(l.elevation, -0.12, 0.02)) * (1 - this.cloud);

    // Sun light from the real direction; below the horizon the moon-ish fill takes over
    const dir = l.direction.clone();
    if (dir.y < 0.08) dir.y = 0.08;
    dir.normalize();
    this.sun.position.set(center.x + dir.x * 220, dir.y * 220, center.z + dir.z * 220);
    this.sun.target.position.set(center.x, 0, center.z);
    this.sun.color.copy(l.sunColor);
    this.sun.intensity = 2.2 * direct;

    this.ambient.intensity = 0.08 + 0.12 * this.daylight + 0.45 * diffuse;
    this.hemi.intensity = 0.12 + 0.3 * this.daylight + 0.35 * diffuse;

    this._updateEnvironment(hour);
  }

  /** Re-bake the sky lighting when the sun has moved a little (about every 6 real seconds) */
  _updateEnvironment(hour) {
    if (!this.pmrem) return;
    const key = `${Math.round(hour * 10)}_${Math.round(this.cloud * 10)}`;
    if (key === this.envKey) return;
    this.envKey = key;
    const target = this.pmrem.fromScene(this.envScene, 0.04);
    this.envTarget?.dispose();
    this.envTarget = target;
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = 0.1 + 0.25 * this.daylight;
  }

  /** "HH:MM" for the HUD */
  get clock() {
    const t = this.enabled ? this.hour : NOON_HOUR;
    const h = Math.floor(t);
    const m = Math.floor((t % 1) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
