/**
 * ElevationField.js — one shared lattice of elevation samples for the whole world.
 *
 * Instead of asking the elevation service for a fresh 8x8 grid per chunk (64 coordinates each, which
 * exhausts the free quota within a few chunks and leaves flat holes), the world is covered by a
 * lattice spaced SPACING metres apart, which is already about the resolution of the 90 m DEM.
 * Each chunk's grid is interpolated from the lattice, so:
 *   - neighbouring chunks share their edge samples exactly, the terrain has no seams,
 *   - a 3x3 block of chunks needs only 49 coordinates, and each new chunk 3-5,
 *   - requests made in the same moment are merged into batches of up to 100.
 *
 * Lattice node (i, j) sits at world (i * SPACING, j * SPACING); +Z is south, so larger j is further south.
 */

import { CHUNK_SIZE } from '../config.js';
import { metersToLatLng } from './GeoUtils.js';
import { fetchElevations, MAX_POINTS_PER_REQUEST } from './ElevationFetcher.js';

const SPACING = CHUNK_SIZE / 2;
const BATCH_DELAY_MS = 20;

export class ElevationField {
  /**
   * @param {number} originLat
   * @param {number} originLng
   * @param {(points: {lat: number, lng: number}[]) => Promise<number[]>} [fetchBatch] injectable for tests
   */
  constructor(originLat, originLng, fetchBatch = fetchElevations) {
    this.originLat = originLat;
    this.originLng = originLng;
    this.fetchBatch = fetchBatch;

    /** @type {Map<string, number>} */
    this.values = new Map();
    /** @type {Map<string, { promise: Promise<number>, resolve: Function, reject: Function }>} */
    this.pending = new Map();
    /** @type {string[]} */
    this.queue = [];
    this.timer = null;
    this.chain = Promise.resolve();
    this.requestedPoints = 0;
  }

  _key(i, j) {
    return `${i},${j}`;
  }

  /** Resolve with the elevation of one lattice node, fetching it (batched) if needed */
  _node(i, j) {
    const key = this._key(i, j);
    if (this.values.has(key)) return Promise.resolve(this.values.get(key));

    let entry = this.pending.get(key);
    if (!entry) {
      entry = {};
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      this.pending.set(key, entry);
      this.queue.push(key);
      if (!this.timer) this.timer = setTimeout(() => this._flush(), BATCH_DELAY_MS);
    }
    return entry.promise;
  }

  _flush() {
    this.timer = null;
    const keys = this.queue.splice(0);
    for (let start = 0; start < keys.length; start += MAX_POINTS_PER_REQUEST) {
      const batch = keys.slice(start, start + MAX_POINTS_PER_REQUEST);
      // Sequential, so a burst of chunks never turns into a burst of requests
      this.chain = this.chain.then(() => this._fetchBatch(batch));
    }
  }

  async _fetchBatch(keys) {
    const points = keys.map((key) => {
      const [i, j] = key.split(',').map(Number);
      return metersToLatLng(i * SPACING, j * SPACING, this.originLat, this.originLng);
    });
    this.requestedPoints += points.length;

    try {
      const elevations = await this.fetchBatch(points);
      keys.forEach((key, n) => {
        this.values.set(key, elevations[n]);
        this.pending.get(key)?.resolve(elevations[n]);
        this.pending.delete(key);
      });
    } catch (err) {
      // Forget the nodes so a later chunk can try again
      for (const key of keys) {
        this.pending.get(key)?.reject(err);
        this.pending.delete(key);
      }
    }
  }

  /**
   * Elevation grid for one chunk: [row][col], row 0 = north edge (-Z), col 0 = west edge (-X).
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {number} resolution samples per side
   * @returns {Promise<{ grid: number[][], complete: boolean }>}
   *   complete is false when some lattice nodes could not be fetched and were estimated;
   *   such a grid is fine to show but must not be cached.
   * @throws when no lattice node at all could be fetched
   */
  async sampleChunk(chunkX, chunkZ, resolution) {
    const iMin = chunkX * 2 - 1;
    const jMin = chunkZ * 2 - 1;
    const span = CHUNK_SIZE / SPACING; // 2 cells per chunk side

    const jobs = [];
    for (let dj = 0; dj <= span; dj++) {
      for (let di = 0; di <= span; di++) {
        jobs.push(this._node(iMin + di, jMin + dj).then((v) => v, () => null));
      }
    }
    const nodes = await Promise.all(jobs);

    const known = nodes.filter((v) => v !== null);
    if (known.length === 0) throw new Error('Elevation unavailable');
    const complete = known.length === nodes.length;
    const mean = known.reduce((a, b) => a + b, 0) / known.length;
    const at = (di, dj) => {
      const v = nodes[dj * (span + 1) + di];
      return v === null ? mean : v;
    };

    const grid = [];
    for (let row = 0; row < resolution; row++) {
      const line = [];
      const v = (row / (resolution - 1)) * span; // 0..span along the north->south axis
      const j0 = Math.min(Math.floor(v), span - 1);
      const ty = v - j0;
      for (let col = 0; col < resolution; col++) {
        const u = (col / (resolution - 1)) * span;
        const i0 = Math.min(Math.floor(u), span - 1);
        const tx = u - i0;
        const top = at(i0, j0) * (1 - tx) + at(i0 + 1, j0) * tx;
        const bottom = at(i0, j0 + 1) * (1 - tx) + at(i0 + 1, j0 + 1) * tx;
        line.push(top * (1 - ty) + bottom * ty);
      }
      grid.push(line);
    }

    return { grid, complete };
  }
}
