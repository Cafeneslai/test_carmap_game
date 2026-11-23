/**
 * SatelliteGround.js — the ground of a chunk textured with real aerial imagery (Esri World Imagery,
 * free with attribution), so fields, car parks, sand and dirt are exactly where they are in reality.
 * Falls back to the painted land cover (GroundPainter) when the imagery cannot be loaded.
 */

import * as THREE from 'three';
import { CHUNK_SIZE, SATELLITE_TILES } from '../config.js';
import { metersToLatLng } from '../data/GeoUtils.js';

const hasDom = typeof document !== 'undefined';
const ZOOM = 18;          // ~0.6 m per pixel in Thailand; 4-9 tiles per 200 m chunk
const SIZE = 512;         // texture pixels per chunk side (~0.4 m per pixel)
const TIMEOUT_MS = 8000;
const MAX_CACHED_TILES = 400; // neighbouring chunks share tiles

const tiles = new Map(); // "x/y" -> Promise<HTMLImageElement | null>

function loadTile(x, y) {
  const key = `${x}/${y}`;
  if (!tiles.has(key)) {
    tiles.set(key, new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // the server sends CORS headers, so the canvas stays readable
      const timer = setTimeout(() => { img.src = ''; resolve(null); }, TIMEOUT_MS);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = SATELLITE_TILES.replace('{z}', ZOOM).replace('{x}', x).replace('{y}', y);
    }).then((img) => {
      if (!img) tiles.delete(key); // retry next time
      return img;
    }));
    if (tiles.size > MAX_CACHED_TILES) tiles.delete(tiles.keys().next().value);
  }
  return tiles.get(key);
}

/** Global Web Mercator pixel position at ZOOM */
export function mercatorPixel(lat, lng) {
  const scale = 256 * 2 ** ZOOM;
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

/**
 * Aerial imagery for one chunk.
 * @returns {Promise<THREE.CanvasTexture | null>} null outside the browser or when tiles are missing
 */
// shortcut: where Esri has no zoom-18 imagery it serves a grey "not available" tile; use a lower zoom there if that shows up.
export async function satelliteGround(chunkWorldX, chunkWorldZ, originLat, originLng) {
  if (!hasDom) return null;
  const half = CHUNK_SIZE / 2;
  const nw = metersToLatLng(chunkWorldX - half, chunkWorldZ - half, originLat, originLng);
  const se = metersToLatLng(chunkWorldX + half, chunkWorldZ + half, originLat, originLng);
  const a = mercatorPixel(nw.lat, nw.lng);
  const b = mercatorPixel(se.lat, se.lng);

  const jobs = [];
  for (let tx = Math.floor(a.x / 256); tx <= Math.floor(b.x / 256); tx++) {
    for (let ty = Math.floor(a.y / 256); ty <= Math.floor(b.y / 256); ty++) {
      jobs.push(loadTile(tx, ty).then((img) => ({ tx, ty, img })));
    }
  }
  const loaded = await Promise.all(jobs);
  if (loaded.some((t) => !t.img)) return null; // a hole would look worse than the painted ground

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  // Canvas top = north (-Z), left = west: the same layout GroundPainter uses for the terrain uv
  const sx = SIZE / (b.x - a.x), sy = SIZE / (b.y - a.y);
  // Aerial photos are exposed for the shadows of trees and roofs; lit again by our sun they looked dim
  ctx.filter = 'brightness(1.25) saturate(1.1)';
  for (const { tx, ty, img } of loaded) {
    // +0.5 px overlap hides hairline gaps between tiles
    ctx.drawImage(img, (tx * 256 - a.x) * sx, (ty * 256 - a.y) * sy, 256 * sx + 0.5, 256 * sy + 0.5);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  return texture;
}
