/**
 * ChunkManager.js — Manages fast initial loading and background chunk streaming
 */

import {
  CHUNK_SIZE,
  VIEW_DISTANCE,
  INITIAL_VIEW_DISTANCE,
  MAX_CONCURRENT_LOADS,
  CHUNK_UNLOAD_BUFFER,
} from '../config.js';
import { Chunk, CHUNK_STATES } from './Chunk.js';
import { WorldBuilder } from './WorldBuilder.js';

export class ChunkManager {
  /**
   * @param {import('three').Scene} scene
   * @param {import('cannon-es').World} physicsWorld
   * @param {number} originLat
   * @param {number} originLng
   */
  constructor(scene, physicsWorld, originLat, originLng) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.originLat = originLat;
    this.originLng = originLng;

    /** @type {Map<string, Chunk>} */
    this.chunks = new Map();

    /** @type {Set<string>} */
    this.loadingChunks = new Set();

    /** @type {Set<string>} */
    this.requiredChunks = new Set();

    /** @type {{ key: string, cx: number, cz: number, dist: number }[]} */
    this.loadQueue = [];

    this.worldBuilder = new WorldBuilder(originLat, originLng);
    this.initialViewDistance = INITIAL_VIEW_DISTANCE ?? 0;
    this.viewDistance = VIEW_DISTANCE;

