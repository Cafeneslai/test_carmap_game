/**
 * TerrainGenerator.js — Generate terrain mesh from DEM elevation grid
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CHUNK_SIZE, TERRAIN_RESOLUTION, TERRAIN_Y_SCALE } from '../config.js';

/**
 * Generate terrain mesh and physics body from elevation data
 * 
 * @param {number[][]} elevationGrid - 2D array of elevation values
 * @param {number} chunkWorldX - Chunk center X in world meters
 * @param {number} chunkWorldZ - Chunk center Z in world meters
 * @param {number} originLat
 * @param {number} originLng
 * @returns {{ mesh: THREE.Mesh | null, body: CANNON.Body | null }}
 */
/**
 * @param {THREE.Texture | null} [groundTexture] painted land cover (GroundPainter); without it the
 *   terrain is coloured by height only (also what the Node verify script gets)
 * @param {THREE.Texture | null} [detailTexture] shared fine-grain bump map, sampled through uv1
 */
export function generateTerrain(elevationGrid, chunkWorldX, chunkWorldZ, originLat, originLng, baseElevation = null, groundTexture = null, detailTexture = null) {
  if (!elevationGrid || elevationGrid.length === 0) {
    return { mesh: null, body: null };
  }

  const res = elevationGrid.length;
  const geometry = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, res - 1, res - 1);
  geometry.rotateX(-Math.PI / 2); // lay flat

  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);

  // Find min/max elevation for color mapping
  let minElev = Infinity, maxElev = -Infinity;
  for (let row = 0; row < res; row++) {
    for (let col = 0; col < res; col++) {
      const e = elevationGrid[row][col];
      if (e < minElev) minElev = e;
      if (e > maxElev) maxElev = e;
    }
  }

  // Compute base elevation if not provided
  if (baseElevation === null) {
    const centerRow = Math.floor(res / 2);
    const centerCol = Math.floor(res / 2);
    baseElevation = elevationGrid[centerRow]?.[centerCol] ?? 0;
  }

  // Color palette for terrain. With a painted ground texture the vertex colour only tints it
  // (slightly browner and greyer up high), so it stays close to white.
  const colorLow = new THREE.Color(groundTexture ? 0xffffff : 0x4a7c3f);   // green grass
  const colorMid = new THREE.Color(groundTexture ? 0xf2e8d8 : 0x8b7d5b);   // brown earth
  const colorHigh = new THREE.Color(groundTexture ? 0xd8d6d2 : 0x9e9585);  // gray rock

  const elevRange = Math.max(maxElev - minElev, 1);

  for (let i = 0; i < positions.count; i++) {
    // Map vertex index to grid position
    const col = i % res;
    const row = Math.floor(i / res);

    // Apply elevation (relative to base elevation for smoothness)
    const elevation = (elevationGrid[row]?.[col] ?? baseElevation) - baseElevation;
    positions.setY(i, elevation * TERRAIN_Y_SCALE);

    // Vertex color based on elevation
    const t = elevRange > 0 ? (elevationGrid[row]?.[col] - minElev) / elevRange : 0;
    const color = new THREE.Color();

    if (t < 0.5) {
      color.lerpColors(colorLow, colorMid, t * 2);
    } else {
      color.lerpColors(colorMid, colorHigh, (t - 0.5) * 2);
    }

 
    // Slight noise to break up flat colors; from the world position, so chunk edges match
    const wx = positions.getX(i) + chunkWorldX, wz = positions.getZ(i) + chunkWorldZ;
    const noise = groundTexture ? 0 : ((Math.sin(wx * 12.9898 + wz * 78.233) * 43758.5453) % 1) * 0.02;
    
    colors[i * 3] = color.r + noise;
    colors[i * 3 + 1] = color.g + noise;
    colors[i * 3 + 2] = color.b + noise;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  // uv1 in world metres / 3: the detail bump repeats every 3 m and lines up across chunks
  const uv1 = new Float32Array(positions.count * 2);
  for (let i = 0; i < positions.count; i++) {
    uv1[i * 2] = (positions.getX(i) + chunkWorldX) / 3;
    uv1[i * 2 + 1] = (positions.getZ(i) + chunkWorldZ) / 3;
  }
  geometry.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0.0,
    flatShading: false,
    map: groundTexture,
    bumpMap: detailTexture,
    bumpScale: 1.5,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.ownTexture = !!groundTexture; // painted for this chunk only: free it with the chunk
  mesh.position.set(chunkWorldX, 0, chunkWorldZ);
  mesh.receiveShadow = true;

  // Physics: Create heightfield
  const heightData = [];
  for (let col = 0; col < res; col++) {
    const colData = [];
    // Reverse row order to match the Three.js PlaneGeometry (which builds top-to-bottom along -Z)
    for (let row = res - 1; row >= 0; row--) {
      colData.push(((elevationGrid[row]?.[col] ?? baseElevation) - baseElevation) * TERRAIN_Y_SCALE);
    }
    heightData.push(colData);
  }

  const heightfieldShape = new CANNON.Heightfield(heightData, {
    elementSize: CHUNK_SIZE / (res - 1),
  });

  const body = new CANNON.Body({ mass: 0 });
  body.addShape(heightfieldShape);
  body.position.set(
    chunkWorldX - CHUNK_SIZE / 2,
    0,
    chunkWorldZ + CHUNK_SIZE / 2
  );
  body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);

  return { mesh, body };
}
