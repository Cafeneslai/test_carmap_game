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
import { placeVegetation, pickSpecies } from '../src/world/VegetationPlacer.js';
import { getElevationAt } from '../src/world/ElevationUtils.js';
import { metersToLatLng } from '../src/data/GeoUtils.js';
import { parseOsmXml, findSpawnPoint, landcoverType } from '../src/data/OSMFetcher.js';
import { dropOverlapping } from '../src/data/OvertureBuildings.js';
import { GROUND_COLORS } from '../src/world/GroundPainter.js';
import { ElevationField } from '../src/data/ElevationField.js';
import { headingToBearingDeg } from '../src/ui/compass.js';
import { CHUNK_SIZE } from '../src/config.js';
import { pickCheckpoint, paceSecondsPerKm } from '../src/core/Mission.js';
import { dashPolyline, findJunctions, cutPolyline, sidewalkSides, bridgeLiftAt } from '../src/world/RoadGenerator.js';
import { lampPositions, generateStreetLamps } from '../src/world/StreetLamps.js';
import { buildingHeight, pitchedRoof, wallBands, tagColor, minHeight } from '../src/world/BuildingGenerator.js';
import { facadeStyle } from '../src/world/Facades.js';
import { signalState, signalHeads, CYCLE_SECONDS } from '../src/world/TrafficLights.js';
import { TrafficManager, lanesPerDirection } from '../src/world/Traffic.js';
import { towerSpec, towerGeometry, generateTowers, dropTowerParts } from '../src/world/Towers.js';
import { isThaiTemple } from '../src/world/ThaiTemple.js';
import { buildVehicle, pickKind } from '../src/world/Vehicles.js';
import { signPlacements } from '../src/world/Signs.js';
import { poleRows, generatePowerLines, hasOverheadWires } from '../src/world/PowerLines.js';
import { markWaterBridges } from '../src/data/OSMFetcher.js';
import { isLeftHandTraffic } from '../src/data/DrivingSide.js';
import { lightingAt, sunDirection, solarHourNow } from '../src/world/DayNight.js';
import { weatherFromApi, weatherIcon } from '../src/world/Weather.js';
const RAD_DEG = Math.PI / 180;

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

  // L-shaped building (30 x 30 m with the 20 x 20 m north-east corner missing): the empty corner must stay open
  const lShape = { id: 6, tags: { building: 'yes' }, geometry: [at(200, 200), at(230, 200), at(230, 210), at(210, 210), at(210, 230), at(200, 230), at(200, 200)] };
  const lWorld = new CANNON.World();
  lWorld.addBody(generateBuildings([lShape], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0).userData.body);
  const lHits = (x, z) => { const r = new CANNON.RaycastResult(); lWorld.raycastClosest(new CANNON.Vec3(x, 50, z), new CANNON.Vec3(x, -5, z), {}, r); return r.hasHit; };
  check('L-shaped building: both wings are solid, the empty inside corner is open', lHits(205, 225) && lHits(225, 205) && lHits(205, 205) && !lHits(222, 222), `corner ${lHits(222, 222) ? 'blocked' : 'open'}`);

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

  // Bug: every chunk drew whole roads, with heights clamped to its own grid outside it (doubled roads on hills)
  const longRoad = { tags: { highway: 'primary' }, geometry: [at(-700, 30), at(700, 30)] };
  const rbox = new THREE.Box3().setFromObject(generateRoads([longRoad], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0));
  check('a 1.4 km road is clipped to its 200 m chunk (+1.5 m seam)', near(rbox.min.x, -101.5, 0.6) && near(rbox.max.x, 101.5, 0.6), `x ${rbox.min.x.toFixed(1)}..${rbox.max.x.toFixed(1)}`);
  const lakeNext = { tags: { natural: 'water' }, geometry: square(150, -20, 400, 20) }; // centre in the next chunk east
  check('a lake is drawn only by the chunk holding its centre', generateWater([lakeNext], 0, 0, ORIGIN.lat, ORIGIN.lng) === null && generateWater([lakeNext], CHUNK_SIZE, 0, ORIGIN.lat, ORIGIN.lng) !== null);
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

  // Real sun: Bangsaen (13.3° N) on 23 November stands ~56° up in the south at noon, rises in the east
  const nov23 = sunDirection(12, 13.28, 327), morning = sunDirection(8, 13.28, 327);
  const noonUp = Math.asin(nov23.y) / RAD_DEG;
  check('noon sun at Bangsaen in November is ~56° up, due south', near(noonUp, 56.5, 1.5) && nov23.z > 0.5 && Math.abs(nov23.x) < 0.01, `${noonUp.toFixed(1)}°`);
  check('morning sun is in the east, low', morning.x > 0.6 && morning.y > 0 && morning.y < 0.6);
  check('London in December gets a low winter sun (~15°)', near(Math.asin(sunDirection(12, 51.5, 355).y) / RAD_DEG, 15, 1.5));
  check('local solar time follows longitude (Bangkok is ~UTC+6:43 solar)', near(solarHourNow(100.5, new Date(Date.UTC(2026, 0, 1, 5, 0))), 11.7, 0.05));

  // Live weather: Open-Meteo values become cloud, rain and wind for the renderer
  const overcast = weatherFromApi({ cloud_cover: 100, precipitation: 0, weather_code: 3, wind_speed_10m: 7, temperature_2m: 30.7 });
  const storm = weatherFromApi({ cloud_cover: 95, precipitation: 6, weather_code: 95, wind_speed_10m: 60 });
  check('weather: overcast is dry and grey, a storm rains hard with strong wind',
    overcast.cloud === 1 && overcast.rain === 0 && weatherIcon(overcast) === '☁️' && storm.rain === 1 && storm.wind === 1 && weatherIcon(storm) === '⛈️');
  check('weather: missing data means clear and calm, not a crash', weatherFromApi(undefined).cloud === 0 && weatherFromApi(undefined).rain === 0);

  const noon = lightingAt(12), midnight = lightingAt(0), dusk = lightingAt(18.2);
  check('noon is full daylight, midnight is dark', noon.daylight > 0.99 && midnight.daylight === 0, `noon ${noon.daylight.toFixed(2)}, midnight ${midnight.daylight.toFixed(2)}`);
  check('sky is blue at noon, dark at midnight, orange-ish at dusk', noon.sky.b > noon.sky.r && midnight.sky.getHSL({}).l < 0.15 && dusk.sky.r > dusk.sky.b);
}

