/**
 * BuildingGenerator.js — Generate 3D buildings from OSM data
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { DEFAULT_BUILDING_HEIGHT, METERS_PER_FLOOR, BUILDING_COLORS } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { getElevationAt } from './ElevationUtils.js';

/**
 * Generate merged building mesh from OSM building elements
 * 
 * @param {object[]} buildings - OSM way/relation elements with building tag
 * @param {number[][]} elevationData - Chunk elevation grid
 * @param {number} chunkWorldX
 * @param {number} chunkWorldZ
 * @param {number} originLat
 * @param {number} originLng
 * @returns {THREE.Group | null}
 */
export function generateBuildings(buildings, elevationData, chunkWorldX, chunkWorldZ, originLat, originLng, baseElevation = null) {
  const group = new THREE.Group();
  const geometries = [];
  const colorArrays = [];
  // One static body per chunk, one box per building, so the car cannot drive through walls
  const body = new CANNON.Body({ mass: 0 });

  for (const building of buildings) {
    if (!building.geometry || building.geometry.length < 3) continue;

    // Calculate height
    let height = DEFAULT_BUILDING_HEIGHT;
    if (building.tags?.height) {
      height = parseFloat(building.tags.height) || DEFAULT_BUILDING_HEIGHT;
    } else if (building.tags?.['building:levels']) {
      const levels = parseInt(building.tags['building:levels']) || 3;
      height = levels * METERS_PER_FLOOR;
    }

    // Convert coordinates to local positions
    const shapePoints = [];
    for (const node of building.geometry) {
      const { x, z } = latLngToMeters(node.lat, node.lon, originLat, originLng);
      shapePoints.push(new THREE.Vector2(x, z));
    }

    // Ensure the polygon is closed
    if (shapePoints.length >= 3) {
      const first = shapePoints[0];
      const last = shapePoints[shapePoints.length - 1];
      if (first.distanceTo(last) > 0.01) {
        shapePoints.push(first.clone());
      }
    }

    // Create Three.js Shape
    try {
      const shape = new THREE.Shape();
      // rotateX(-PI/2) below maps shape-Y to world -Z, so feed -Z to land on the right side
      shape.moveTo(shapePoints[0].x, -shapePoints[0].y);
      for (let i = 1; i < shapePoints.length; i++) {
        shape.lineTo(shapePoints[i].x, -shapePoints[i].y);
      }

      // Extrude
      const extrudeSettings = {
        steps: 1,
        depth: height,
        bevelEnabled: false,
      };

      const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);

      // Rotate to make extrusion go up (Y axis)
      geometry.rotateX(-Math.PI / 2);

      // Calculate average local X, Z for elevation sampling
      let avgX = 0, avgZ = 0;
      for (const p of shapePoints) {
        avgX += p.x;
        avgZ += p.y;
      }
      avgX /= shapePoints.length;
      avgZ /= shapePoints.length;
      
      const baseY = getElevationAt(avgX - chunkWorldX, avgZ - chunkWorldZ, elevationData, baseElevation);
      
      // Translate to terrain height (sink it slightly to avoid gaps)
      geometry.translate(0, baseY - 0.5, 0);
      addCollisionBox(body, shapePoints, baseY - 0.5, height);

      // Pick a color for this building
      // Deterministic per building so a building drawn by two chunks never flickers
      const colorHex = BUILDING_COLORS[Math.abs(Number(building.id) || 0) % BUILDING_COLORS.length];
      const color = new THREE.Color(colorHex);

      // Add vertex colors
      const posCount = geometry.attributes.position.count;
      const colorData = new Float32Array(posCount * 3);
      for (let i = 0; i < posCount; i++) {
        // Slight variation for walls vs roof
        const pos = new THREE.Vector3();
        pos.fromBufferAttribute(geometry.attributes.position, i);
        const normal = new THREE.Vector3();
        normal.fromBufferAttribute(geometry.attributes.normal, i);

        // Darken walls slightly, roof stays original color
        const isTopFace = Math.abs(normal.y) > 0.9;
        const factor = isTopFace ? 1.0 : 0.75;

        colorData[i * 3] = color.r * factor;
        colorData[i * 3 + 1] = color.g * factor;
        colorData[i * 3 + 2] = color.b * factor;
      }

      geometry.setAttribute('color', new THREE.BufferAttribute(colorData, 3));
      geometries.push(geometry);

    } catch (err) {
      // Skip invalid shapes
      continue;
    }
  }

  if (geometries.length === 0) return null;

  // Merge all building geometries for performance
  const mergedGeometry = mergeGeometries(geometries);

  if (!mergedGeometry) return null;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0.1,
    flatShading: true,
  });

  const mesh = new THREE.Mesh(mergedGeometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  group.add(mesh);
  if (body.shapes.length > 0) group.userData.body = body;

  // Dispose individual geometries
  for (const geom of geometries) {
    geom.dispose();
  }

  return group;
}

/**
 * Box aligned with the footprint's longest wall. Exact for rectangles, a close fit for most other shapes.
 * shortcut: L/U-shaped buildings get one box over their whole footprint; use convex decomposition if that blocks real roads.
 * @param {THREE.Vector2[]} points footprint in world x / z
 */
function addCollisionBox(body, points, bottomY, height) {
  let bestLen = 0, ux = 1, uz = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dz = points[i + 1].y - points[i].y;
    const len = Math.hypot(dx, dz);
    if (len > bestLen) { bestLen = len; ux = dx / len; uz = dz / len; }
  }
  if (bestLen < 0.5) return;

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of points) {
    const u = p.x * ux + p.y * uz;
    const v = -p.x * uz + p.y * ux;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const halfU = (maxU - minU) / 2, halfV = (maxV - minV) / 2;
  if (halfU < 0.25 || halfV < 0.25) return;

  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  const center = new CANNON.Vec3(cu * ux - cv * uz, bottomY + height / 2, cu * uz + cv * ux);
  // Rotating local +X about +Y by a gives (cos a, 0, -sin a); we want (ux, 0, uz)
  const q = new CANNON.Quaternion();
  q.setFromEuler(0, Math.atan2(-uz, ux), 0);
  body.addShape(new CANNON.Box(new CANNON.Vec3(halfU, height / 2, halfV)), center, q);
}

/**
 * Merge buffer geometries
 */
function mergeGeometries(geometries) {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0].clone();

  let totalVerts = 0;
  let totalIndices = 0;

  for (const g of geometries) {
    totalVerts += g.attributes.position.count;
    if (g.index) totalIndices += g.index.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;

  for (const g of geometries) {
    const pc = g.attributes.position.count;

    // Positions
    positions.set(g.attributes.position.array, vOffset * 3);

    // Normals
    if (g.attributes.normal) {
      normals.set(g.attributes.normal.array, vOffset * 3);
    }

    // Colors
    if (g.attributes.color) {
      colors.set(g.attributes.color.array, vOffset * 3);
    }

    // Indices
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        indices[iOffset + i] = g.index.array[i] + vOffset;
      }
      iOffset += g.index.count;
    }

    vOffset += pc;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (totalIndices > 0) {
    merged.setIndex(new THREE.BufferAttribute(indices, 1));
  }

  return merged;
}
