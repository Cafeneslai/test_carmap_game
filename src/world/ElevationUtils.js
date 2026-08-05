/**
 * ElevationUtils.js — Utilities for sampling elevation data
 */
import { CHUNK_SIZE, TERRAIN_RESOLUTION, TERRAIN_Y_SCALE } from '../config.js';

/**
 * Get interpolated Y elevation at local (x, z) coordinates within a chunk
 * 
 * @param {number} localX - Local X coordinate (-CHUNK_SIZE/2 to +CHUNK_SIZE/2)
 * @param {number} localZ - Local Z coordinate (-CHUNK_SIZE/2 to +CHUNK_SIZE/2)
 * @param {number[][]} elevationGrid - The chunk's elevation data grid
 * @returns {number} The interpolated Y elevation
 */
export function getElevationAt(localX, localZ, elevationGrid) {
  if (!elevationGrid || elevationGrid.length === 0) return 0;
  const res = TERRAIN_RESOLUTION;
  
  // Calculate base elevation (center of chunk) to match TerrainGenerator.js
  const centerRow = Math.floor(res / 2);
  const centerCol = Math.floor(res / 2);
  const baseElevation = elevationGrid[centerRow]?.[centerCol] ?? 0;

  // Map x, z to grid float indices
  const colF = (localX + CHUNK_SIZE / 2) / CHUNK_SIZE * (res - 1);
  const rowF = (localZ + CHUNK_SIZE / 2) / CHUNK_SIZE * (res - 1);

  // If outside chunk, clamp to edges
  const col = Math.max(0, Math.min(res - 1, colF));
  const row = Math.max(0, Math.min(res - 1, rowF));

  const col0 = Math.floor(col);
  const col1 = Math.min(res - 1, col0 + 1);
  const row0 = Math.floor(row);
  const row1 = Math.min(res - 1, row0 + 1);

  const tx = col - col0;
  const ty = row - row0;

  const getE = (r, c) => (elevationGrid[r]?.[c] ?? baseElevation) - baseElevation;

  const e00 = getE(row0, col0);
  const e10 = getE(row0, col1);
  const e01 = getE(row1, col0);
  const e11 = getE(row1, col1);

  // Bilinear interpolation
  const e0 = e00 * (1 - tx) + e10 * tx;
  const e1 = e01 * (1 - tx) + e11 * tx;
  const e = e0 * (1 - ty) + e1 * ty;

  return e * TERRAIN_Y_SCALE;
}
