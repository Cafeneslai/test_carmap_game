/**
 * WorldBuilder.js — Orchestrates building a chunk from raw data
 */

import { cache } from '../data/CacheManager.js';
import { fetchChunkData } from '../data/OSMFetcher.js';
import { ElevationField } from '../data/ElevationField.js';
import { TERRAIN_RESOLUTION, CHUNK_SIZE } from '../config.js';
import { getElevationAt } from './ElevationUtils.js';
import { generateTerrain } from './TerrainGenerator.js';
import { generateRoads } from './RoadGenerator.js';
import { generateBuildings } from './BuildingGenerator.js';
import { generateWater } from './WaterGenerator.js';
import { placeVegetation } from './VegetationPlacer.js';
import { generateStreetLamps } from './StreetLamps.js';
import { generateTrafficLights } from './TrafficLights.js';
import { isLeftHandTraffic } from '../data/DrivingSide.js';
import { paintGround, getGroundDetailTexture } from './GroundPainter.js';
import { satelliteGround } from './SatelliteGround.js';
import { generateTowers, dropTowerParts } from './Towers.js';
import { generatePowerLines, hasOverheadWires } from './PowerLines.js';

// Bump when the shape or orientation of cached data changes. v3: elevation comes from the shared
// world lattice (ElevationField), rows run north->south, buildings belong to a single chunk.
const CACHE_VERSION = 'v10'; // v10: towers (man_made); v9: buildings with courtyards (multipolygon); v8: OSM street trees (natural=tree, tree_row); v7: Overture buildings where OSM has none; v6: multipolygon relations (big forests, lakes with islands); v5: landcover; v4: signals

function flatGrid() {
  return Array.from({ length: TERRAIN_RESOLUTION }, () => new Array(TERRAIN_RESOLUTION).fill(0));
}

export class WorldBuilder {
  /**
   * @param {number} originLat
   * @param {number} originLng
   */
  constructor(originLat, originLng) {
    this.originLat = originLat;
    this.originLng = originLng;
    this.originBaseElevation = null;
    this.treesEnabled = true;
    this.satelliteEnabled = true;
    this.elevation = new ElevationField(originLat, originLng);
    this.leftHand = isLeftHandTraffic(originLat, originLng);
  }

  async _loadOsm(chunk, bbox) {
    const key = `osm_${CACHE_VERSION}_${chunk.key}`;
    const cached = await cache.get(key);
    if (cached) return cached;

    try {
      const data = await fetchChunkData(bbox);
      if (!data.synthetic) cache.set(key, data);
      return data;
    } catch (err) {
      console.warn('OSM data failed for chunk', chunk.key, err);
      return { roads: [], buildings: [], water: [], greenery: [], signals: [], landcover: [] };
    }
  }

  async _loadElevation(chunk) {
    const key = `elev_${CACHE_VERSION}_${chunk.key}`;
    const cached = await cache.get(key);
    if (cached) return cached;

    try {
      const { grid, complete } = await this.elevation.sampleChunk(chunk.chunkX, chunk.chunkZ, TERRAIN_RESOLUTION);
      if (complete) cache.set(key, grid); // an estimated grid is shown but never cached
      return grid;
    } catch (err) {
      // Flat ground for this session only; never cache a made-up grid.
      console.warn('Elevation unavailable for chunk', chunk.key, err.message);
      return flatGrid();
    }
  }

  /**
   * Height of the terrain at a world position, or null when that chunk is not built.
   * @param {Map<string, import('./Chunk.js').Chunk>} chunks
   */
  getTerrainHeight(chunks, x, z) {
    const cx = Math.floor(x / CHUNK_SIZE + 0.5);
    const cz = Math.floor(z / CHUNK_SIZE + 0.5);
    const chunk = chunks.get(`${cx},${cz}`);
    if (!chunk || !chunk.elevationData) return null;
    return getElevationAt(x - chunk.worldX, z - chunk.worldZ, chunk.elevationData, this.originBaseElevation);
  }

