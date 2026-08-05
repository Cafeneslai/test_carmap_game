/**
 * WorldBuilder.js — Orchestrates building a chunk from raw data
 */

import { cache } from '../data/CacheManager.js';
import { fetchChunkData } from '../data/OSMFetcher.js';
import { fetchElevationGrid } from '../data/ElevationFetcher.js';
import { TERRAIN_RESOLUTION } from '../config.js';
import { generateTerrain } from './TerrainGenerator.js';
import { generateRoads } from './RoadGenerator.js';
import { generateBuildings } from './BuildingGenerator.js';
import { generateWater } from './WaterGenerator.js';
import { placeVegetation } from './VegetationPlacer.js';

export class WorldBuilder {
  /**
   * @param {number} originLat 
   * @param {number} originLng 
   */
  constructor(originLat, originLng) {
    this.originLat = originLat;
    this.originLng = originLng;
  }

  /**
   * Build all meshes for a chunk
   * @param {import('./Chunk.js').Chunk} chunk
   * @param {import('three').Scene} scene
   * @param {import('cannon-es').World} physicsWorld
   */
  async buildChunk(chunk, scene, physicsWorld) {
    const bbox = chunk.getBBox();

    // Try cache first
    let osmData = await cache.get(`osm_${chunk.key}`);
    let elevationData = await cache.get(`elev_${chunk.key}`);

    // Fetch in parallel if not cached
    const fetchPromises = [];

    if (!osmData) {
      fetchPromises.push(
        fetchChunkData(bbox).then(data => {
          osmData = data;
          cache.set(`osm_${chunk.key}`, data);
        }).catch(err => {
          console.warn('OSM fetch failed for chunk', chunk.key, err);
          osmData = { roads: [], buildings: [], water: [], greenery: [] };
        })
      );
    }

    if (!elevationData) {
      fetchPromises.push(
        fetchElevationGrid(bbox, TERRAIN_RESOLUTION).then(data => {
          elevationData = data;
          cache.set(`elev_${chunk.key}`, data);
        }).catch(() => {
          // Fallback to flat terrain
          elevationData = Array.from({ length: TERRAIN_RESOLUTION },
            () => new Array(TERRAIN_RESOLUTION).fill(0)
          );
        })
      );
    }

    if (fetchPromises.length > 0) {
      await Promise.all(fetchPromises);
    }

    chunk.osmData = osmData;
    chunk.elevationData = elevationData;

    // Generate meshes

    // 1. Terrain
    const terrainResult = generateTerrain(
      elevationData,
      chunk.worldX,
      chunk.worldZ,
      this.originLat,
      this.originLng
    );
    if (terrainResult.mesh) {
      chunk.meshGroup.add(terrainResult.mesh);
    }
    if (terrainResult.body) {
      physicsWorld.addBody(terrainResult.body);
      chunk.physicsBodies.push(terrainResult.body);
    }

    // 2. Roads
    if (osmData && osmData.roads.length > 0) {
      const roadMesh = generateRoads(
        osmData.roads,
        chunk.worldX,
        chunk.worldZ,
        this.originLat,
        this.originLng
      );
      if (roadMesh) {
        chunk.meshGroup.add(roadMesh);
      }
    }

    // 3. Buildings
    if (osmData && osmData.buildings.length > 0) {
      const buildingMesh = generateBuildings(
        osmData.buildings,
        chunk.worldX,
        chunk.worldZ,
        this.originLat,
        this.originLng
      );
      if (buildingMesh) {
        chunk.meshGroup.add(buildingMesh);
      }
    }

    // 4. Water
    if (osmData && osmData.water.length > 0) {
      const waterMesh = generateWater(
        osmData.water,
        chunk.worldX,
        chunk.worldZ,
        this.originLat,
        this.originLng
      );
      if (waterMesh) {
        chunk.meshGroup.add(waterMesh);
      }
    }

    // 5. Vegetation
    if (osmData && osmData.greenery.length > 0) {
      const vegGroup = placeVegetation(
        osmData.greenery,
        chunk.worldX,
        chunk.worldZ,
        this.originLat,
        this.originLng
      );
      if (vegGroup) {
        chunk.meshGroup.add(vegGroup);
      }
    }

    // Set mesh group position to 0,0,0 since coordinates are already world-space
    chunk.meshGroup.position.set(0, 0, 0);
  }
}
