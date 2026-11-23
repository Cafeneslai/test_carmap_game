/**
 * GroundPainter.js — the terrain's colour texture, painted per chunk from OSM land cover:
 * fields, forest floor, beach sand, parking lots, residential yards... on top of natural grass.
 * A world-aligned noise layer (same tile everywhere) breaks up flat colour without seams,
 * and a shared bump texture gives the ground grain when seen up close.
 */

import * as THREE from 'three';
import { CHUNK_SIZE } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { landcoverType } from '../data/OSMFetcher.js';

const hasDom = typeof document !== 'undefined'; // the verify script runs in Node without a canvas
const SIZE = 256;                // texture pixels per chunk side (~0.8 m per pixel)
const NOISE_TILE_METERS = 50;    // divides CHUNK_SIZE, so the noise lines up across chunk borders
export const BASE_GRASS = '#6f8a47';

/** Ground colour (sRGB) per land-cover kind; unknown kinds keep the grass */
export const GROUND_COLORS = {
  // Campuses, schools and hospitals are mostly lawns and trees around the buildings, so they stay green
  'landuse=residential': '#87916a', 'landuse=commercial': '#9c9a92', 'landuse=retail': '#9c9a92',
  'landuse=industrial': '#97928a', 'landuse=railway': '#8d8578', 'landuse=military': '#7f8a68',
  'landuse=construction': '#a38f6d', 'landuse=brownfield': '#9e8c6c', 'landuse=greenfield': '#8a9a5a',
  'landuse=farmland': '#a8a865', 'landuse=farmyard': '#9b8f66', 'landuse=meadow': '#88a052',
  'landuse=grass': '#77a04a', 'landuse=village_green': '#77a04a', 'landuse=recreation_ground': '#74a148',
  'landuse=forest': '#3f5f2e', 'landuse=orchard': '#62843c', 'landuse=vineyard': '#7f8c48',
  'landuse=allotments': '#7d8f4b', 'landuse=plant_nursery': '#6f8f45', 'landuse=cemetery': '#7a8f66',
  'landuse=religious': '#86906c', 'landuse=aquaculture': '#5f7f78', 'landuse=salt_pond': '#c9c7bd',
  'natural=wood': '#3c5a2c', 'natural=scrub': '#62703f', 'natural=grassland': '#869e52', 'natural=heath': '#7d7a4a',
  'natural=beach': '#e2d3a3', 'natural=sand': '#dccb98', 'natural=bare_rock': '#9a958b', 'natural=scree': '#a29d93',
  'natural=wetland': '#5c7656', 'natural=mud': '#7a6a52',
  'leisure=park': '#6c9b45', 'leisure=garden': '#6c9b45', 'leisure=pitch': '#5c9a42', 'leisure=golf_course': '#6cab4c',
  'leisure=playground': '#b9a27a', 'leisure=sports_centre': '#8f9a7a', 'leisure=stadium': '#8f9a7a', 'leisure=track': '#a65f48',
  'amenity=parking': '#86868a', 'amenity=school': '#829356', 'amenity=university': '#7f9555',
  'amenity=college': '#829356', 'amenity=hospital': '#8a9566',
};

/** Hard surfaces: no grass mottling on them (it looked like smoke over parking lots) */
const PAVED = new Set(['amenity=parking', 'landuse=commercial', 'landuse=retail', 'landuse=industrial', 'leisure=track']);

// Scratch canvases, reused: painting is synchronous, one chunk at a time
let maskCanvas = null, noiseLayer = null;
function scratch() {
  if (!maskCanvas) {
    maskCanvas = document.createElement('canvas');
    noiseLayer = document.createElement('canvas');
    maskCanvas.width = maskCanvas.height = noiseLayer.width = noiseLayer.height = SIZE;
  }
  return { mask: maskCanvas.getContext('2d'), noise: noiseLayer.getContext('2d') };
}

// Deterministic so the world looks the same on every visit and in every chunk
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Soft blotchy noise, tileable: random dots blurred together, used to mottle the colours */
let noiseCanvas = null;
function getNoiseCanvas() {
  if (noiseCanvas) return noiseCanvas;
  const px = (SIZE * NOISE_TILE_METERS) / CHUNK_SIZE; // 64 px for a 50 m tile
  noiseCanvas = document.createElement('canvas');
  noiseCanvas.width = noiseCanvas.height = px;
  const ctx = noiseCanvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, px, px);
  const rand = mulberry32(7);
  for (let i = 0; i < 260; i++) {
    const x = rand() * px, y = rand() * px, r = 1 + rand() * 6;
    const light = rand() < 0.5;
    ctx.fillStyle = light ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.11)';
    // Draw the blob and its wrapped copies so the tile has no edge
    for (const dx of [-px, 0, px]) for (const dy of [-px, 0, px]) {
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return noiseCanvas;
}

