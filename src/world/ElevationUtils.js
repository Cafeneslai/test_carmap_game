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
export function getElevationAt(localX, localZ, elevationGrid, baseElevation = null) {
  if (!elevationGrid || elevationGrid.length === 0) return 0;
  const res = elevationGrid.length;
  
  // Use passed baseElevation, or compute center of chunk as fallback
  if (baseElevation === null) {
    const centerRow = Math.floor(res / 2);
    const centerCol = Math.floor(res / 2);
    baseElevation = elevationGrid[centerRow]?.[centerCol] ?? 0;
  }

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

  // Same two triangles per cell as the terrain mesh (PlaneGeometry splits along row+1/col to row/col+1),
  // so roads, buildings and trees sit exactly on the drawn ground; bilinear sat up to ~1 m off it
  const e = tx + ty <= 1
    ? e00 + (e10 - e00) * tx + (e01 - e00) * ty
    : e11 + (e01 - e11) * (1 - tx) + (e10 - e11) * (1 - ty);

  return e * TERRAIN_Y_SCALE;
}