  /**
   * Build all meshes for a chunk
   * @param {import('./Chunk.js').Chunk} chunk
   * @param {import('three').Scene} scene
   * @param {import('cannon-es').World} physicsWorld
   */
  async buildChunk(chunk, scene, physicsWorld) {
    const bbox = chunk.getBBox();

    // Aerial imagery downloads alongside the map data; without it the land cover is painted
    const [osmData, elevationData, satellite] = await Promise.all([
      this._loadOsm(chunk, bbox),
      this._loadElevation(chunk),
      this.satelliteEnabled ? satelliteGround(chunk.worldX, chunk.worldZ, this.originLat, this.originLng) : null,
    ]);

    chunk.osmData = osmData;
    chunk.elevationData = elevationData;

    // One shared reference height for the whole world so chunk borders line up
    if (this.originBaseElevation === null) {
      const mid = Math.floor(elevationData.length / 2);
      this.originBaseElevation = elevationData[mid]?.[mid] ?? 0;
    }
    const base = this.originBaseElevation;
    const { originLat, originLng } = this;

    // 1. Terrain (+ physics heightfield)
    const ground = satellite || paintGround(osmData.landcover, chunk.worldX, chunk.worldZ, originLat, originLng);
    const terrain = generateTerrain(elevationData, chunk.worldX, chunk.worldZ, originLat, originLng, base, ground, getGroundDetailTexture());
    if (terrain.mesh) chunk.meshGroup.add(terrain.mesh);
    if (terrain.body) {
      physicsWorld.addBody(terrain.body);
      chunk.physicsBodies.push(terrain.body);
    }

    // 2. Roads
    if (osmData.roads.length > 0) {
      const roads = generateRoads(osmData.roads, elevationData, chunk.worldX, chunk.worldZ, originLat, originLng, base);
      if (roads) chunk.meshGroup.add(roads);
      if (roads?.userData.body) {
        physicsWorld.addBody(roads.userData.body);
        chunk.physicsBodies.push(roads.userData.body);
      }
      const lamps = generateStreetLamps(osmData.roads, elevationData, chunk.worldX, chunk.worldZ, originLat, originLng, base);
      const signals = generateTrafficLights(osmData.signals, osmData.roads, elevationData, chunk.worldX, chunk.worldZ, originLat, originLng, base, this.leftHand);
      const wires = hasOverheadWires(originLat, originLng)
        ? generatePowerLines(osmData.roads, elevationData, chunk.worldX, chunk.worldZ, originLat, originLng, base, this.leftHand)
        : null;
      for (const extra of [lamps, signals, wires]) {
        if (!extra) continue;
        chunk.meshGroup.add(extra);
        physicsWorld.addBody(extra.userData.body);
        chunk.physicsBodies.push(extra.userData.body);
      }
    }

    // 3. Buildings
    if (osmData.buildings.length > 0) {
      const buildings = generateBuildings(dropTowerParts(osmData.buildings, osmData.towers, originLat, originLng), elevationData, chunk.worldX, chunk.worldZ, originLat, originLng, base, osmData.landcover, osmData.roads);
      if (buildings) {
        chunk.meshGroup.add(buildings);
        const body = buildings.userData.body;
        if (body) {
          physicsWorld.addBody(body);
          chunk.physicsBodies.push(body);
        }
      }
    }

    // 3b. Towers, masts, chimneys
    const towers = generateTowers(osmData.towers, elevationData, chunk.worldX, chunk.worldZ, originLat, originLng, base);
    if (towers) {
      chunk.meshGroup.add(towers);
      physicsWorld.addBody(towers.userData.body);
      chunk.physicsBodies.push(towers.userData.body);
    }

    // 4. Water
    if (osmData.water.length > 0) {
      const water = generateWater(osmData.water, chunk.worldX, chunk.worldZ, originLat, originLng, elevationData, base);
      if (water) chunk.meshGroup.add(water);
    }

    // 5. Vegetation
    if (osmData.greenery.length > 0 || osmData.trees?.length > 0) {
      const trees = placeVegetation(osmData.greenery, elevationData, chunk.worldX, chunk.worldZ, originLat, originLng, base, osmData);
      if (trees) {
        trees.name = 'vegetation';
        trees.visible = this.treesEnabled;
        chunk.meshGroup.add(trees);
      }
    }

    // Geometry is generated in world coordinates already
    chunk.meshGroup.position.set(0, 0, 0);
  }
}
