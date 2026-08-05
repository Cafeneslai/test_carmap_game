/**
 * VegetationPlacer.js — Place trees in parks and forests
 */

import * as THREE from 'three';
import { TREE_DENSITY, MAX_TREES_PER_CHUNK } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { getElevationAt } from './ElevationUtils.js';

// Shared geometries (created once, reused)
let trunkGeometry = null;
let foliageGeometry = null;
let trunkMaterial = null;
let foliageMaterial = null;

function ensureSharedAssets() {
  if (!trunkGeometry) {
    trunkGeometry = new THREE.CylinderGeometry(0.15, 0.2, 2, 6);
    trunkGeometry.translate(0, 1, 0);
  }
  if (!foliageGeometry) {
    foliageGeometry = new THREE.ConeGeometry(1.5, 4, 7);
    foliageGeometry.translate(0, 4, 0);
  }
  if (!trunkMaterial) {
    trunkMaterial = new THREE.MeshStandardMaterial({
      color: 0x5c3a1e,
      roughness: 0.9,
      metalness: 0,
    });
  }
  if (!foliageMaterial) {
    foliageMaterial = new THREE.MeshStandardMaterial({
      color: 0x2d6b30,
      roughness: 0.8,
      metalness: 0,
      flatShading: true,
    });
  }
}

/**
 * Place trees in greenery areas
 * 
 * @param {object[]} greeneryElements - OSM elements (park, forest, etc.)
 * @param {number[][]} elevationData - Chunk elevation grid
 * @param {number} chunkWorldX
 * @param {number} chunkWorldZ
 * @param {number} originLat
 * @param {number} originLng
 * @returns {THREE.Group | null}
 */
export function placeVegetation(greeneryElements, elevationData, chunkWorldX, chunkWorldZ, originLat, originLng) {
  ensureSharedAssets();

  const treePositions = [];

  for (const element of greeneryElements) {
    if (!element.geometry || element.geometry.length < 3) continue;

    // Convert polygon to local coordinates
    const polygon = element.geometry.map(node => {
      const { x, z } = latLngToMeters(node.lat, node.lon, originLat, originLng);
      return { x, z };
    });

    // Compute bounding box of polygon
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const p of polygon) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }

    // Scatter trees within polygon
    const area = (maxX - minX) * (maxZ - minZ);
    const numTrees = Math.min(
      Math.floor(area * TREE_DENSITY),
      MAX_TREES_PER_CHUNK - treePositions.length
    );

    // Seeded random based on polygon position (deterministic)
    let seed = Math.abs(Math.floor(minX * 100 + minZ * 77));

    for (let i = 0; i < numTrees && treePositions.length < MAX_TREES_PER_CHUNK; i++) {
      seed = (seed * 16807 + 7) % 2147483647;
      const rx = minX + (seed / 2147483647) * (maxX - minX);
      seed = (seed * 16807 + 7) % 2147483647;
      const rz = minZ + (seed / 2147483647) * (maxZ - minZ);

      // Simple point-in-polygon test
      if (pointInPolygon(rx, rz, polygon)) {
        seed = (seed * 16807 + 7) % 2147483647;
        const scale = 0.6 + (seed / 2147483647) * 0.8; // 0.6 to 1.4
        seed = (seed * 16807 + 7) % 2147483647;
        const rotation = (seed / 2147483647) * Math.PI * 2;

        treePositions.push({ x: rx, z: rz, scale, rotation });
      }
    }
  }

  if (treePositions.length === 0) return null;

  // Use InstancedMesh for performance
  const group = new THREE.Group();

  // Trunk instanced mesh
  const trunkInstanced = new THREE.InstancedMesh(
    trunkGeometry,
    trunkMaterial,
    treePositions.length
  );
  trunkInstanced.castShadow = true;

  // Foliage instanced mesh
  const foliageInstanced = new THREE.InstancedMesh(
    foliageGeometry,
    foliageMaterial,
    treePositions.length
  );
  foliageInstanced.castShadow = true;

  const matrix = new THREE.Matrix4();

  for (let i = 0; i < treePositions.length; i++) {
    const { x, z, scale, rotation } = treePositions[i];

    matrix.identity();
    matrix.makeRotationY(rotation);
    matrix.scale(new THREE.Vector3(scale, scale, scale));
    matrix.setPosition(x, getElevationAt(x - chunkWorldX, z - chunkWorldZ, elevationData), z);

    trunkInstanced.setMatrixAt(i, matrix);
    foliageInstanced.setMatrixAt(i, matrix);
  }

  trunkInstanced.instanceMatrix.needsUpdate = true;
  foliageInstanced.instanceMatrix.needsUpdate = true;

  group.add(trunkInstanced);
  group.add(foliageInstanced);

  return group;
}

/**
 * Ray casting point-in-polygon test
 */
function pointInPolygon(x, z, polygon) {
  let inside = false;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;

    const intersect = ((zi > z) !== (zj > z)) &&
      (x < (xj - xi) * (z - zi) / (zj - zi) + xi);

    if (intersect) inside = !inside;
  }

  return inside;
}
