/**
 * WaterGenerator.js — Generate water surface meshes from OSM data
 */

import * as THREE from 'three';
import { latLngToMeters } from '../data/GeoUtils.js';
import { getElevationAt } from './ElevationUtils.js';
import { CHUNK_SIZE } from '../config.js';
import { cumulativeLengths, extract, insideIntervals } from './Polyline.js';

const WATER_Y_OFFSET = 0.05;

/**
 * Generate water surface from OSM water data
 * 
 * @param {object[]} waterElements - OSM elements with water/waterway tag
 * @param {number} chunkWorldX
 * @param {number} chunkWorldZ
 * @param {number} originLat
 * @param {number} originLng
 * @param {number[][]} [elevationData] - chunk elevation grid, used to float the water on the terrain
 * @param {number | null} [baseElevation]
 * @returns {THREE.Mesh | null}
 */
export function generateWater(waterElements, chunkWorldX, chunkWorldZ, originLat, originLng, elevationData = null, baseElevation = null) {
  const geometries = [];

  for (const element of waterElements) {
    // A riverbank is the river's area outline, not a centre line
    const isWaterway = !!element.tags?.waterway && element.tags.natural !== 'water' && element.tags.waterway !== 'riverbank';
    if (!element.geometry || element.geometry.length < (isWaterway ? 2 : 3)) continue;

    // Convert coordinates
    const points = element.geometry.map(node => {
      const { x, z } = latLngToMeters(node.lat, node.lon, originLat, originLng);
      return new THREE.Vector2(x, z);
    });

    const heightAt = (x, z) => (elevationData
      ? getElevationAt(x - chunkWorldX, z - chunkWorldZ, elevationData, baseElevation)
      : 0) + WATER_Y_OFFSET;
    const half = CHUNK_SIZE / 2;

    // Rivers/streams: only the part inside this chunk, following the terrain (rivers flow downhill)
    if (isWaterway) {
      const width = getWaterwayWidth(element.tags.waterway);
      const rect = { minX: chunkWorldX - half - 1, maxX: chunkWorldX + half + 1, minZ: chunkWorldZ - half - 1, maxZ: chunkWorldZ + half + 1 };
      const cum = cumulativeLengths(points);
      for (const [a, b] of insideIntervals(points, cum, rect)) {
        const strip = createWaterStrip(extract(points, cum, a, b), width / 2, heightAt);
        if (strip) geometries.push(strip);
      }
      continue;
    }

    // Small lakes are drawn whole by the one chunk holding their centre (copies at different
    // clamped heights z-fought). Lakes bigger than a chunk are cut to each chunk instead, otherwise
    // a reservoir only appeared once the chunk at its middle was loaded.
    let cx = 0, cz = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      cx += p.x; cz += p.y;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y);
    }
    cx /= points.length;
    cz /= points.length;
    const big = maxX - minX > CHUNK_SIZE || maxZ - minZ > CHUNK_SIZE;
    if (!big && (cx < chunkWorldX - half || cx >= chunkWorldX + half || cz < chunkWorldZ - half || cz >= chunkWorldZ + half)) continue;

    try {
      // rotateX(-PI/2) below maps shape-Y to world -Z, so feed -Z to land on the right side
      const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, -p.y)));
      for (const hole of element.holes || []) {
        shape.holes.push(new THREE.Path(hole.map((n) => {
          const { x, z } = latLngToMeters(n.lat, n.lon, originLat, originLng);
          return new THREE.Vector2(x, -z);
        })));
      }
      let geometry = new THREE.ShapeGeometry(shape);
      geometry.rotateX(-Math.PI / 2);
      if (big) {
        geometry = clipToRect(geometry, chunkWorldX - half, chunkWorldX + half, chunkWorldZ - half, chunkWorldZ + half);
        if (!geometry) continue;
      }
      const positions = geometry.attributes.position;
      // Big lakes: level taken inside this chunk (DEM water is flat, so neighbours agree closely)
      let sx = cx, sz = cz;
      if (big) {
        sx = sz = 0;
        for (let i = 0; i < positions.count; i++) { sx += positions.getX(i); sz += positions.getZ(i); }
        sx /= positions.count;
        sz /= positions.count;
      }
      const waterY = heightAt(sx, sz);
      for (let i = 0; i < positions.count; i++) positions.setY(i, waterY);
      geometries.push(geometry);
    } catch {
      continue;
    }
  }

  if (geometries.length === 0) return null;

  // Merge
  const merged = mergeSimple(geometries);
  if (!merged) return null;

  // Opaque on purpose: neighbouring chunks can both draw the same lake, and overlapping
  // translucent copies would blend twice and look darker.
  const material = new THREE.MeshStandardMaterial({
    color: 0x2f8fc4,
    roughness: 0.2,
    metalness: 0.2,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const mesh = new THREE.Mesh(merged, material);
  mesh.receiveShadow = true;

  return mesh;
}

/**
 * Keep only the part of a flat (XZ) triangle mesh inside a rectangle: each triangle is clipped
 * (Sutherland-Hodgman) and the convex piece left is fanned back into triangles.
 * @returns {THREE.BufferGeometry | null} null when nothing is inside
 */
export function clipToRect(geometry, minX, maxX, minZ, maxZ) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const edges = [(p) => p.x - minX, (p) => maxX - p.x, (p) => p.z - minZ, (p) => maxZ - p.z];
  const out = [];
  for (let t = 0; t < count; t += 3) {
    let poly = [0, 1, 2].map((k) => {
      const i = index ? index.getX(t + k) : t + k;
      return { x: pos.getX(i), z: pos.getZ(i) };
    });
    for (const inside of edges) {
      const next = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const da = inside(a), db = inside(b);
        if (da >= 0) next.push(a);
        if ((da >= 0) !== (db >= 0)) {
          const k = da / (da - db);
          next.push({ x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k });
        }
      }
      poly = next;
      if (poly.length < 3) break;
    }
    for (let i = 1; i + 1 < poly.length; i++) {
      for (const p of [poly[0], poly[i], poly[i + 1]]) out.push(p.x, 0, p.z);
    }
  }
  if (out.length === 0) return null;
  const clipped = new THREE.BufferGeometry();
  clipped.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  clipped.setAttribute('normal', new THREE.Float32BufferAttribute(out.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  clipped.setIndex([...Array(out.length / 3).keys()]); // mergeSimple expects indexed geometry
  return clipped;
}

function getWaterwayWidth(type) {
  switch (type) {
    case 'river': return 15;
    case 'canal': return 8;
    case 'stream': return 3;
    case 'drain': return 2;
    default: return 5;
  }
}

function createWaterStrip(points, halfWidth, heightAt) {
  if (points.length < 2) return null;

  const vertices = [];
  const indices = [];

  for (let i = 0; i < points.length; i++) {
    let dir;
    if (i === 0) {
      dir = new THREE.Vector2().subVectors(points[1], points[0]).normalize();
    } else if (i === points.length - 1) {
      dir = new THREE.Vector2().subVectors(points[i], points[i - 1]).normalize();
    } else {
      const d1 = new THREE.Vector2().subVectors(points[i], points[i - 1]).normalize();
      const d2 = new THREE.Vector2().subVectors(points[i + 1], points[i]).normalize();
      dir = new THREE.Vector2().addVectors(d1, d2).normalize();
    }

    const normal = new THREE.Vector2(-dir.y, dir.x);

    const y = heightAt(points[i].x, points[i].y); // same height on both banks, no tilted water
    vertices.push(
      points[i].x + normal.x * halfWidth, y, points[i].y + normal.y * halfWidth,
      points[i].x - normal.x * halfWidth, y, points[i].y - normal.y * halfWidth
    );

    if (i > 0) {
      const idx = (i - 1) * 2;
      indices.push(idx, idx + 2, idx + 1);
      indices.push(idx + 1, idx + 2, idx + 3);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function mergeSimple(geometries) {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0];

  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of geometries) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : 0;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);
  let vo = 0, io = 0;

  for (const g of geometries) {
    positions.set(g.attributes.position.array, vo * 3);
    if (g.attributes.normal) normals.set(g.attributes.normal.array, vo * 3);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices[io + i] = g.index.array[i] + vo;
      io += g.index.count;
    }
    vo += g.attributes.position.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (totalIndices > 0) merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}
