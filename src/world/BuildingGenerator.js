/**
 * BuildingGenerator.js — Generate 3D buildings from OSM data
 */

import * as THREE from 'three';
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
      shape.moveTo(shapePoints[0].x, shapePoints[0].y);
      for (let i = 1; i < shapePoints.length; i++) {
        shape.lineTo(shapePoints[i].x, shapePoints[i].y);
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

      // Pick a color for this building
      const colorHex = BUILDING_COLORS[Math.floor(Math.random() * BUILDING_COLORS.length)];
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

  // Dispose individual geometries
  for (const geom of geometries) {
    geom.dispose();
  }

  return group;
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