// ------------------------------------------------------------------------------------------
section('Realistic city: markings, lamps, building heights');
{
  const line = [new THREE.Vector2(0, 0), new THREE.Vector2(45, 0), new THREE.Vector2(90, 0)];
  const dashes = dashPolyline(line, 3, 6);
  const lens = dashes.map((d) => d[0].distanceTo(d[d.length - 1]));
  check('a 90 m road gets 10 dashes of 3 m (dash 3 m, gap 6 m)', dashes.length === 10 && lens.every((l) => near(l, 3, 0.01)), `${dashes.length} dashes`);
  check('a dash crossing a road bend stays one piece', dashPolyline([new THREE.Vector2(0, 0), new THREE.Vector2(1.5, 0), new THREE.Vector2(1.5, 5)], 3, 6)[0].length === 3);

  // A 600 m east-west road through three chunks: every lamp is placed once, about 35 m apart
  const road = { tags: { highway: 'primary' }, geometry: [at(-300, 10), at(300, 10)] };
  const perChunk = [-1, 0, 1].map((cx) => lampPositions([road], cx * CHUNK_SIZE, 0, ORIGIN.lat, ORIGIN.lng));
  const all = perChunk.flat().sort((a, b) => a.x - b.x);
  check('street lamps are not duplicated across chunks and are ~35 m apart', all.length === 17 && all.slice(1).every((p, i) => near(p.x - all[i].x, 35, 0.5)), `${all.length} lamps`);
  check('lamps stand beside the road, not on it (primary is 10 m wide)', all.every((p) => near(Math.abs(p.z - 10), 6, 0.3)));
  const grid = [];
  for (let k = -100; k <= 100; k += 8) grid.push({ tags: { highway: 'residential' }, geometry: [at(-100, k), at(100, k)] });
  const dense = lampPositions(grid, 0, 0, ORIGIN.lat, ORIGIN.lng);
  const lastStreet = dense.filter((p) => p.road === grid.at(-1)).length;
  check('a dense chunk still lights its last-listed street', lastStreet > 0 && dense.length <= 400, `${dense.length} lamps, ${lastStreet} on the last street`);
  // Bug: Bangsaen's campus is 235 service roads, all dark at night
  check('campus service roads are lit, driveways are not (unless lit=yes), lit=no darkens a primary road',
    lampPositions([{ tags: { highway: 'service' }, geometry: road.geometry }], 0, 0, ORIGIN.lat, ORIGIN.lng).length > 0 &&
    lampPositions([{ tags: { highway: 'service', service: 'driveway' }, geometry: road.geometry }], 0, 0, ORIGIN.lat, ORIGIN.lng).length === 0 &&
    lampPositions([{ tags: { highway: 'service', service: 'driveway', lit: 'yes' }, geometry: road.geometry }], 0, 0, ORIGIN.lat, ORIGIN.lng).length > 0 &&
    lampPositions([{ tags: { highway: 'primary', lit: 'no' }, geometry: road.geometry }], 0, 0, ORIGIN.lat, ORIGIN.lng).length === 0);
  check('footways get no street lamps', lampPositions([{ tags: { highway: 'footway' }, geometry: road.geometry }], 0, 0, ORIGIN.lat, ORIGIN.lng).length === 0);

  check('OSM height and levels win over the guess', buildingHeight({ tags: { height: '42' } }) === 42 && buildingHeight({ tags: { 'building:levels': '10' } }) === 30);
  const guessed = new Set(Array.from({ length: 40 }, (_, id) => buildingHeight({ id, tags: { building: 'yes' } })));
  check('untagged buildings get varied heights (2-5 floors), not one flat slab', guessed.size === 4 && Math.min(...guessed) === 6 && Math.max(...guessed) === 15, [...guessed].join(','));
  const ovHeights = new Set(['ov_1972641f-316b', 'ov_08b2c4d1-aa01', 'ov_5f00e1b2-77c3', 'ov_c3d4e5f6-0912', 'ov_7a7a7a7a-1234', 'ov_0000ffff-9999'].map((id) => buildingHeight({ id, tags: { building: 'yes' } })));
  check('Overture buildings (text ids) also get varied heights, not all 2 floors', ovHeights.size >= 3, [...ovHeights].join(','));
  // Facades by building type. Walls must face outwards whichever way the OSM ring runs.
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]].map(([x, z]) => new THREE.Vector2(x, z));
  for (const ringPts of [sq, [...sq].reverse()]) {
    const { ground, upper } = wallBands(ringPts, 0, 12, 3, new THREE.Color(1, 1, 1));
    let outward = 0, faces = 0;
    for (const g of [ground, upper]) {
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(p, i), b = new THREE.Vector3().fromBufferAttribute(p, i + 1), c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
        const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
        const centre = a.clone().add(b).add(c).divideScalar(3).sub(new THREE.Vector3(5, (a.y + b.y + c.y) / 3, 5));
        faces++;
        if (n.dot(centre) > 0) outward++;
      }
    }
    check(`walls face outwards (${ringPts === sq ? 'one' : 'other'} ring direction) with a ground-floor band`, outward === faces && ground && upper, `${outward}/${faces}`);
  }
  const style = (tags, floors, area = 300, ratio = 1.5, tropical = true) => facadeStyle(tags, { floors, area, ratio, tropical });
  check('facade styles: shophouse, condo, office tower, warehouse, school, house',
    style({ building: 'retail' }, 4) === 'shophouse' && style({ building: 'apartments' }, 20) === 'apartment' &&
    style({ building: 'yes' }, 30) === 'office' && style({ building: 'warehouse' }, 2) === 'industrial' &&
    style({ building: 'school' }, 3) === 'civic' && style({ building: 'yes' }, 2, 120) === 'house');
  check('an untagged narrow 3-floor row in Thailand is a shophouse; in London it is not',
    style({ building: 'yes' }, 3, 400, 4) === 'shophouse' && style({ building: 'yes' }, 3, 400, 4, false) !== 'shophouse');
  check('untagged footprints take the style of the area they stand in (campus -> school block, estate -> warehouse)',
    facadeStyle({ building: 'yes' }, { floors: 3, area: 600, ratio: 3, tropical: true, landuse: 'amenity=university' }) === 'civic' &&
    facadeStyle({ building: 'yes' }, { floors: 1, area: 2000, ratio: 2, tropical: true, landuse: 'landuse=industrial' }) === 'industrial');
  check('building:colour / roof:colour tags are read (names and hex), junk is ignored',
    tagColor('red')?.getHex() === 0xff0000 && tagColor('#00ff00')?.getHex() === 0x00ff00 && tagColor('ff8800') !== null && tagColor('not a colour') === null && tagColor('blorange') === null);
  check('checkpoint pace is seconds per km', paceSecondsPerKm(30, 300) === 100);

  // Bug: car drove straight through lamp posts
  const lamps = generateStreetLamps([road], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0);
  const lampWorld = new CANNON.World();
  lampWorld.addBody(lamps.userData.body);
  const first = lampPositions([road], 0, 0, ORIGIN.lat, ORIGIN.lng)[0];
  const hit = new CANNON.RaycastResult();
  lampWorld.raycastClosest(new CANNON.Vec3(first.x - 3, 1, first.z), new CANNON.Vec3(first.x + 3, 1, first.z), {}, hit);
  check('a lamp post blocks the car at bumper height', hit.hasHit && near(hit.hitPointWorld.x, first.x - 0.15, 0.05));

  // A plus-shaped crossing: the shared node has 4 arms, the far ends 1, a way that just continues has 2
  const ew = { tags: { highway: 'residential' }, geometry: [at(-50, 0), at(0, 0), at(50, 0)] };
  const ns = { tags: { highway: 'residential' }, geometry: [at(0, -50), at(0, 0), at(0, 50)] };
  const cont = { tags: { highway: 'residential' }, geometry: [at(50, 0), at(100, 0)] };
  const j = findJunctions([ew, ns, cont]);
  const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  check('junction finder: crossing has 4 arms, continuing way 2, dead end 1', j.get(key(at(0, 0))) === 4 && j.get(key(at(50, 0))) === 2 && j.get(key(at(-50, 0))) === 1);
  const pts = [new THREE.Vector2(-50, 0), new THREE.Vector2(0, 0), new THREE.Vector2(50, 0)];
  const pieces = cutPolyline(pts, [0, 50, 100], [50], 9);
  // Bug: every residential lane, even through fields, was lined with pavement on both sides
  const sw = (tags) => { const s = sidewalkSides(tags); return `${s.left ? 'L' : '-'}${s.right ? 'R' : '-'}`; };
  check('sidewalks follow OSM tags, else only on town streets',
    sw({ highway: 'residential' }) === '--' && sw({ highway: 'secondary' }) === 'LR' && sw({ highway: 'residential', sidewalk: 'right' }) === '-R' &&
    sw({ highway: 'primary', sidewalk: 'separate' }) === '--' && sw({ highway: 'service', 'sidewalk:left': 'yes' }) === 'L-');
  check('lines and sidewalks stop 9 m before and after a junction', pieces.length === 2 && near(pieces[0].at(-1).x, -9, 0.01) && near(pieces[1][0].x, 9, 0.01));

  // Gable roof on a 10 x 6 m house: ridge along the long side, every face points outwards/up
  const house = { id: 3, tags: { building: 'house' }, geometry: square(0, 0, 10, 6) };
  const v2 = [[0, 0], [10, 0], [10, 6], [0, 6], [0, 0]].map(([x, z]) => new THREE.Vector2(x, z));
  const roof = pitchedRoof(house, v2, 6);
  const rp = roof.attributes.position;
  let outward = 0, top = -Infinity;
  for (let t = 0; t < rp.count / 3; t++) {
    const a = new THREE.Vector3().fromBufferAttribute(rp, t * 3), b = new THREE.Vector3().fromBufferAttribute(rp, t * 3 + 1), c = new THREE.Vector3().fromBufferAttribute(rp, t * 3 + 2);
    const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    const out = a.clone().add(b).add(c).divideScalar(3).sub(new THREE.Vector3(5, 6, 3));
    if (n.dot(out) > 0) outward++;
    top = Math.max(top, a.y, b.y, c.y);
  }
  check('house gets a gable roof with every face pointing outwards', outward === rp.count / 3 && near(top, 6 + 2.4, 0.01), `${outward}/${rp.count / 3} faces, ridge at ${top.toFixed(1)} m`);
  check('offices and flat roofs get no pitched roof', pitchedRoof({ id: 4, tags: { building: 'office' } }, v2, 6) === null && pitchedRoof({ id: 5, tags: { building: 'house', 'roof:shape': 'flat' } }, v2, 6) === null);
}

