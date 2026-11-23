/**
 * Chunk.js — Single chunk data container & mesh management
 */

import * as THREE from 'three';
import { CHUNK_SIZE } from '../config.js';
import { metersToLatLng, getBoundingBox } from '../data/GeoUtils.js';

export const CHUNK_STATES = {
  PENDING: 'PENDING',
  LOADING: 'LOADING',
  READY: 'READY',
  DISPOSING: 'DISPOSING',
};

export class Chunk {
  /**
   * @param {number} chunkX - Grid X coordinate
   * @param {number} chunkZ - Grid Z coordinate
   * @param {number} originLat - World origin latitude
   * @param {number} originLng - World origin longitude
   */
  constructor(chunkX, chunkZ, originLat, originLng) {
    this.chunkX = chunkX;
    this.chunkZ = chunkZ;
    this.originLat = originLat;
    this.originLng = originLng;
    this.state = CHUNK_STATES.PENDING;

    // World position (center of chunk in meters)
    this.worldX = chunkX * CHUNK_SIZE;
    this.worldZ = chunkZ * CHUNK_SIZE;

    // Three.js group for all meshes in this chunk
    this.meshGroup = new THREE.Group();
    this.meshGroup.position.set(this.worldX, 0, this.worldZ);

    // Raw data (filled during load)
    this.osmData = null;
    this.elevationData = null;

    // Physics bodies added to this chunk
    this.physicsBodies = [];

    // Unique key for caching (keyed by origin location + chunk coordinate)
    this.key = `chunk_${originLat.toFixed(4)}_${originLng.toFixed(4)}_${chunkX}_${chunkZ}`;
  }

  /**
   * Exact bounding box in lat/lng of this chunk (no padding). The elevation grid is sampled on
   * exactly this box so neighbouring chunks share their edge samples and the terrain has no seams.
   */
  getBBox() {
    const center = metersToLatLng(this.worldX, this.worldZ, this.originLat, this.originLng);
    return getBoundingBox(center.lat, center.lng, CHUNK_SIZE / 2);
  }

  /**
   * Get center lat/lng
   */
  getCenter() {
    return metersToLatLng(this.worldX, this.worldZ, this.originLat, this.originLng);
  }

  /**
   * Dispose all meshes and physics bodies
   * @param {THREE.Scene} scene
   * @param {import('cannon-es').World} physicsWorld
   */
  dispose(scene, physicsWorld) {
    this.state = CHUNK_STATES.DISPOSING;

    // Remove mesh group from scene
    scene.remove(this.meshGroup);

    // Dispose geometries and materials
    this.meshGroup.traverse((child) => {
      if (child.isInstancedMesh) child.dispose(); // frees the per-chunk instance buffers only
      if (child instanceof THREE.Mesh && !child.userData.shared) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      }
    });

    // Remove physics bodies
    for (const body of this.physicsBodies) {
      physicsWorld.removeBody(body);
    }
    this.physicsBodies = [];

    this.osmData = null;
    this.elevationData = null;
  }
}