/** Fine-grain bump texture shared by every chunk (repeats every few metres through uv1) */
let detailTexture = null;
export function getGroundDetailTexture() {
  if (!hasDom) return null;
  if (detailTexture) return detailTexture;
  const px = 128;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(px, px);
  const rand = mulberry32(11);
  for (let i = 0; i < px * px; i++) {
    const v = 100 + rand() * 110;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  detailTexture = new THREE.CanvasTexture(c);
  detailTexture.wrapS = detailTexture.wrapT = THREE.RepeatWrapping;
  detailTexture.channel = 1; // sampled with the world-scaled uv1, not the per-chunk uv
  return detailTexture;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) a += pts[i].x * pts[i + 1].z - pts[i + 1].x * pts[i].z;
  return Math.abs(a / 2);
}

/** Slight per-area shade so neighbouring fields of the same kind are not one flat colour */
function shade(hex, id) {
  const c = new THREE.Color(hex);
  const k = 0.92 + (Math.abs(Number(String(id).replace(/\D/g, '').slice(-6)) || 0) % 17) / 100;
  return `#${c.multiplyScalar(k).getHexString()}`;
}

/**
 * Paint the ground of one chunk.
 * @returns {THREE.CanvasTexture | null} null outside the browser
 */
export function paintGround(landcover, chunkWorldX, chunkWorldZ, originLat, originLng) {
  if (!hasDom) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const minX = chunkWorldX - CHUNK_SIZE / 2, minZ = chunkWorldZ - CHUNK_SIZE / 2;
  const scale = SIZE / CHUNK_SIZE;
  // Canvas top = north (-Z), left = west (-X): matches the terrain plane's uv with flipY
  const toPx = (x, z) => [(x - minX) * scale, (z - minZ) * scale];

  ctx.fillStyle = BASE_GRASS;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Where the mottling goes: same layering as the colours, cleared on paved areas
  const { mask, noise } = scratch();
  mask.globalCompositeOperation = 'source-over';
  mask.fillStyle = '#000';
  mask.fillRect(0, 0, SIZE, SIZE);

  // Big areas first so small ones (a parking lot inside a campus) end up on top
  const areas = (landcover || [])
    .map((el) => ({ el, kind: landcoverType(el.tags || {}), pts: el.geometry.map((n) => latLngToMeters(n.lat, n.lon, originLat, originLng)) }))
    .filter((a) => GROUND_COLORS[a.kind])
    .map((a) => ({ ...a, area: polygonArea(a.pts) }))
    .sort((a, b) => b.area - a.area);

  for (const { el, kind, pts } of areas) {
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(...toPx(p.x, p.z)) : ctx.moveTo(...toPx(p.x, p.z))));
    ctx.closePath();
    ctx.fillStyle = shade(GROUND_COLORS[kind], el.id);
    ctx.fill();
    mask.globalCompositeOperation = PAVED.has(kind) ? 'destination-out' : 'source-over';
    mask.beginPath();
    pts.forEach((p, i) => (i ? mask.lineTo(...toPx(p.x, p.z)) : mask.moveTo(...toPx(p.x, p.z))));
    mask.closePath();
    mask.fill();

    // Crop rows on fields, mown stripes on pitches: thin lines at an angle fixed per area
    if (kind === 'landuse=farmland' || kind === 'leisure=pitch' || kind === 'landuse=orchard' || kind === 'landuse=vineyard') {
      ctx.clip();
      const angle = ((Math.abs(Number(String(el.id).replace(/\D/g, '').slice(-4)) || 0) % 180) * Math.PI) / 180;
      const gap = kind === 'leisure=pitch' ? 5 * scale : 2.5 * scale;
      // Anchored on the area's first corner, so neighbouring chunks draw the same rows
      const [ax, ay] = toPx(pts[0].x, pts[0].z);
      const reach = Math.hypot(ax - SIZE / 2, ay - SIZE / 2) + SIZE;
      ctx.translate(ax, ay);
      ctx.rotate(angle);
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      const first = -Math.ceil(reach / (gap * 2)) * gap * 2;
      for (let y = first; y < reach; y += gap * 2) ctx.fillRect(-reach, y, reach * 2, gap);
    }
    ctx.restore();
  }

  // World-aligned mottling; chunk corners sit on multiples of the tile, so it continues across chunks
  noise.globalCompositeOperation = 'source-over';
  noise.clearRect(0, 0, SIZE, SIZE);
  noise.fillStyle = noise.createPattern(getNoiseCanvas(), 'repeat');
  noise.fillRect(0, 0, SIZE, SIZE);
  noise.globalCompositeOperation = 'destination-in';
  noise.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'soft-light';
  ctx.drawImage(noiseLayer, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  return texture;
}
