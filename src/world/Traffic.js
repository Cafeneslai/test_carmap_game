/**
 * Traffic.js — NPC cars that drive along the real roads around the player.
 *
 * Each car follows one OSM way at a time in its lane (left or right by country), keeps a gap to the
 * car in front and to the player, stops at red traffic lights and picks another way at the end of
 * the current one. Multi-lane roads (OSM `lanes`) let cars overtake slower ones; corners and lane jumps
 * are eased so cars turn in an arc, and they slow down before sharp turns.
 * Cars are kinematic physics bodies: the player bumps into them, they never tip over.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ROAD_WIDTHS } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { signalKey, signalPhase, signalState } from './TrafficLights.js';

const MAX_CARS = 12;
const SPAWN_MIN = 60, SPAWN_MAX = 300; // metres from the player
const DESPAWN = 420;
const SAFE_GAP = 9;      // metres kept to the car / player in front
const STOP_LINE = 8;     // metres before a signal node where cars stop
const ACCEL = 2.5, BRAKE = 7; // m/s²
const TURN_SPEED = 5.5;  // m/s through a junction turn sharper than 45°
const EASE = 3;          // 1/s: how fast the drawn car closes in on its lane (turn arcs, lane changes)

const ROAD_SPEED_KMH = {
  motorway: 90, trunk: 70, primary: 50, secondary: 45, tertiary: 40,
  motorway_link: 50, trunk_link: 40, primary_link: 35, secondary_link: 35, tertiary_link: 30,
  residential: 30, unclassified: 30, living_street: 15, road: 30,
};

const CAR_COLORS = [0xd8d8d8, 0x1d1f24, 0x8a1c1c, 0x1f4f8a, 0x9aa0a6, 0xe8e2d0, 0x2f5f3a];
const bodyGeometry = new THREE.BoxGeometry(1.8, 0.7, 4.2).translate(0, 0.6, 0);
const cabinGeometry = new THREE.BoxGeometry(1.6, 0.6, 2.1).translate(0, 1.25, -0.2);
const wheelGeometry = new THREE.CylinderGeometry(0.33, 0.33, 0.25, 10).rotateZ(Math.PI / 2);
const lampGeometry = new THREE.BoxGeometry(0.35, 0.15, 0.05);
const bodyMaterials = CAR_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.1 }));
// Low metalness: there is no environment map, so metallic paint and glass would render near-black
const glassMaterial = new THREE.MeshStandardMaterial({ color: 0x3b4f63, roughness: 0.2, metalness: 0.1 });
const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
const headMaterial = new THREE.MeshBasicMaterial({ color: 0xfff4d0 });
const tailMaterial = new THREE.MeshBasicMaterial({ color: 0xaa1010 });

function buildCarMesh(colorIndex) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(bodyGeometry, bodyMaterials[colorIndex % bodyMaterials.length]);
  const cabin = new THREE.Mesh(cabinGeometry, glassMaterial);
  body.castShadow = cabin.castShadow = true;
  g.add(body, cabin);
  for (const [x, z] of [[-0.85, 1.3], [0.85, 1.3], [-0.85, -1.3], [0.85, -1.3]]) {
    const w = new THREE.Mesh(wheelGeometry, wheelMaterial);
    w.position.set(x, 0.33, z);
    g.add(w);
  }
  for (const x of [-0.6, 0.6]) {
    const head = new THREE.Mesh(lampGeometry, headMaterial);
    head.position.set(x, 0.7, 2.11);
    const tail = new THREE.Mesh(lampGeometry, tailMaterial);
    tail.position.set(x, 0.75, -2.11);
    g.add(head, tail);
  }
  return g;
}

/** Road way prepared for driving: points in metres, lengths, signal positions */
function prepare(road, originLat, originLng, signalKeys) {
  const pts = road.geometry.map((n) => {
    const { x, z } = latLngToMeters(n.lat, n.lon, originLat, originLng);
    return new THREE.Vector2(x, z);
  });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const way = { road, pts, cum, length: cum[cum.length - 1], signals: [] };
  findSignals(way, signalKeys);
  return way;
}

/** Distances along the way of its traffic-signal nodes (signals arrive as chunks load, so redone on refresh) */
function findSignals(way, signalKeys) {
  way.signals = [];
  way.road.geometry.forEach((n, i) => { if (signalKeys.has(signalKey(n))) way.signals.push(way.cum[i]); });
}

