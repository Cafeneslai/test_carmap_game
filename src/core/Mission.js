/**
 * Mission.js — checkpoint run: drive to a random point on a real road, then to the next one.
 */

import * as THREE from 'three';
import { DRIVABLE } from '../data/OSMFetcher.js';
import { latLngToMeters } from '../data/GeoUtils.js';

const MIN_DIST = 150;   // m, so a checkpoint is never right next to the car
const MAX_DIST = 450;   // m, stays inside the loaded chunks (view distance 3 x 200 m)
const REACH_DIST = 12;  // m, counts as reached
const BEAM_HEIGHT = 60;

/**
 * A random point on a drivable road between minDist and maxDist from the car.
 * @param {object[]} roads OSM ways
 * @param {{ x: number, z: number }} from car position
 * @param {() => number} rand
 * @returns {{ x: number, z: number, name: string } | null}
 */
export function pickCheckpoint(roads, originLat, originLng, from, minDist = MIN_DIST, maxDist = MAX_DIST, rand = Math.random) {
  const candidates = [];
  for (const road of roads) {
    if (!DRIVABLE.has(road.tags?.highway)) continue;
    for (const node of road.geometry) {
      const { x, z } = latLngToMeters(node.lat, node.lon, originLat, originLng);
      const d = Math.hypot(x - from.x, z - from.z);
      if (d >= minDist && d <= maxDist) candidates.push({ x, z, name: road.tags.name || 'ถนนไม่มีชื่อ' });
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rand() * candidates.length)];
}

export class Mission {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.target = null;
    this.count = 0;
    this.elapsed = 0;  // seconds on the current checkpoint
    this.lastTime = null;
    this.retryIn = 0;  // seconds until the next search when no road was far enough

    // Glowing beam + ground ring, visible from far away and through fog
    this.marker = new THREE.Group();
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(2, 2, BEAM_HEIGHT, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false, fog: false })
    );
    beam.position.y = BEAM_HEIGHT / 2;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(REACH_DIST * 0.7, 0.4, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xffcc00, fog: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.5;
    this.marker.add(beam, ring);
    this.marker.visible = false;
    scene.add(this.marker);
  }

  /**
   * @param {number} delta seconds
   * @param {{ x: number, z: number }} carPos
   * @param {import('../world/ChunkManager.js').ChunkManager} chunkManager
   * @returns {{ distance: number, angle: number, elapsed: number, count: number, lastTime: number | null, name: string } | null}
   *   angle: direction to the target in world yaw (same convention as the car heading)
   */
  update(delta, carPos, chunkManager) {
    if (!this.target) {
      this.retryIn -= delta;
      if (this.retryIn > 0) return this._reachedInfo();
      this.retryIn = 1;
      const wb = chunkManager.worldBuilder;
      this.target = pickCheckpoint(chunkManager.getLoadedRoads(), wb.originLat, wb.originLng, carPos);
      if (!this.target) return this._reachedInfo(); // no road far enough is loaded yet; retry in 1 s
      const y = chunkManager.getTerrainHeight(this.target.x, this.target.z) ?? 0;
      this.marker.position.set(this.target.x, y, this.target.z);
      this.marker.visible = true;
      this.elapsed = 0;
    }

    this.elapsed += delta;
    this.marker.rotation.y += delta;
    const dx = this.target.x - carPos.x;
    const dz = this.target.z - carPos.z;
    const distance = Math.hypot(dx, dz);

    if (distance < REACH_DIST) {
      this.count++;
      this.lastTime = this.elapsed;
      this.target = null;
      this.marker.visible = false;
      this.retryIn = 2; // keep "reached!" on screen for a moment
      return this._reachedInfo();
    }

    return { distance, angle: Math.atan2(dx, dz), elapsed: this.elapsed, count: this.count, lastTime: this.lastTime, name: this.target.name };
  }

  /** HUD info while there is no target: "reached" after the first checkpoint, otherwise null (searching) */
  _reachedInfo() {
    if (this.count === 0) return null;
    return { distance: 0, angle: 0, elapsed: 0, count: this.count, lastTime: this.lastTime, name: '' };
  }

  dispose() {
    this.scene.remove(this.marker);
    this.marker.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
  }
}