    this.lastPlayerChunkX = null;
    this.lastPlayerChunkZ = null;
  }

  /**
   * Convert world position to chunk grid coordinate
   */
  _worldToChunk(x, z) {
    return {
      cx: Math.floor(x / CHUNK_SIZE + 0.5),
      cz: Math.floor(z / CHUNK_SIZE + 0.5),
    };
  }

  /**
   * Get chunk key string
   */
  _chunkKey(cx, cz) {
    return `${cx},${cz}`;
  }

  _getChunksInRadius(cx, cz, radius) {
    const chunks = [];
    const reach = Math.floor(radius); // radius may be fractional, e.g. 1.5 = full 3x3 block
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const dist = Math.hypot(dx, dz);
        if (dist <= radius) {
          chunks.push({ cx: cx + dx, cz: cz + dz, dist });
        }
      }
    }
    return chunks.sort((a, b) => a.dist - b.dist);
  }

  /**
   * Load initial chunks around origin (called during game start)
   * Only loads the immediate starting chunk so player can drive in <2 seconds!
   * @param {(progress: number, text?: string) => void} onProgress
   */
  async loadInitialChunks(onProgress) {
    const chunksToLoad = this._getChunksInRadius(0, 0, this.initialViewDistance);
    const total = chunksToLoad.length || 1;

    for (let i = 0; i < total; i++) {
      const { cx, cz } = chunksToLoad[i];
      const key = this._chunkKey(cx, cz);

      if (!this.chunks.has(key)) {
        onProgress(i / total, 'กำลังสร้างสภาพแวดล้อมเริ่มต้น...');
        await this._loadChunk(cx, cz);
      }
    }

    onProgress(1, 'พร้อมออกเดินทาง! กำลังสตรีมพื้นที่รอบข้าง...');

    // Force first update() call to populate and stream outer chunks in background
    this.lastPlayerChunkX = null;
    this.lastPlayerChunkZ = null;
  }

  /**
   * Update: load/unload chunks based on player position
   * @param {{ x: number, y: number, z: number }} playerPos
   */
  update(playerPos) {
    const { cx, cz } = this._worldToChunk(playerPos.x, playerPos.z);

    if (cx === this.lastPlayerChunkX && cz === this.lastPlayerChunkZ) {
      this._pumpLoadQueue();
      return;
    }

    this.lastPlayerChunkX = cx;
    this.lastPlayerChunkZ = cz;

    // Determine which chunks should be loaded
    const inRadius = this._getChunksInRadius(cx, cz, this.viewDistance);
    const requiredChunks = new Set(inRadius.map(({ cx: gx, cz: gz }) => this._chunkKey(gx, gz)));
    this.requiredChunks = requiredChunks;

    // Unload chunks that are too far
    const unloadDistance = this.viewDistance + CHUNK_UNLOAD_BUFFER;
    for (const [key, chunk] of this.chunks) {
      if (!requiredChunks.has(key)) {
        const dx = chunk.chunkX - cx;
        const dz = chunk.chunkZ - cz;
        if (Math.hypot(dx, dz) > unloadDistance) {
          this._unloadChunk(key, chunk);
        }
      }
    }

    // Build prioritize list to load
    const toLoad = [];
    for (const item of inRadius) {
      const key = this._chunkKey(item.cx, item.cz);
      if (!this.chunks.has(key) && !this.loadingChunks.has(key)) {
        toLoad.push({ key, cx: item.cx, cz: item.cz, dist: item.dist });
      }
    }

    this.loadQueue = toLoad;
    this._pumpLoadQueue();
  }

  /**
   * Pump chunk queue up to MAX_CONCURRENT_LOADS
   */
  _pumpLoadQueue() {
    while (this.loadingChunks.size < MAX_CONCURRENT_LOADS && this.loadQueue.length > 0) {
      const next = this.loadQueue.shift();
      if (!this.requiredChunks.has(next.key) || this.chunks.has(next.key) || this.loadingChunks.has(next.key)) {
        continue;
      }
      this._loadChunk(next.cx, next.cz);
    }
  }

  /**
   * Change how many chunks around the car are kept loaded (applies on the next update)
   * @param {number} distance
   */
  setViewDistance(distance) {
    this.viewDistance = Math.max(1, Math.round(distance));
    this.lastPlayerChunkX = null;
    this.lastPlayerChunkZ = null;
  }

  /**
   * Show or hide trees in every loaded chunk, and in chunks loaded later
   * @param {boolean} enabled
   */
  setTreesEnabled(enabled) {
    this.worldBuilder.treesEnabled = enabled;
    for (const chunk of this.chunks.values()) {
      const trees = chunk.meshGroup.getObjectByName('vegetation');
      if (trees) trees.visible = enabled;
    }
  }

  /**
   * Terrain height (relative to the start elevation) under a world position,
   * or null while that chunk is not loaded yet.
   */
  getTerrainHeight(x, z) {
    return this.worldBuilder.getTerrainHeight(this.chunks, x, z);
  }

  /** All roads of the chunks that are currently loaded */
  getLoadedRoads() {
    const roads = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.osmData) roads.push(...chunk.osmData.roads);
    }
    return roads;
  }

  /**
   * Load a single chunk
   */
  async _loadChunk(cx, cz) {
    const key = this._chunkKey(cx, cz);
    if (this.chunks.has(key) || this.loadingChunks.has(key)) return;

    this.loadingChunks.add(key);

    const chunk = new Chunk(cx, cz, this.originLat, this.originLng);
    chunk.state = CHUNK_STATES.LOADING;

    try {
      await this.worldBuilder.buildChunk(chunk, this.scene, this.physicsWorld);
      chunk.state = CHUNK_STATES.READY;
      this.scene.add(chunk.meshGroup);
      this.chunks.set(key, chunk);
    } catch (err) {
      console.warn(`Failed to load chunk ${key}:`, err);
    } finally {
      this.loadingChunks.delete(key);
      this._pumpLoadQueue();
    }
  }

  /**
   * Unload a chunk
   */
  _unloadChunk(key, chunk) {
    chunk.dispose(this.scene, this.physicsWorld);
    this.chunks.delete(key);
  }

  /**
   * Dispose everything
   */
  dispose() {
    for (const [key, chunk] of this.chunks) {
      chunk.dispose(this.scene, this.physicsWorld);
    }
    this.chunks.clear();
    this.loadingChunks.clear();
    this.requiredChunks.clear();
    this.loadQueue = [];
  }
}