// ------------------------------------------------------------------------------------------
section('Traffic lights and NPC cars');
{
  let together = 0;
  for (let t = 0; t < CYCLE_SECONDS; t += 0.25) if (signalState(0, t) !== 'red' && signalState(1, t) !== 'red') together++;
  check('crossing streets are never green/yellow at the same time', together === 0);
  check('each phase gets green, yellow and red', ['green', 'yellow', 'red'].every((s) => [...Array(96).keys()].some((i) => signalState(0, i / 4) === s)));

  check('driving side: Tokyo, Bangkok, London left; Paris, New York right',
    isLeftHandTraffic(35.66, 139.75) && isLeftHandTraffic(13.75, 100.5) && isLeftHandTraffic(51.5, -0.12) &&
    !isLeftHandTraffic(48.86, 2.35) && !isLeftHandTraffic(40.71, -74.0));

  // East-west two-way road with a signal in the middle
  const sigNode = at(0, 0);
  const road = { id: 'r1', tags: { highway: 'primary', lanes: '2' }, geometry: [at(-200, 0), sigNode, at(200, 0)] };
  const right = signalHeads([sigNode], [road], ORIGIN.lat, ORIGIN.lng, false);
  const left = signalHeads([sigNode], [road], ORIGIN.lat, ORIGIN.lng, true);
  // Travelling east (+X), the driver's right is +Z (facing +Z, +X is left)
  const eastbound = right.find((h) => h.x < 0);
  check('a two-way road gets a signal head on both approaches', right.length === 2);
  check('heads stand on the driving side: right-hand traffic +Z for eastbound, left-hand -Z', eastbound.z > 0 && left.find((h) => h.x < 0).z < 0);

  const scene = new THREE.Scene();
  const world = new CANNON.World();
  const chunkManager = {
    worldBuilder: { originLat: ORIGIN.lat, originLng: ORIGIN.lng, leftHand: false },
    chunks: new Map([['0,0', { osmData: { signals: [sigNode] } }]]),
    getLoadedRoads: () => [road],
    getTerrainHeight: () => 0,
  };
  const traffic = new TrafficManager(scene, world, chunkManager);
  const player = { x: 0, y: 0, z: 150 };
  traffic.update(0.6, player, 0); // builds the graph and spawns one car
  const car = traffic.cars[0];
  car.s = 60; car.dirSign = 1; car.kind = 'car'; car.speed = car.max; // 140 m west of the light, heading east
  const run = (seconds, time) => { for (let t = 0; t < seconds; t += 1 / 30) traffic.update(1 / 30, player, time); };
  traffic.spawnTimer = 1e9;
  run(15, 15); // east-west phase is red at t = 15
  const stoppedAt = car.mesh.position.x;
  check('NPC car stops before a red light', stoppedAt < -6 && stoppedAt > -20 && car.speed < 0.1, `x=${stoppedAt.toFixed(1)}, ${(car.speed * 3.6).toFixed(0)} km/h`);
  run(6, 1); // green
  check('NPC car drives on when the light turns green', car.mesh.position.x > 5, `x=${car.mesh.position.x.toFixed(1)}`);
  check('NPC car keeps to the right-hand lane (+Z when eastbound)', near(car.mesh.position.z, 2.5, 0.3), `z=${car.mesh.position.z.toFixed(2)}`);

  const blocker = { x: car.mesh.position.x + 25, y: 0, z: car.mesh.position.z };
  for (let t = 0; t < 8; t += 1 / 30) traffic.update(1 / 30, blocker, 1);
  check('NPC car brakes for the player in front', car.speed < 0.1 && blocker.x - car.mesh.position.x > 7, `gap ${(blocker.x - car.mesh.position.x).toFixed(1)} m`);
  traffic.dispose();
  check('traffic cleans up its cars and bodies', traffic.cars.length === 0 && world.bodies.length === 0 && scene.children.length === 0);

  check('lanes per direction: OSM lanes tag, else from road width',
    lanesPerDirection({ tags: { highway: 'primary', lanes: '4' } }) === 2 && lanesPerDirection({ tags: { highway: 'secondary', oneway: 'yes', lanes: '3' } }) === 3 &&
    lanesPerDirection({ tags: { highway: 'residential' } }) === 1 && lanesPerDirection({ tags: { highway: 'trunk' } }) === 2);

  // Lane change: a fast car stuck behind a slow one on a 4-lane road moves over and passes
  const wide = { id: 'r2', tags: { highway: 'primary', lanes: '4' }, geometry: [at(-400, 0), at(400, 0)] };
  const cm2 = { ...chunkManager, chunks: new Map(), getLoadedRoads: () => [wide] };
  const t2 = new TrafficManager(new THREE.Scene(), new CANNON.World(), cm2);
  const p2 = { x: 0, y: 0, z: 150 };
  t2.update(0.6, p2, 0); t2.update(0.6, p2, 0);
  const [fast, slow] = t2.cars;
  Object.assign(slow, { kind: 'car', s: 380, dirSign: 1, lane: 0, speed: 3, max: 3, pos: null, yaw: null });
  Object.assign(fast, { kind: 'car', s: 340, dirSign: 1, lane: 0, speed: 13, max: 13, laneTimer: 0, pos: null, yaw: null });
  t2.spawnTimer = 1e9;
  let minGap = Infinity;
  for (let t = 0; t < 10; t += 1 / 30) { t2.update(1 / 30, p2, 0); minGap = Math.min(minGap, Math.hypot(fast.mesh.position.x - slow.mesh.position.x, fast.mesh.position.z - slow.mesh.position.z)); }
  check('a fast NPC changes lane and overtakes a slow one', fast.lane === 1 && fast.s > slow.s && minGap > 2, `lane ${fast.lane}, ahead by ${(fast.s - slow.s).toFixed(0)} m, closest ${minGap.toFixed(1)} m`);
  t2.dispose();

  // Turn: an L junction is driven as an arc at turning speed, without teleporting
  const legA = { id: 'a', tags: { highway: 'residential' }, geometry: [at(-200, 0), at(0, 0)] };
  const legB = { id: 'b', tags: { highway: 'residential', oneway: 'yes' }, geometry: [at(0, 0), at(0, 200)] };
  const cm3 = { ...chunkManager, chunks: new Map(), getLoadedRoads: () => [legA, legB] };
  const t3 = new TrafficManager(new THREE.Scene(), new CANNON.World(), cm3);
  const p3 = { x: -100, y: 0, z: 100 };
  t3.update(0.6, p3, 0);
  const turner = t3.cars[0];
  Object.assign(turner, { kind: 'car', way: t3.ways.find((w) => w.road === legA), s: 120, dirSign: 1, lane: 0, speed: 8, max: 8, next: null, pos: null, yaw: null });
  t3.spawnTimer = 1e9;
  let maxStep = 0, cornerSpeed = Infinity, prev = null;
  for (let t = 0; t < 20; t += 1 / 30) {
    t3.update(1 / 30, p3, 0);
    const q = turner.mesh.position.clone();
    if (prev) maxStep = Math.max(maxStep, q.distanceTo(prev));
    if (Math.abs(q.x) < 4 && Math.abs(q.z) < 4) cornerSpeed = Math.min(cornerSpeed, turner.speed);
    prev = q;
  }
  check('NPC slows down for a 90° turn and drives it without jumping', cornerSpeed < 7 && maxStep < 0.5 && turner.way.road === legB && near(turner.mesh.position.x, 0, 0.3),
    `corner ${(cornerSpeed * 3.6).toFixed(0)} km/h, max step ${maxStep.toFixed(2)} m, x=${turner.mesh.position.x.toFixed(2)}`);
  t3.dispose();
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

  // Ground painting: land cover areas are parsed and every kind we parse has a colour
  const lc = parseOsmXml(`<osm><node id="1" lat="0" lon="0"/><node id="2" lat="0" lon="0.001"/><node id="3" lat="0.001" lon="0"/>
    <way id="20"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="1"/><tag k="landuse" v="farmland"/></way>
    <way id="21"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="1"/><tag k="natural" v="beach"/></way>
    <way id="22"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="1"/><tag k="landuse" v="forest"/></way></osm>`);
  check('land cover (fields, beach, forest) is parsed for the ground; forests still get trees', lc.landcover.length === 3 && lc.greenery.length === 1);
  const kinds = ['landuse=residential', 'landuse=farmland', 'natural=beach', 'amenity=parking', 'leisure=pitch', 'natural=wood'];
  check('every land cover kind has a ground colour', kinds.every((k) => GROUND_COLORS[k]) && landcoverType({ landuse: 'farmland' }) === 'landuse=farmland' && landcoverType({ building: 'yes' }) === null);
  check('parses roads and buildings', parsed.roads.length === 2 && parsed.buildings.length === 1, `${parsed.roads.length} roads, ${parsed.buildings.length} buildings`);
  const spawn = findSpawnPoint(parsed.roads, ORIGIN.lat, ORIGIN.lng);
  check('spawn ignores footways and picks the drivable road', spawn && spawn.name.startsWith('Main'), spawn ? `${spawn.name}` : 'none');
  check('spawn sits on the road (within 15 m of origin) and points along it (east/west)', spawn && Math.hypot(spawn.x, spawn.z) < 15 && near(Math.abs(spawn.heading), Math.PI / 2, 0.05), spawn ? `x=${spawn.x.toFixed(1)} z=${spawn.z.toFixed(1)} heading=${spawn.heading.toFixed(2)}` : '');

  // Bug: big forests and lakes are multipolygon relations of untagged ways, so they were missing.
  // Outline: two untagged ways (one reversed) around a 400 m square; a clearing as an inner ring.
  const ring = [[-200, -200], [200, -200], [200, 200], [-200, 200]].map(([x, z]) => at(x, z));
  const hole = [[-20, -20], [20, -20], [20, 20], [-20, 20]].map(([x, z]) => at(x, z));
  let nid = 100;
  const nodeXml = [...ring, ...hole].map((p) => `<node id="${nid++}" lat="${p.lat}" lon="${p.lon}"/>`).join('');
  const nd = (ids) => ids.map((i) => `<nd ref="${i}"/>`).join('');
  const relXml = (extra = '') => `<osm>${nodeXml}
    <way id="30">${nd([100, 101, 102])}</way><way id="31">${nd([100, 103, 102])}</way>
    <way id="32">${nd([104, 105, 106, 107, 104])}</way>
    <relation id="40"><member type="way" ref="30" role="outer"/><member type="way" ref="31" role="outer"/>
      <member type="way" ref="32" role="inner"/>${extra}<tag k="type" v="multipolygon"/><tag k="landuse" v="forest"/></relation></osm>`;
  const rel = parseOsmXml(relXml());
  const forest = rel.greenery[0];
  check('a multipolygon relation becomes one area with its hole (ways joined end to end)',
    rel.greenery.length === 1 && rel.landcover.length === 1 && forest.geometry.length === 5 && forest.holes.length === 1 && rel.partial.length === 0,
    `${rel.greenery.length} area(s), ${forest?.geometry.length} points, ${forest?.holes.length} hole(s)`);
  check('a relation with ways outside the download is flagged for a full fetch',
    parseOsmXml(relXml('<member type="way" ref="999" role="outer"/>')).partial[0]?.id === '40');
  // Buildings with courtyards (OSM multipolygon): walls inside the courtyard face into it, the car can drive in
  const court = parseOsmXml(relXml().replace('<tag k="landuse" v="forest"/>', '<tag k="building" v="yes"/>')).buildings[0];
  const courtGroup = generateBuildings([court], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0);
  const cw = new CANNON.World();
  cw.addBody(courtGroup.userData.body);
  const blockedAt = (x, z) => { const res = new CANNON.RaycastResult(); cw.raycastClosest(new CANNON.Vec3(x, 50, z), new CANNON.Vec3(x, -5, z), {}, res); return res.hasHit; };
  check('a building with a courtyard: solid around it, the courtyard stays open', !!court?.holes?.length && blockedAt(100, 100) && !blockedAt(0, 0));

  const trees = [0, 1].map((cx) => placeVegetation([forest], flat(), cx * CHUNK_SIZE, 0, ORIGIN.lat, ORIGIN.lng, 0));
  const treePoints = (g) => (g?.children || []).flatMap((inst) => Array.from({ length: inst.count }, (_, i) => ({
    p: new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(inst.instanceMatrix.array, i * 16)), kind: inst.userData.species })));
  const pts = trees.flatMap(treePoints).map((t) => t.p);
  const counts = trees.map((g) => treePoints(g).length);
  check('trees fill a big forest in every chunk, but none in its clearing',
    counts.every((n) => n >= 100) && !pts.some((p) => Math.abs(p.x) < 19 && Math.abs(p.z) < 19), counts.join(' + ') + ' trees');

  // Realism: a road through the forest stays clear, the tropics get palms and rain trees, OSM street trees are planted
  const lane = { tags: { highway: 'primary' }, geometry: [at(-300, 50), at(300, 50)] };
  const nearRoad = treePoints(placeVegetation([forest], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0, { roads: [lane] })).filter((t) => Math.abs(t.p.z - 50) < 8);
  check('no tree grows on a road through a forest', nearRoad.length === 0, `${nearRoad.length} trees within 8 m of the road`);
  const park = { id: 'p', tags: { leisure: 'park' }, geometry: [...ring, ring[0]] };
  const thai = new Set(treePoints(placeVegetation([park], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0)).map((t) => t.kind));
  const london = new Set(Array.from({ length: 100 }, (_, i) => pickSpecies({ leisure: 'park' }, false, i / 100)));
  check('a Thai park gets palms and rain trees; a London park gets no palms', thai.has("palm") && thai.has("rainTree") && !london.has('palm') && !london.has('rainTree'), `${[...thai]} / ${[...london]}`);
  const street = parseOsmXml(`<osm><node id="1" lat="13.2836" lon="100.9268"><tag k="natural" v="tree"/><tag k="genus" v="Cocos"/></node>
    <node id="2" lat="13.2836" lon="100.9270"/><node id="3" lat="13.2836" lon="100.9280"/><way id="5"><nd ref="2"/><nd ref="3"/><tag k="natural" v="tree_row"/></way></osm>`);
  const planted = treePoints(placeVegetation([], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0, { trees: street.trees }));
  check('OSM street trees are planted (a coconut is a palm, a 108 m tree row gets ~12 trees)',
    planted.find((t) => Math.hypot(t.p.x, t.p.z) < 1)?.kind === 'palm' && near(street.trees.length - 1, 12, 1), `${street.trees.length} trees parsed`);

  const bigLake = { tags: { natural: 'water' }, geometry: [...ring, ring[0]], holes: [hole] };
  const pieces = [0, 1].map((cx) => generateWater([bigLake], cx * CHUNK_SIZE, 0, ORIGIN.lat, ORIGIN.lng));
  const lbox = pieces[1] && new THREE.Box3().setFromObject(pieces[1]);
  check('a lake bigger than a chunk is drawn by every chunk, cut to that chunk',
    pieces.every(Boolean) && near(lbox.min.x, 100, 0.5) && near(lbox.max.x, 200, 0.5), lbox ? `x ${lbox.min.x.toFixed(1)}..${lbox.max.x.toFixed(1)}` : 'missing');
  const wp = pieces[0].geometry.attributes.position;
  let onIsland = 0;
  for (let i = 0; i < wp.count; i += 3) {
    const mx = (wp.getX(i) + wp.getX(i + 1) + wp.getX(i + 2)) / 3, mz = (wp.getZ(i) + wp.getZ(i + 1) + wp.getZ(i + 2)) / 3;
    if (Math.abs(mx) < 19 && Math.abs(mz) < 19) onIsland++;
  }
  check('an island (inner ring) stays dry', onIsland === 0, `${onIsland} water triangles on the island`);

  // Bug: OSM has no buildings in many places (Burapha University) the street map shows full of them.
  // Overture footprints fill in, but never on top of an OSM building.
  const osmHouse = { geometry: square(0, 0, 20, 20) };
  const extra = [
    { id: 'same', geometry: square(2, 2, 18, 18) },     // the same house traced by AI
    { id: 'bigger', geometry: square(-5, -5, 25, 25) }, // a looser outline around it
    { id: 'new', geometry: square(60, 0, 80, 20) },     // a house OSM does not have
  ];
  const kept = dropOverlapping(extra, [osmHouse]).map((e) => e.id);
  check('Overture buildings fill gaps but never sit on an OSM building', kept.join() === 'new', kept.join());
  const riverbank = { tags: { waterway: 'riverbank' }, geometry: square(40, -60, 60, -40) };
  const rb = new THREE.Box3().setFromObject(generateWater([riverbank], 0, 0, ORIGIN.lat, ORIGIN.lng));
  check('a riverbank outline is filled as an area, not drawn as a river line', near(rb.min.x, 40, 0.5) && near(rb.max.x, 60, 0.5));
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
    if (name === 'Bangsaen') {
      // OSM has no buildings around Burapha University; the Overture footprints must fill them in
      const middle = [...cm.chunks.values()].find((c) => c.chunkX === 0 && c.chunkZ === 0);
      const extra = middle.osmData.buildings.filter((b) => String(b.id).startsWith('ov_')).length;
      check('Bangsaen: buildings OSM is missing come from Overture', extra >= 10, `${extra} of ${middle.osmData.buildings.length} in the start chunk`);
    }
    if (name === 'Tokyo') {
      const signals = [...cm.chunks.values()].reduce((n, c) => n + (c.osmData.signals?.length || 0), 0);
      check('Tokyo: traffic signal nodes are parsed from OSM', signals > 0, `${signals} signals`);
    }

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

  // Central Park's lakes are multipolygon relations reaching outside a 600 m download
  const { fetchChunkData } = await import('../src/data/OSMFetcher.js');
  await preloadRegion(40.7812, -73.9665, 600);
  const park = await fetchChunkData({ south: 40.7772, north: 40.7852, west: -73.9705, east: -73.9625 });
  const lakes = park.water.filter((w) => w.relation);
  check('Central Park: lakes from multipolygon relations, fetched whole, with islands', lakes.some((w) => w.geometry.length > 100 && w.holes.length > 0),
    lakes.map((w) => `${w.tags.name}: ${w.geometry.length} pts, ${w.holes.length} island(s)`).join('; ') || 'none');
}