/** Lanes in one direction: OSM `lanes`, else guessed from the drawn width */
export function lanesPerDirection(road) {
  const oneway = road.tags.oneway === 'yes';
  const total = parseInt(road.tags.lanes, 10);
  if (total > 0) return Math.max(1, oneway ? total : Math.floor(total / 2));
  const width = ROAD_WIDTHS[road.tags.highway] ?? 5;
  return width >= (oneway ? 7 : 10) ? 2 : 1;
}

/** Sideways offset from the centre line of lane `lane` (0 = outermost) on the driver's side */
function laneOffset(road, lane) {
  const width = ROAD_WIDTHS[road.tags.highway] ?? 5;
  const n = lanesPerDirection(road);
  if (road.tags.oneway === 'yes') return width / 2 - (width / n) * (lane + 0.5);
  return width / 2 - (width / 2 / n) * (lane + 0.5);
}

/** Position and unit direction at distance s along a prepared way */
function sample(way, s) {
  const { pts, cum } = way;
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const len = cum[i] - cum[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / len));
  const dir = pts[i].clone().sub(pts[i - 1]).normalize();
  return { p: pts[i - 1].clone().lerp(pts[i], t), dir };
}

export class TrafficManager {
  /**
   * @param {THREE.Scene} scene
   * @param {CANNON.World} physicsWorld
   * @param {import('./ChunkManager.js').ChunkManager} chunkManager
   */
  constructor(scene, physicsWorld, chunkManager) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.chunkManager = chunkManager;
    this.leftHand = chunkManager.worldBuilder.leftHand;
    this.cars = [];
    this.enabled = true;
    this.spawnTimer = 0;
    this.graphTimer = 0;
    this.byNode = new Map(); // node key -> ways that contain it
    this.ways = [];
    this.wayCache = new Map(); // OSM way id -> prepared way
    this.signalKeys = new Set();
  }

  /** Rebuild the road graph from whatever chunks are loaded now */
  _refreshGraph() {
    const wb = this.chunkManager.worldBuilder;
    this.signalKeys = new Set();
    const seen = new Set();
    this.ways = [];
    this.byNode = new Map();
    for (const chunk of this.chunkManager.chunks.values()) {
      for (const s of chunk.osmData?.signals || []) this.signalKeys.add(signalKey(s));
    }
    for (const road of this.chunkManager.getLoadedRoads()) {
      if (seen.has(road.id) || !ROAD_SPEED_KMH[road.tags?.highway] || road.geometry.length < 2) continue;
      seen.add(road.id);
      let way = this.wayCache.get(road.id);
      if (!way) {
        way = prepare(road, wb.originLat, wb.originLng, this.signalKeys);
        this.wayCache.set(road.id, way);
      } else {
        findSignals(way, this.signalKeys);
      }
      if (way.length < 20) continue;
      this.ways.push(way);
      road.geometry.forEach((n, i) => {
        const k = signalKey(n);
        if (!this.byNode.has(k)) this.byNode.set(k, []);
        this.byNode.get(k).push({ way, index: i });
      });
    }
  }

  _spawn(playerPos) {
    if (this.ways.length === 0) return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const way = this.ways[Math.floor(Math.random() * this.ways.length)];
      const s = Math.random() * way.length;
      const { p } = sample(way, s);
      const d = Math.hypot(p.x - playerPos.x, p.y - playerPos.z);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      if (this.cars.some((c) => c.way === way && Math.abs(c.s - s) < SAFE_GAP * 2)) continue;
      const oneway = way.road.tags.oneway === 'yes';
      const dirSign = oneway || Math.random() < 0.5 ? 1 : -1;

      const mesh = buildCarMesh(Math.floor(Math.random() * CAR_COLORS.length));
      this.scene.add(mesh);
      const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.9, 0.55, 2.1)), new CANNON.Vec3(0, 0.75, 0));
      this.physicsWorld.addBody(body);
      const max = (ROAD_SPEED_KMH[way.road.tags.highway] / 3.6) * (0.85 + Math.random() * 0.25);
      const lane = Math.floor(Math.random() * lanesPerDirection(way.road));
      this.cars.push({ way, s, dirSign, lane, laneTimer: 0, next: null, speed: max * 0.5, max, mesh, body, y: null, pos: null, yaw: null });
      return;
    }
  }

  _remove(car) {
    this.scene.remove(car.mesh);
    this.physicsWorld.removeBody(car.body);
    this.cars.splice(this.cars.indexOf(car), 1);
  }

  /** Where the car goes at the end of its way: { way, s, dirSign, lane } (the same way reversed at a dead end), or null */
  _pickNext(car) {
    const endIndex = car.dirSign > 0 ? car.way.pts.length - 1 : 0;
    const node = car.way.road.geometry[endIndex];
    const options = (this.byNode.get(signalKey(node)) || []).filter(({ way, index }) => {
      if (way === car.way) return false;
      const oneway = way.road.tags.oneway === 'yes';
      const canForward = index < way.pts.length - 1;
      const canBackward = index > 0 && !oneway;
      return canForward || canBackward;
    });
    if (options.length === 0) {
      if (car.way.road.tags.oneway === 'yes') return null;
      return { way: car.way, s: car.way.cum[endIndex], dirSign: -car.dirSign, lane: car.lane }; // dead end: turn around
    }
    const { way, index } = options[Math.floor(Math.random() * options.length)];
    const oneway = way.road.tags.oneway === 'yes';
    const canForward = index < way.pts.length - 1;
    const canBackward = index > 0 && !oneway;
    const dirSign = canForward && (!canBackward || Math.random() < 0.5) ? 1 : -1;
    return { way, s: way.cum[index], dirSign, lane: Math.min(car.lane, lanesPerDirection(way.road) - 1) };
  }

  /** Cosine of the turn from the end of the current way onto car.next (1 = straight on, -1 = U-turn) */
  _turnCos(car) {
    const { next } = car;
    const a = sample(car.way, car.dirSign > 0 ? car.way.length : 0).dir.multiplyScalar(car.dirSign);
    const b = sample(next.way, next.s + next.dirSign * 0.5).dir.multiplyScalar(next.dirSign);
    return a.dot(b);
  }

  /** Move to the next lane over when stuck behind a slower car and that lane is clear */
  _maybeChangeLane(car, dt) {
    car.laneTimer -= dt;
    const n = lanesPerDirection(car.way.road);
    if (n < 2 || car.laneTimer > 0) return;
    const inLane = (lane) => this.cars.filter((o) => o !== car && o.way === car.way && o.dirSign === car.dirSign && o.lane === lane);
    const blocked = inLane(car.lane).some((o) => {
      const ahead = (o.s - car.s) * car.dirSign;
      return ahead > 0 && ahead < 30 && o.speed < car.max * 0.8;
    });
    if (!blocked) return;
    for (const lane of [car.lane + 1, car.lane - 1]) {
      if (lane < 0 || lane >= n || inLane(lane).some((o) => Math.abs(o.s - car.s) < 15)) continue;
      car.lane = lane;
      car.laneTimer = 5; // no weaving back and forth
      return;
    }
  }

  /** Speed limit right now from the things ahead: red lights, cars, the player */
  _allowedSpeed(car, playerPos, time) {
    let limit = car.max;
    const stopIn = (dist) => {
      // Speed from which the car can still stop in `dist` metres
      const v = Math.sqrt(Math.max(0, 2 * BRAKE * 0.6 * Math.max(0, dist)));
      limit = Math.min(limit, v);
    };

    // Traffic lights on this way, ahead of the car
    for (const sig of car.way.signals) {
      const ahead = (sig - car.s) * car.dirSign;
      if (ahead < STOP_LINE - 2 || ahead > 60) continue; // passed it already, or far away
      const { dir } = sample(car.way, sig - car.dirSign * 0.5);
      const state = signalState(signalPhase(dir.x * car.dirSign, dir.y * car.dirSign), time);
      // Yellow: stop only if there is room, otherwise drive through
      if (state === 'red' || (state === 'yellow' && ahead - STOP_LINE > (car.speed * car.speed) / (2 * BRAKE))) stopIn(ahead - STOP_LINE);
    }

    // Slow down before a sharp turn at the end of the way
    const toEnd = car.dirSign > 0 ? car.way.length - car.s : car.s;
    if (toEnd < 50) {
      car.next ??= this._pickNext(car);
      if (car.next && this._turnCos(car) < 0.7) limit = Math.min(limit, Math.sqrt(TURN_SPEED ** 2 + 2 * BRAKE * 0.6 * toEnd));
    }

    // Cars ahead in the same lane
    for (const other of this.cars) {
      if (other === car || other.way !== car.way || other.dirSign !== car.dirSign || other.lane !== car.lane) continue;
      const ahead = (other.s - car.s) * car.dirSign;
      if (ahead > 0 && ahead < 40) stopIn(ahead - SAFE_GAP);
    }

    // The player anywhere in front within a narrow cone
    const fwd = sample(car.way, car.s).dir.multiplyScalar(car.dirSign);
    const dx = playerPos.x - car.mesh.position.x, dz = playerPos.z - car.mesh.position.z;
    const along = dx * fwd.x + dz * fwd.y;
    const across = Math.abs(dx * fwd.y - dz * fwd.x);
    if (along > 0 && along < 35 && across < 3) stopIn(along - SAFE_GAP);
    return limit;
  }

  /**
   * @param {number} dt seconds
   * @param {{ x: number, y: number, z: number }} playerPos
   * @param {number} time game time, for traffic light phases
   */
  update(dt, playerPos, time) {
    if (!this.enabled) {
      while (this.cars.length) this._remove(this.cars[0]);
      return;
    }

    this.graphTimer -= dt;
    if (this.graphTimer <= 0) {
      this.graphTimer = 2; // chunks stream in and out; a 2 s old graph is fine
      this._refreshGraph();
    }
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.cars.length < MAX_CARS) {
      this.spawnTimer = 0.5;
      this._spawn(playerPos);
    }

    for (const car of [...this.cars]) {
      this._maybeChangeLane(car, dt);
      const target = this._allowedSpeed(car, playerPos, time);
      car.speed = target > car.speed ? Math.min(target, car.speed + ACCEL * dt) : Math.max(target, car.speed - BRAKE * dt);
      car.s += car.speed * dt * car.dirSign;

      if (car.s < 0 || car.s > car.way.length) {
        const over = car.s < 0 ? -car.s : car.s - car.way.length;
        const next = car.next ?? this._pickNext(car);
        if (!next) { this._remove(car); continue; }
        if (next.way !== car.way) car.max = (ROAD_SPEED_KMH[next.way.road.tags.highway] / 3.6) * (0.85 + Math.random() * 0.25);
        Object.assign(car, { way: next.way, dirSign: next.dirSign, lane: next.lane, next: null });
        car.s = Math.min(car.way.length, Math.max(0, next.s + over * car.dirSign));
      }

      const { p, dir } = sample(car.way, car.s);
      const fx = dir.x * car.dirSign, fz = dir.y * car.dirSign;
      // Keep to the lane: right of the centre line (left in left-hand-traffic countries)
      const lane = laneOffset(car.way.road, car.lane);
      const sx = this.leftHand ? fz : -fz, sz = this.leftHand ? -fx : fx;
      const tx = p.x + sx * lane, tz = p.y + sz * lane;
      // The drawn car moves with the road and eases toward its lane, so a jump of the target
      // (corner, new way, lane change, U-turn) becomes an arc instead of a teleport
      car.pos ??= new THREE.Vector2(tx, tz);
      car.pos.x += fx * car.speed * dt; car.pos.y += fz * car.speed * dt;
      const k = 1 - Math.exp(-EASE * dt);
      car.pos.x += (tx - car.pos.x) * k; car.pos.y += (tz - car.pos.y) * k;
      const x = car.pos.x, z = car.pos.y;

      const ground = this.chunkManager.getTerrainHeight(x, z);
      if (ground === null || Math.hypot(x - playerPos.x, z - playerPos.z) > DESPAWN) {
        this._remove(car); // left the loaded world, or too far to matter
        continue;
      }
      car.y = car.y === null ? ground : car.y + (ground - car.y) * Math.min(1, dt * 8);
      const yawTarget = Math.atan2(fx, fz);
      car.yaw ??= yawTarget;
      car.yaw += Math.atan2(Math.sin(yawTarget - car.yaw), Math.cos(yawTarget - car.yaw)) * Math.min(1, dt * 5);
      const yaw = car.yaw;
      car.mesh.position.set(x, car.y, z);
      car.mesh.rotation.y = yaw;
      car.body.position.set(x, car.y, z);
      car.body.quaternion.setFromEuler(0, yaw, 0);
      car.body.velocity.set(fx * car.speed, 0, fz * car.speed);
    }
  }

  dispose() {
    while (this.cars.length) this._remove(this.cars[0]);
  }
}
