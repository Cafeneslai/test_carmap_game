/**
 * Weather.js — the real current weather at the location (Open-Meteo, free, no key): a drifting
 * cloud layer as thick as the real cloud cover, rain streaks when it rains, haze and wind in the trees.
 */

import * as THREE from 'three';
import { WEATHER_API } from '../config.js';
import { windUniforms } from './VegetationPlacer.js';

const REFRESH_MS = 15 * 60 * 1000;
const RAIN_DROPS = 6000;
const RAIN_BOX = 70; // metres around the camera

/** Open-Meteo "current" values -> what the renderer needs. Pure, so it is checked in the verify script. */
export function weatherFromApi(current) {
  const cloud = THREE.MathUtils.clamp((current?.cloud_cover ?? 0) / 100, 0, 1);
  const mm = current?.precipitation ?? 0; // mm in the last 15 min-1 h
  const code = current?.weather_code ?? 0;
  // WMO codes 51-67 drizzle/rain, 80-82 showers, 95-99 thunderstorm
  const rainy = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  const rain = rainy || mm > 0.05 ? THREE.MathUtils.clamp(0.25 + mm / 4, 0.25, 1) : 0;
  const wind = THREE.MathUtils.clamp((current?.wind_speed_10m ?? 10) / 50, 0, 1);
  return { cloud, rain, wind, temperature: current?.temperature_2m ?? null, code };
}

/** One emoji for the HUD */
export function weatherIcon({ cloud, rain, code }) {
  if (code >= 95) return '⛈️';
  if (rain > 0) return '🌧️';
  if (cloud > 0.8) return '☁️';
  if (cloud > 0.35) return '⛅';
  return '☀️';
}

function makeClouds() {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      uCover: { value: 0.3 }, uTime: { value: 0 }, uLight: { value: 1 }, uOffset: { value: new THREE.Vector2() },
      uTint: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: /* glsl */`
      varying vec2 vPos;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vPos = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */`
      uniform float uCover; uniform float uTime; uniform float uLight; uniform vec2 uOffset; uniform vec3 uTint;
      varying vec2 vPos;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
      void main() {
        vec2 p = (vPos + uOffset) / 520.0;
        // Domain warp gives rounded, cauliflower-like cumulus instead of streaks
        vec2 w = vec2(fbm(p + vec2(3.1, 1.7)), fbm(p + vec2(8.3, 2.8)));
        float n = fbm(p + w * 0.6);
        float d = smoothstep(1.0 - uCover - 0.06, 1.0 - uCover + 0.16, n);
        // Fade out towards the horizon so the edge of the layer never shows
        float r = length(vPos - cameraPosition.xz);
        d *= 1.0 - smoothstep(1100.0, 1700.0, r);
        // Thick middles are bright, thin edges and full overcast greyer
        float shade = mix(0.7, 1.15, smoothstep(0.45, 0.85, n)) * mix(1.0, 0.85, uCover);
        gl_FragColor = vec4(uTint * shade * uLight, d * 0.95);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), material);
  mesh.rotation.x = Math.PI / 2; // faces down, seen from below
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

function makeRain() {
  const pos = new Float32Array(RAIN_DROPS * 6);
  for (let i = 0; i < RAIN_DROPS; i++) {
    const x = (Math.random() - 0.5) * RAIN_BOX, y = Math.random() * 40, z = (Math.random() - 0.5) * RAIN_BOX;
    pos.set([x, y, z, x, y - 0.6, z], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const rain = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xaabbcc, transparent: true, opacity: 0.45, depthWrite: false }));
  rain.frustumCulled = false;
  rain.visible = false;
  return rain;
}

export class Weather {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./DayNight.js').DayNight} dayNight
   */
  constructor(scene, dayNight) {
    this.dayNight = dayNight;
    this.enabled = true;
    this.state = { cloud: 0, rain: 0, wind: 0.2, temperature: null, code: 0 };
    this.clouds = makeClouds();
    this.rain = makeRain();
    scene.add(this.clouds, this.rain);
    this.timer = null;
    this.fetchedFor = null;
  }

  /** Start following the weather at a place (fetches now, then every 15 minutes) */
  setLocation(lat, lng) {
    clearInterval(this.timer);
    this.fetchedFor = { lat, lng };
    const load = () => this._fetch(lat, lng);
    load();
    this.timer = setInterval(load, REFRESH_MS);
  }

  async _fetch(lat, lng) {
    try {
      const url = `${WEATHER_API}?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&current=temperature_2m,cloud_cover,precipitation,weather_code,wind_speed_10m`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (this.fetchedFor?.lat === lat && this.fetchedFor?.lng === lng) this.state = weatherFromApi(json.current);
    } catch (err) {
      console.warn('Weather unavailable, keeping clear skies:', err.message);
    }
  }

  /** Short text for the HUD, e.g. "☁️ 31°" */
  get label() {
    if (!this.enabled || this.state.temperature === null) return '';
    return `${weatherIcon(this.state)} ${Math.round(this.state.temperature)}°`;
  }

  /**
   * @param {number} delta seconds
   * @param {THREE.Camera} camera
   */
  update(delta, camera) {
    const s = this.enabled ? this.state : { cloud: 0, rain: 0, wind: 0.2 };
    // Ease towards the new weather instead of jumping
    const k = Math.min(1, delta * 0.3);
    this.dayNight.cloud += (s.cloud - this.dayNight.cloud) * k;
    this.dayNight.rain += (s.rain - this.dayNight.rain) * k;
    windUniforms.uWind.value += (s.wind - windUniforms.uWind.value) * k;

    const cam = camera.position;
    const u = this.clouds.material.uniforms;
    u.uCover.value = 0.15 + this.dayNight.cloud * 0.8;
    u.uTime.value += delta;
    // Clouds drift with the wind (world-fixed noise, so they move past the car, not with it)
    u.uOffset.value.x += delta * (4 + 30 * windUniforms.uWind.value);
    u.uLight.value = 0.12 + 0.88 * this.dayNight.daylight;
    u.uTint.value.copy(this.dayNight.sun.color).lerp(new THREE.Color(1, 1, 1), 0.6);
    this.clouds.position.set(cam.x, 450, cam.z);

    const rain = this.dayNight.rain;
    this.rain.visible = rain > 0.02;
    if (this.rain.visible) {
      this.rain.material.opacity = 0.2 + 0.45 * rain;
      const p = this.rain.geometry.attributes.position;
      const fall = delta * (14 + 8 * rain);
      const drift = delta * 6 * windUniforms.uWind.value;
      const arr = p.array;
      for (let i = 0; i < arr.length; i += 6) {
        arr[i + 1] -= fall; arr[i + 4] -= fall; arr[i] += drift; arr[i + 3] += drift;
        if (arr[i + 4] < 0) { // back to the top of the box
          const x = (Math.random() - 0.5) * RAIN_BOX, z = (Math.random() - 0.5) * RAIN_BOX;
          arr.set([x, 40, z, x - 0.15 * windUniforms.uWind.value, 39.2 - rain * 0.4, z], i);
        }
      }
      p.needsUpdate = true;
      this.rain.position.set(cam.x, cam.y - 20, cam.z);
    }
  }

  dispose() {
    clearInterval(this.timer);
  }
}
