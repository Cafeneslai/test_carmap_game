/**
 * ChunkManager.js — Manages loading/unloading of world chunks around the player
 */

import { CHUNK_SIZE, VIEW_DISTANCE, MAX_CONCURRENT_LOADS, CHUNK_UNLOAD_BUFFER } from '../config.js';
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

    this.worldBuilder = new WorldBuilder(originLat, originLng);

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

  /**
   * Load initial chunks around origin (called during game start)
   * @param {(progress: number, text?: string) => void} onProgress
   */
  async loadInitialChunks(onProgress) {
    const chunksToLoad = [];

    // Load in a circle around origin
    for (let dx = -VIEW_DISTANCE; dx <= VIEW_DISTANCE; dx++) {
      for (let dz = -VIEW_DISTANCE; dz <= VIEW_DISTANCE; dz++) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= VIEW_DISTANCE) {
          chunksToLoad.push({ cx: dx, cz: dz, dist });
        }
      }
    }

    // Sort by distance (closest first)
    chunksToLoad.sort((a, b) => a.dist - b.dist);

    const total = chunksToLoad.length;

    for (let i = 0; i < total; i++) {
      const { cx, cz } = chunksToLoad[i];
      const key = this._chunkKey(cx, cz);

      if (!this.chunks.has(key)) {
        const progressText = i < 2
          ? 'กำลังดึงข้อมูลถนนและอาคาร...'
          : i < total * 0.5
            ? 'กำลังสร้างภูมิประเทศ...'
            : i < total * 0.8
              ? 'กำลังวางต้นไม้และอาคาร...'
              : 'กำลังปรับแต่งรายละเอียด...';

        onProgress(i / total, progressText);
        await this._loadChunk(cx, cz);
      }
    }

    onProgress(1, 'เสร็จสิ้น!');

    this.lastPlayerChunkX = 0;
    this.lastPlayerChunkZ = 0;
  }

  /**
   * Update: load/unload chunks based on player position
   * @param {{ x: number, y: number, z: number }} playerPos
   */
  update(playerPos) {
    const { cx, cz } = this._worldToChunk(playerPos.x, playerPos.z);

    // Only process if player moved to a new chunk
    if (cx === this.lastPlayerChunkX && cz === this.lastPlayerChunkZ) {
      return;
    }

    this.lastPlayerChunkX = cx;
    this.lastPlayerChunkZ = cz;

    // Determine which chunks should be loaded
    const requiredChunks = new Set();

    for (let dx = -VIEW_DISTANCE; dx <= VIEW_DISTANCE; dx++) {
      for (let dz = -VIEW_DISTANCE; dz <= VIEW_DISTANCE; dz++) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= VIEW_DISTANCE) {
          requiredChunks.add(this._chunkKey(cx + dx, cz + dz));
        }
      }
    }

    // Unload chunks that are too far
    const unloadDistance = VIEW_DISTANCE + CHUNK_UNLOAD_BUFFER;
    for (const [key, chunk] of this.chunks) {
      if (!requiredChunks.has(key)) {
        const dx = chunk.chunkX - cx;
        const dz = chunk.chunkZ - cz;
        if (Math.sqrt(dx * dx + dz * dz) > unloadDistance) {
          this._unloadChunk(key, chunk);
        }
      }
    }

    // Load new chunks (prioritize by distance)
    const toLoad = [];
    for (const key of requiredChunks) {
      if (!this.chunks.has(key) && !this.loadingChunks.has(key)) {
        const [gx, gz] = key.split(',').map(Number);
        const dist = Math.sqrt((gx - cx) ** 2 + (gz - cz) ** 2);
        toLoad.push({ key, cx: gx, cz: gz, dist });
      }
    }

    toLoad.sort((a, b) => a.dist - b.dist);

    // Load up to MAX_CONCURRENT_LOADS
    const canLoad = MAX_CONCURRENT_LOADS - this.loadingChunks.size;
    for (let i = 0; i < Math.min(canLoad, toLoad.length); i++) {
      const { cx: loadCx, cz: loadCz } = toLoad[i];
      this._loadChunk(loadCx, loadCz);
    }
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
  }
}