// ------------------------------------------------------------------------------------------
section('Roads on hills, bridges, towers');
{
  // Bug: roads sank into hills: heights were bilinear (not the mesh's triangles) and only taken at OSM nodes
  const hill = Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => 30 * Math.sin(r * 1.3) * Math.cos(c * 0.9)));
  const terrain = generateTerrain(hill, 0, 0, 0, 0, 0).mesh;
  terrain.updateMatrixWorld();
  const ray = new THREE.Raycaster();
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const x = (Math.random() - 0.5) * 190, z = (Math.random() - 0.5) * 190;
    ray.set(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(terrain)[0];
    if (hit) worst = Math.max(worst, Math.abs(hit.point.y - getElevationAt(x, z, hill, 0)));
  }
  check('getElevationAt matches the drawn terrain mesh', worst < 0.01, `worst ${worst.toFixed(3)} m`);
  const hillRoad = { tags: { highway: 'residential' }, geometry: [at(-90, -80), at(90, 85)] };
  const rp = generateRoads([hillRoad], hill, 0, 0, ORIGIN.lat, ORIGIN.lng, 0).geometry.attributes.position;
  let below = 0;
  for (let i = 0; i < rp.count; i++) {
    ray.set(new THREE.Vector3(rp.getX(i), 500, rp.getZ(i)), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(terrain)[0];
    if (hit && rp.getY(i) < hit.point.y) below++;
  }
  check('a long straight road over a hill never dips under the ground', below === 0, `${below} of ${rp.count} vertices under`);

  // Bridges: one over a river is raised with railings and colliders, an overpass stays on the ground
  const river = { id: 'w1', tags: { waterway: 'river' }, geometry: [at(0, -150), at(0, 150)] };
  const bridge = { id: 'b1', tags: { highway: 'primary', bridge: 'yes' }, geometry: [at(-40, 0), at(40, 0)] };
  const overpass = { id: 'b2', tags: { highway: 'primary', bridge: 'yes' }, geometry: [at(60, 60), at(140, 60)] };
  markWaterBridges({ roads: [bridge, overpass], water: [river] });
  check('a bridge crossing a river is marked as over water, one over a road is not', bridge.overWater === true && overpass.overWater === false);
  const spanA = { id: 'v1', tags: { highway: 'motorway', bridge: 'viaduct' }, geometry: [at(-30, -100), at(-30, 0)] };
  const spanB = { id: 'v2', tags: { highway: 'motorway', bridge: 'viaduct' }, geometry: [at(-30, 0), at(-30, 100)] };
  const river2 = { id: 'w2', tags: { waterway: 'river' }, geometry: [at(-26, -150), at(-26, 150)] };
  markWaterBridges({ roads: [spanA, spanB], water: [river2] });
  for (const r of [spanA, spanB]) generateRoads([r], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0);
  const joint = bridgeLiftAt(spanA, -30, 0), outer = bridgeLiftAt(spanA, -30, -100);
  check('two bridge spans in a row stay up where they meet (no dip in a viaduct)', spanA.overWater && near(joint, 2.5, 0.01) && near(bridgeLiftAt(spanB, -30, 0), 2.5, 0.01) && near(outer, 0, 0.01), `joint ${joint.toFixed(2)} m, outer end ${outer.toFixed(2)} m`);
  const deck = generateRoads([bridge], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0);
  const dbox = new THREE.Box3().setFromObject(deck);
  check('the bridge deck rises over the river and has railings and colliders', dbox.max.y > 3 && deck.userData.body?.shapes.length > 10, `top ${dbox.max.y.toFixed(1)} m, ${deck.userData.body?.shapes.length} shapes`);
  const bw = new CANNON.World();
  bw.addBody(deck.userData.body);
  const hits = new CANNON.RaycastResult();
  bw.raycastClosest(new CANNON.Vec3(0, 20, 0), new CANNON.Vec3(0, -20, 0), {}, hits);
  check('the car can drive on the middle of the bridge', hits.hasHit && near(hits.hitPointWorld.y, 2.55, 0.3), `deck at ${hits.hitPointWorld.y.toFixed(2)} m`);

  // Towers: Tokyo Tower is a 'building' outline tagged height=21 (the building between its legs)
  const tokyo = towerSpec({ width: 88, tags: { man_made: 'tower', 'tower:type': 'communication', 'tower:construction': 'lattice', height: '21' } });
  check('a big lattice TV tower gets a landmark height, not its base building height', tokyo.shape === 'lattice' && tokyo.height > 300 && tokyo.banded, `${tokyo.shape} ${tokyo.height.toFixed(0)} m`);
  check('chimney, water tower and mast keep their tagged height',
    towerSpec({ tags: { man_made: 'chimney', height: '80' } }).height === 80 && towerSpec({ tags: { man_made: 'water_tower' } }).shape === 'water' && towerSpec({ tags: { man_made: 'mast', height: '100' } }).banded);
  const tg = towerGeometry(tokyo);
  tg.computeBoundingBox();
  check('the lattice tower is as tall as its spec', near(tg.boundingBox.max.y, tokyo.height, 2), `${tg.boundingBox.max.y.toFixed(0)} m`);
  const parsedTowers = parseOsmXml(`<osm><node id="9" lat="13.2836" lon="100.9268"><tag k="man_made" v="mast"/><tag k="height" v="70"/></node></osm>`).towers;
  check('a mast node is parsed as a tower', parsedTowers.length === 1 && parsedTowers[0].tags.height === '70');
  const tgroup = generateTowers(parsedTowers, flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0);
  // Bug: OSM's 3D sketch of Tokyo Tower (sections at min_height 217-332 m) was built from the ground with windows
  const floating = { id: 7, tags: { building: 'yes', height: '246', min_height: '241' }, geometry: square(-5, -5, 5, 5) };
  const fbox = new THREE.Box3().setFromObject(generateBuildings([floating], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0));
  check('a building part with min_height floats instead of standing on the ground', fbox.min.y > 240 && near(fbox.max.y, 246, 0.5), `y ${fbox.min.y.toFixed(0)}..${fbox.max.y.toFixed(0)}`);
  check('building=roof is only its roof height thick', minHeight({ tags: { building: 'roof', height: '40', 'roof:height': '33' } }) === 7);
  const towerAt = { lat: at(0, 0).lat, lon: at(0, 0).lon, width: 80, tags: { man_made: 'tower' } };
  const kept = dropTowerParts([floating, { id: 8, tags: { building: 'yes' }, bounds: { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 } },
    { ...floating, id: 9, bounds: { minLat: at(0, 0).lat, maxLat: at(0, 0).lat, minLon: at(0, 0).lon, maxLon: at(0, 0).lon } }], [towerAt], ORIGIN.lat, ORIGIN.lng);
  check('OSM sections inside a tower outline give way to the tower model', kept.length === 2 && !kept.some((b) => b.id === 9));
  // Thailand: floodlight masts were drawn as 60 m red-white radio masts, chedis as grey boxes, temples as offices
  const flood = towerSpec({ tags: { man_made: 'mast', 'tower:type': 'lighting' } }, true);
  check('a floodlight mast is a 25 m grey pole, not a banded radio mast', flood.shape === 'pole' && flood.height === 25 && !flood.banded);
  const chedi = towerSpec({ width: 10, tags: { man_made: 'tower', 'tower:type': 'pagoda' } }, true);
  check('a pagoda in Thailand is a chedi about twice as tall as its base', chedi.shape === 'chedi' && near(chedi.height, 23, 0.1));
  const wat = { id: 21, tags: { building: 'temple' }, geometry: square(-10, -5, 10, 5) };
  const watBox = new THREE.Box3().setFromObject(generateBuildings([wat], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0));
  check('a Thai temple hall gets a steep roof with overhanging eaves', isThaiTemple(wat.tags, true) && watBox.max.y > 9 && watBox.max.z > 5.5 && watBox.min.z < -5.5,
    `top ${watBox.max.y.toFixed(1)} m, eaves z ${watBox.min.z.toFixed(1)}..${watBox.max.z.toFixed(1)}`);
  check('temples outside the tropics keep the normal building', !isThaiTemple(wat.tags, false));
  const chediB = { id: 22, tags: { building: 'temple', man_made: 'tower', 'tower:type': 'pagoda' }, geometry: square(-5, -5, 5, 5) };
  check('a chedi outline is not also built as a box', generateBuildings([chediB], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0) === null);
  const chediMesh = generateTowers([{ id: 'c', ...at(30, 30), width: 10, tags: { man_made: 'tower', 'tower:type': 'pagoda' } }], flat(), 0, 0, ORIGIN.lat, ORIGIN.lng, 0);
  check('a chedi gets a mesh of its height', chediMesh.children.some((m) => m.userData.tower === 'chedi' && (m.geometry.computeBoundingBox(), near(m.geometry.boundingBox.max.y, 23, 1))));
  // Thai streets: concrete poles on the kerb side every 40 m with sagging wires between them
  const soi = { tags: { highway: 'residential' }, geometry: [at(-300, 20), at(300, 20)] };
  const rows = poleRows([soi], ORIGIN.lat, ORIGIN.lng, true)[0];
  check('poles stand on the left kerb in left-hand traffic, 40 m apart', rows.every((p) => near(p.z, 20 - 4.2, 0.1)) && near(rows[1].x - rows[0].x, 40, 0.1), `z=${rows[0].z.toFixed(1)}`);
  check('overhead wires in Thailand, not in London or Tokyo', hasOverheadWires(13.75, 100.5) && hasOverheadWires(13.28, 100.93) && !hasOverheadWires(51.5, -0.12) && !hasOverheadWires(35.66, 139.75));
  const perChunkPoles = [-1, 0, 1].map((cx) => generatePowerLines([soi], flat(), cx * CHUNK_SIZE, 0, ORIGIN.lat, ORIGIN.lng, 0, true));
  const poleCount = perChunkPoles.reduce((n, g) => n + (g?.children[0].count ?? 0), 0);
  const wires = perChunkPoles[1].children.find((c) => c.isLineSegments).geometry.attributes.position;
  let lowest = Infinity;
  for (let i = 0; i < wires.count; i++) lowest = Math.min(lowest, wires.getY(i));
  check('each pole is built once across chunks and wires sag between poles', poleCount === rows.length && lowest > 4 && lowest < 5.8, `${poleCount}/${rows.length} poles, lowest wire ${lowest.toFixed(1)} m`);
  check('no poles on footways, driveways or bridges', poleRows([{ tags: { highway: 'footway' }, geometry: soi.geometry }, { tags: { highway: 'service', service: 'driveway' }, geometry: soi.geometry }, { tags: { highway: 'residential', bridge: 'yes' }, geometry: soi.geometry }], ORIGIN.lat, ORIGIN.lng, true).length === 0);
  // Thai traffic: pickups, motorbikes, tuk-tuks, songthaews and taxis; cars only elsewhere
  const kinds = new Set(Array.from({ length: 200 }, (_, i) => pickKind(true, i / 200)));
  check('the Thai street mix has every vehicle kind, other countries only cars', ['car', 'pickup', 'motorbike', 'taxi', 'tuktuk', 'songthaew'].every((k) => kinds.has(k)) && pickKind(false, 0.5) === 'car');
  const sizes = ['car', 'pickup', 'motorbike', 'tuktuk', 'songthaew', 'taxi'].map((k) => {
    const v = buildVehicle(k);
    const bb = new THREE.Box3().setFromObject(v.mesh);
    return { k, len: bb.max.z - bb.min.z, wid: bb.max.x - bb.min.x, fits: Math.abs((bb.max.z - bb.min.z) / 2 - v.half[2]) < 0.4 };
  });
  check('vehicles have real sizes (motorbike ~2 m, tuk-tuk ~3 m, pickup ~5 m) and colliders that fit', sizes.every((s) => s.fits) &&
    sizes.find((s) => s.k === 'motorbike').len < 2.2 && near(sizes.find((s) => s.k === 'tuktuk').len, 2.8, 0.4) && near(sizes.find((s) => s.k === 'pickup').len, 5.2, 0.3),
    sizes.map((s) => `${s.k} ${s.len.toFixed(1)}x${s.wid.toFixed(1)}`).join(', '));
  // Real shop names: a pharmacy node 3 m in front of a shophouse gets its sign on that wall, facing the street
  const pois = parseOsmXml(`<osm><node id="5" lat="13.2836" lon="100.9268"><tag k="amenity" v="pharmacy"/><tag k="name" v="สมบูรณ์โอสถ"/></node><node id="6" lat="13.2836" lon="100.9269"><tag k="shop" v="bakery"/></node></osm>`).pois;
  check('named shops and pharmacies are read from OSM nodes (unnamed ones skipped)', pois.length === 1 && pois[0].name === 'สมบูรณ์โอสถ' && pois[0].kind === 'amenity=pharmacy');
  const shopRing = { pts: [[-6, 3], [6, 3], [6, 15], [-6, 15], [-6, 3]].map(([x, z]) => new THREE.Vector2(x, z)), floorY: 0 };
  const [sign] = signPlacements([{ x: 1, z: 0, name: 'สมบูรณ์โอสถ', kind: 'amenity=pharmacy' }], [shopRing]);
  check('the sign hangs on the street wall above the ground floor, facing out', sign && near(sign.z, 2.88, 0.05) && sign.nz < -0.99 && sign.y > 3 && sign.width <= 7,
    sign && `z=${sign.z.toFixed(2)}, y=${sign.y.toFixed(1)}, ${sign.width.toFixed(1)} m wide`);
  // Bug: walls of clockwise outlines had their texture mirrored (shop lettering read backwards)
  const uRight = (ring) => {
    const g = wallBands(ring, 0, 6, 3, new THREE.Color(1, 1, 1)).upper;
    const p = g.attributes.position, uv = g.attributes.uv, n = g.attributes.normal;
    let ok = true;
    for (let i = 0; i < p.count; i += 6) {
      // Right as seen from outside the wall: (n.z, -n.x)
      const rx = n.getZ(i), rz = -n.getX(i);
      for (let k = 1; k < 6; k++) {
        const du = uv.getX(i + k) - uv.getX(i), dp = (p.getX(i + k) - p.getX(i)) * rx + (p.getZ(i + k) - p.getZ(i)) * rz;
        if (Math.abs(dp) > 0.1 && Math.sign(du) !== Math.sign(dp)) ok = false;
      }
    }
    return ok;
  };
  const ccw = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]].map(([x, z]) => new THREE.Vector2(x, z));
  check('wall textures read left-to-right from outside on both outline directions', uRight(ccw) && uRight([...ccw].reverse()));
  check('towers get a mesh and a collider', tgroup.children.length >= 1 && tgroup.userData.body.shapes.length === 1);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
