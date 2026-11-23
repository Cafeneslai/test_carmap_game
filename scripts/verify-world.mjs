/**
 * verify-world.mjs — checks the things that broke the game before, without a browser.
 *
 *   npm run verify            offline: geometry orientation, terrain/physics agreement, driving, parsing
 *   npm run verify -- --online  also builds the real start area from OpenStreetMap and drives on it
 *
 * Each check encodes a bug that really happened (see the comment on it), so a regression fails loudly.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CarController } from '../src/vehicle/CarController.js';
import { generateTerrain } from '../src/world/TerrainGenerator.js';
import { generateRoads } from '../src/world/RoadGenerator.js';
import { generateBuildings } from '../src/world/BuildingGenerator.js';
import { generateWater } from '../src/world/WaterGenerator.js';
import { getElevationAt } from '../src/world/ElevationUtils.js';
import { metersToLatLng } from '../src/data/GeoUtils.js';
import { parseOsmXml, findSpawnPoint } from '../src/data/OSMFetcher.js';
import { ElevationField } from '../src/data/ElevationField.js';
import { headingToBearingDeg } from '../src/ui/compass.js';
import { CHUNK_SIZE } from '../src/config.js';
import { pickCheckpoint } from '../src/core/Mission.js';
import { lightingAt } from '../src/world/DayNight.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const section = (title) => console.log(`\n# ${title}`);

const ORIGIN = { lat: 13.2836, lng: 100.9268 };
const flat = () => Array.from({ length: 8 }, () => new Array(8).fill(0));
const at = (x, z) => {
  const p = metersToLatLng(x, z, ORIGIN.lat, ORIGIN.lng);
  return { lat: p.lat, lon: p.lng };
};
const square = (x0, z0, x1, z1) => [at(x0, z0), at(x1, z0), at(x1, z1), at(x0, z1), at(x0, z0)];

// ------------------------------------------------------------------------------------------
section('Geometry lands where OSM says (north = -Z, east = +X)');
{
  // Bug: ExtrudeGeometry/ShapeGeometry + rotateX(-PI/2) mirrored buildings and water across Z.
  const building = { id: 1, tags: { building: 'yes' }, geometry: square(40, -60, 60, -40) };
  const box = new THREE.Box3().setFromObject(generateBuildings([building], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0));
  check('building 50 m north of origin is at z -60..-40', near(box.min.z, -60, 1) && near(box.max.z, -40, 1), `z ${box.min.z.toFixed(1)}..${box.max.z.toFixed(1)}`);
  check('building 50 m east of origin is at x 40..60', near(box.min.x, 40, 1) && near(box.max.x, 60, 1));

  // Bug: buildings had no collider, so the car drove straight through them.
  // A 30x10 m block rotated 30 degrees: the box must cover its centre and stay off a point 10 m beside it.
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const rot = (u, w) => at(100 + u * c - w * s, 100 + u * s + w * c);
  const tilted = { id: 2, tags: { building: 'yes' }, geometry: [rot(-15, -5), rot(15, -5), rot(15, 5), rot(-15, 5), rot(-15, -5)] };
  const body = generateBuildings([tilted], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0).userData.body;
  const world = new CANNON.World();
  world.addBody(body);
  const hits = (x, z) => {
    const r = new CANNON.RaycastResult();
    world.raycastClosest(new CANNON.Vec3(x, 50, z), new CANNON.Vec3(x, -5, z), {}, r);
    return r.hasHit;
  };
  check('building collider covers the rotated footprint', hits(100, 100) && hits(100 + 14 * c, 100 + 14 * s));
  check('building collider does not spill past its walls', !hits(100 - 10 * s, 100 + 10 * c) && !hits(100 + 18 * c, 100 + 18 * s));

  const water = { tags: { natural: 'water' }, geometry: square(40, -60, 60, -40) };
  const wbox = new THREE.Box3().setFromObject(generateWater([water], 0, 0, ORIGIN.lat, ORIGIN.lng));
  check('lake 50 m north of origin is at z -60..-40', near(wbox.min.z, -60, 1) && near(wbox.max.z, -40, 1));

  // Bug: road triangles wound clockwise from above, so back-face culling hid every road.
  const road = { tags: { highway: 'residential' }, geometry: [at(-50, 0), at(0, 0), at(50, 0)] };
  const mesh = generateRoads([road], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0);
  const g = mesh.geometry;
  const p = g.attributes.position, idx = g.index;
  const v = (i) => new THREE.Vector3().fromBufferAttribute(p, idx.getX(i));
  let upCount = 0, tris = idx.count / 3;
  for (let t = 0; t < tris; t++) {
    const a = v(t * 3), b = v(t * 3 + 1), c = v(t * 3 + 2);
    if (new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).y > 0) upCount++;
  }
  check('every road triangle faces up (not culled from above)', upCount === tris, `${upCount}/${tris}`);
}

// ------------------------------------------------------------------------------------------
section('Terrain: elevation rows run north -> south; mesh and physics agree');
{
  // Bug: the fetcher put the south edge in row 0 while the mesh/physics treat row 0 as north.
  const grid = Array.from({ length: 8 }, (_, row) => new Array(8).fill((7 - row) * 10)); // north (row 0) is highest
  const { mesh, body } = generateTerrain(grid, 0, 0, 0, 0, 0);
  const pos = mesh.geometry.attributes.position;
  let top = { y: -Infinity, z: 0 };
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > top.y) top = { y: pos.getY(i), z: pos.getZ(i) };
  check('highest mesh vertex is on the north (-Z) side', top.z < 0, `z=${top.z}`);
  check('getElevationAt agrees (north high, south low)', getElevationAt(0, -90, grid, 0) > getElevationAt(0, 90, grid, 0));

  const world = new CANNON.World();
  world.addBody(body);
  const hit = (z) => {
    const r = new CANNON.RaycastResult();
    world.raycastClosest(new CANNON.Vec3(0, 500, z), new CANNON.Vec3(0, -500, z), {}, r);
    return r.hasHit ? r.hitPointWorld.y : NaN;
  };
  check('physics heightfield is also high in the north, low in the south', hit(-90) > hit(90) + 30, `north y=${hit(-90).toFixed(0)}, south y=${hit(90).toFixed(0)}`);
}

// ------------------------------------------------------------------------------------------
section('Elevation lattice (shared samples, few coordinates, no seams)');
{
  // 10% slope rising to the north: elevation = 0.1 * metres north of the origin
  const metresNorth = (lat) => (lat - ORIGIN.lat) * 111195;
  let calls = 0, points = 0;
  const fetchBatch = async (pts) => { calls++; points += pts.length; return pts.map((p) => metresNorth(p.lat) * 0.1); };

  const field = new ElevationField(ORIGIN.lat, ORIGIN.lng, fetchBatch);
  const grids = {};
  const coords = [];
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) coords.push([cx, cz]);
  await Promise.all(coords.map(async ([cx, cz]) => { grids[`${cx},${cz}`] = (await field.sampleChunk(cx, cz, 8)).grid; }));

  // Bug: 64 coordinates per chunk used up the free quota after a handful of chunks.
  check('a 3x3 block of chunks needs only 49 coordinates in one request', points === 49 && calls === 1, `${points} coordinates, ${calls} request(s) instead of ${9 * 64}`);

  const g = grids['0,0'];
  check('row 0 is the north edge (higher on a northward slope)', g[0][3] > g[7][3] + 10, `north ${g[0][3].toFixed(1)} m, south ${g[7][3].toFixed(1)} m`);
  check('the north edge of the middle chunk is 100 m * 10% = 10 m above the origin', near(g[0][3], 10, 0.5), `${g[0][3].toFixed(1)} m`);

  let seam = 0;
  for (let r = 0; r < 8; r++) {
    seam = Math.max(seam, Math.abs(grids['0,0'][r][7] - grids['1,0'][r][0])); // east edge vs neighbour's west edge
    seam = Math.max(seam, Math.abs(grids['0,0'][7][r] - grids['0,1'][0][r])); // south edge vs neighbour's north edge
  }
  check('neighbouring chunks share their edge heights exactly (no seams)', seam < 1e-6, `max gap ${seam.toExponential(1)} m`);

  const before = points;
  await field.sampleChunk(1, 0, 8);
  check('a chunk that was already sampled costs no new requests', points === before);

  const dead = new ElevationField(ORIGIN.lat, ORIGIN.lng, async () => { throw new Error('429'); });
  let threw = false;
  try { await dead.sampleChunk(0, 0, 8); } catch { threw = true; }
  check('when the service is down, sampleChunk fails instead of returning fake zeros', threw);

  let n = 0;
  const flaky = new ElevationField(ORIGIN.lat, ORIGIN.lng, async (pts) => { if (n++ === 0) throw new Error('429'); return pts.map(() => 5); });
  const first = await flaky.sampleChunk(0, 0, 8).catch(() => null);
  const retry = await flaky.sampleChunk(0, 0, 8);
  check('after a failed fetch the same chunk can be retried successfully', first === null && retry.complete === true);
}

// ------------------------------------------------------------------------------------------
section('Checkpoint mission and day/night');
{
  const roads = [
    { tags: { highway: 'residential' }, geometry: [at(0, 0), at(100, 0), at(300, 0), at(900, 0)] },
    { tags: { highway: 'footway' }, geometry: [at(0, 250), at(0, 300)] },
  ];
  const picks = Array.from({ length: 50 }, (_, i) => pickCheckpoint(roads, ORIGIN.lat, ORIGIN.lng, { x: 0, z: 0 }, 150, 450, () => i / 50));
  check('checkpoints land only on drivable roads inside the 150-450 m band', picks.every((p) => p && near(p.x, 300, 1) && near(p.z, 0, 1)));
  check('no checkpoint when no road is in range', pickCheckpoint(roads, ORIGIN.lat, ORIGIN.lng, { x: 5000, z: 5000 }) === null);

  const noon = lightingAt(12), midnight = lightingAt(0), dusk = lightingAt(18.2);
  check('noon is full daylight, midnight is dark', noon.daylight > 0.99 && midnight.daylight === 0, `noon ${noon.daylight.toFixed(2)}, midnight ${midnight.daylight.toFixed(2)}`);
  check('sky is blue at noon, dark at midnight, orange-ish at dusk', noon.sky.b > noon.sky.r && midnight.sky.getHSL({}).l < 0.15 && dusk.sky.r > dusk.sky.b);
}

// ------------------------------------------------------------------------------------------
section('Minimap arrow');
{
  check('facing north (-Z, heading PI) points the arrow up', near(((headingToBearingDeg(Math.PI) % 360) + 360) % 360, 0, 0.01));
  check('facing east (+X, heading PI/2) points the arrow right', near(headingToBearingDeg(Math.PI / 2), 90, 0.01));
  check('facing south (+Z, heading 0) points the arrow down', near(headingToBearingDeg(0), 180, 0.01));
}

// ------------------------------------------------------------------------------------------
section('OSM parsing and spawn point');
{
  const xml = `<osm>
    <node id="1" lat="13.2836" lon="100.9260"/><node id="2" lat="13.2836" lon="100.9280"/>
    <node id="3" lat="13.2837" lon="100.9260"/><node id="4" lat="13.2837" lon="100.9280"/>
    <node id="5" lat="13.2840" lon="100.9268"/><node id="6" lat="13.2840" lon="100.9270"/><node id="7" lat="13.2842" lon="100.9270"/>
    <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="Main &amp; Sons"/></way>
    <way id="11"><nd ref="3"/><nd ref="4"/><tag k="highway" v="footway"/></way>
    <way id="12"><nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="5"/><tag k="building" v="yes"/></way>
  </osm>`;
  const parsed = parseOsmXml(xml);
  check('parses roads and buildings', parsed.roads.length === 2 && parsed.buildings.length === 1, `${parsed.roads.length} roads, ${parsed.buildings.length} buildings`);
  const spawn = findSpawnPoint(parsed.roads, ORIGIN.lat, ORIGIN.lng);
  check('spawn ignores footways and picks the drivable road', spawn && spawn.name.startsWith('Main'), spawn ? `${spawn.name}` : 'none');
  check('spawn sits on the road (within 15 m of origin) and points along it (east/west)', spawn && Math.hypot(spawn.x, spawn.z) < 15 && near(Math.abs(spawn.heading), Math.PI / 2, 0.05), spawn ? `x=${spawn.x.toFixed(1)} z=${spawn.z.toFixed(1)} heading=${spawn.heading.toFixed(2)}` : '');
}

// ------------------------------------------------------------------------------------------
section('Driving (real heightfield terrain, 5x5 chunks)');

const idle = { forward: false, backward: false, left: false, right: false, handbrake: false, reset: false };
function makeWorld(gridFor = flat) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.defaultContactMaterial.friction = 0.3;
  world.defaultContactMaterial.restitution = 0.1;
  for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) {
    world.addBody(generateTerrain(gridFor(cx, cz), cx * CHUNK_SIZE, cz * CHUNK_SIZE, 0, 0, 0).body);
  }
  const stub = { group: { position: { set() {} }, quaternion: { set() {} } }, updateWheels() {} };
  const car = new CarController(world, stub);
  car.setSpawnPosition(0, 1.5, 0, 0);
  return { world, car };
}
const drive = (world, car, input, seconds) => {
  for (let i = 0; i < seconds * 60; i++) { car.update({ ...idle, ...input }, 1 / 60); world.step(1 / 60, 1 / 60, 3); }
};
const upOf = (car) => { const u = new CANNON.Vec3(); car.chassisBody.vectorToWorldFrame(CANNON.Vec3.UNIT_Y, u); return u.y; };

{
  // Bug: the chassis box was lower than the wheel mounts, so the nose dug in and W did nothing.
  let { world, car } = makeWorld();
  drive(world, car, {}, 2);
  check('car rests on its wheels at the right height', near(car.getPosition().y, 0.73, 0.1), `y=${car.getPosition().y.toFixed(2)}`);

  ({ world, car } = makeWorld());
  drive(world, car, { forward: true }, 5);
  check('W drives forward (+Z) and reaches >40 km/h in 5 s', car.getPosition().z > 25 && car.speed > 40 && near(car.getPosition().x, 0, 1), `z=${car.getPosition().z.toFixed(1)} ${car.speed.toFixed(0)} km/h`);

  ({ world, car } = makeWorld());
  drive(world, car, { backward: true }, 4);
  check('S from standstill reverses (-Z)', car.getPosition().z < -5, `z=${car.getPosition().z.toFixed(1)}`);

  // Bug: steering was inverted (A turned right).
  ({ world, car } = makeWorld());
  drive(world, car, { forward: true, left: true }, 3);
  check('A turns LEFT (towards +X when facing +Z)', car.getPosition().x > 3, `x=${car.getPosition().x.toFixed(1)}`);
  ({ world, car } = makeWorld());
  drive(world, car, { forward: true, right: true }, 3);
  check('D turns RIGHT (towards -X when facing +Z)', car.getPosition().x < -3, `x=${car.getPosition().x.toFixed(1)}`);

  ({ world, car } = makeWorld());
  drive(world, car, { forward: true }, 8);
  let t = 0;
  while (car.speed > 5 && t < 600) { drive(world, car, { backward: true }, 1 / 60); t++; }
  check('S while moving brakes to a stop in < 4 s', t / 60 < 4, `${(t / 60).toFixed(1)} s`);
  drive(world, car, { backward: true }, 3);
  check('holding S after stopping then reverses', car.forwardSpeed < -2, `${car.forwardSpeed.toFixed(1)} m/s`);

  ({ world, car } = makeWorld());
  drive(world, car, { forward: true }, 8);
  let minUp = 1;
  for (let i = 0; i < 4 * 60; i++) { drive(world, car, { forward: true, left: true }, 1 / 60); minUp = Math.min(minUp, upOf(car)); }
  check('full-lock cornering at ~90 km/h does not roll the car', minUp > 0.8, `min upright ${minUp.toFixed(2)}`);

  ({ world, car } = makeWorld());
  car.chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), Math.PI);
  car.chassisBody.position.y = 2;
  drive(world, car, {}, 6);
  check('a flipped car rights itself', upOf(car) > 0.9);

  const slope = (cx, cz) => flat().map((r, row) => r.map(() => (cz * CHUNK_SIZE + (row / 7 - 0.5) * CHUNK_SIZE) * 0.1));
  ({ world, car } = makeWorld(slope));
  car.setSpawnPosition(0, 3, 0, 0);
  drive(world, car, { forward: true }, 10);
  check('car climbs a 10% hill', car.getPosition().z > 60, `z=${car.getPosition().z.toFixed(0)}`);

  ({ world, car } = makeWorld());
  drive(world, car, { forward: true }, 3);
  car.chassisBody.position.y = -500; // fell through the world
  for (let i = 0; i < 3; i++) world.step(1 / 60, 1 / 60, 3); // let the wheel contacts refresh, as in a real fall
  drive(world, car, {}, 2);
  check('a car that falls out of the world is put back', car.getPosition().y > -10, `y=${car.getPosition().y.toFixed(1)}`);
}

// ------------------------------------------------------------------------------------------
if (process.argv.includes('--online')) {
  section('Online: real OpenStreetMap + elevation at the start point');
  // CacheManager needs IndexedDB; a stub that always fails makes it run uncached.
  globalThis.indexedDB = { open() { const req = {}; setTimeout(() => req.onerror?.({ target: { error: 'node' } })); return req; } };
  const { ChunkManager } = await import('../src/world/ChunkManager.js');
  const { preloadRegion } = await import('../src/data/OSMFetcher.js');

  const places = { Bangsaen: [13.2836, 100.9268], Tokyo: [35.6586, 139.7454] };
  for (const [name, [lat, lng]] of Object.entries(places)) {
    const t0 = Date.now();
    const loaded = await preloadRegion(lat, lng, 600);
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    const scene = new THREE.Scene();
    const cm = new ChunkManager(scene, world, lat, lng);
    await cm.loadInitialChunks(() => {});
    const roads = cm.getLoadedRoads();
    const buildings = [...cm.chunks.values()].reduce((n, c) => n + c.osmData.buildings.length, 0);
    check(`${name}: area downloaded and 3x3 chunks built in ${((Date.now() - t0) / 1000).toFixed(1)} s`, loaded && cm.chunks.size === 9, `${cm.chunks.size}/9 chunks, ${roads.length} roads, ${buildings} buildings`);
    check(`${name}: real data, not the synthetic fallback`, [...cm.chunks.values()].every((c) => !c.osmData.synthetic));

    const spawn = findSpawnPoint(roads, lat, lng);
    check(`${name}: found a drivable road near the start`, !!spawn && Math.hypot(spawn.x, spawn.z) < 120, spawn ? `${spawn.name}, ${Math.hypot(spawn.x, spawn.z).toFixed(0)} m away` : 'none');

    if (spawn) {
      const stub = { group: { position: { set() {} }, quaternion: { set() {} } }, updateWheels() {} };
      const car = new CarController(world, stub);
      const ground = cm.getTerrainHeight(spawn.x, spawn.z) ?? 0;
      car.setSpawnPosition(spawn.x, ground + 1.5, spawn.z, spawn.heading);
      drive(world, car, { forward: true }, 6);
      const moved = Math.hypot(car.getPosition().x - spawn.x, car.getPosition().z - spawn.z);
      check(`${name}: car drives away from the spawn on real terrain`, moved > 20 && upOf(car) > 0.8, `${moved.toFixed(0)} m, upright ${upOf(car).toFixed(2)}`);
    }
    cm.dispose();
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
