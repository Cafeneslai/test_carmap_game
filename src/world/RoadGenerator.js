/**
 * RoadGenerator.js — Generate road surface meshes from OSM data
 */

import * as THREE from 'three';
import { ROAD_WIDTHS, ROAD_Y_OFFSET } from '../config.js';
import { latLngToMeters } from '../data/GeoUtils.js';
import { getElevationAt } from './ElevationUtils.js';
import { DRIVABLE } from '../data/OSMFetcher.js';
import { CHUNK_SIZE } from '../config.js';
import { cumulativeLengths, pointAt, extract, insideIntervals, removeAround, dashPolyline } from './Polyline.js';

export { dashPolyline };

const SEAM_OVERLAP = 1.5; // metres a road reaches into the next chunk so there is no visible gap

/** The parts of a polyline more than `clear` metres (along the line) from every stop */
export function cutPolyline(points, cum, stops, clear) {
  return removeAround([[0, cum[cum.length - 1]]], stops, clear)
    .filter(([a, b]) => b - a > 1)
    .map(([a, b]) => extract(points, cum, a, b));
}

/**
 * Generate merged road mesh from OSM way elements
 * 
 * @param {object[]} roads - OSM way elements with highway tag
 * @param {number[][]} elevationData - Chunk elevation grid
 * @param {number} chunkWorldX
 * @param {number} chunkWorldZ
 * @param {number} originLat
 * @param {number} originLng
 * @returns {THREE.Mesh | null}
 */
export function generateRoads(roads, elevationData, chunkWorldX, chunkWorldZ, originLat, originLng, baseElevation = null) {
  const geometries = [];
  const junctions = findJunctions(roads);
  // Each chunk draws only the parts of a road inside it (plus a small overlap to hide the seam).
  // Drawing whole roads made every chunk repeat them, with heights clamped to its own grid outside it.
  const half = CHUNK_SIZE / 2;
  const inChunk = (p) => p.x >= chunkWorldX - half && p.x < chunkWorldX + half && p.y >= chunkWorldZ - half && p.y < chunkWorldZ + half;
  const rect = {
    minX: chunkWorldX - half - SEAM_OVERLAP, maxX: chunkWorldX + half + SEAM_OVERLAP,
    minZ: chunkWorldZ - half - SEAM_OVERLAP, maxZ: chunkWorldZ + half + SEAM_OVERLAP,
  };

  for (const road of roads) {
    if (!road.geometry || road.geometry.length < 2) continue;

    const highwayType = road.tags?.highway || 'residential';
    const width = ROAD_WIDTHS[highwayType] ?? 5;

    // Convert OSM nodes to local positions
    const points = road.geometry.map(node => {
      const { x, z } = latLngToMeters(node.lat, node.lon, originLat, originLng);
      return new THREE.Vector2(x, z);
    });
    const cum = cumulativeLengths(points);
    const inside = insideIntervals(points, cum, rect);
    if (inside.length === 0) continue;

    // Road surface
    for (const [a, b] of inside) {
      const roadGeom = createRoadStrip(extract(points, cum, a, b), width / 2, elevationData, chunkWorldX, chunkWorldZ, baseElevation);
      if (roadGeom) geometries.push(roadGeom);
    }

    // Painted markings, sidewalks and crosswalks; all of them stop short of junctions
    const major = MAJOR_ROADS.has(highwayType);
    const minor = MINOR_MARKED.has(highwayType) && width >= 5;
    if (!major && !minor) continue;

    const mark = (polyline, halfWidth, color, offset = 0, lift = 0.04) => {
      const g = createRoadStrip(polyline, halfWidth, elevationData, chunkWorldX, chunkWorldZ, baseElevation, lift, offset);
      if (g) geometries.push(paint(g, color));
    };
    const oneway = road.tags?.oneway === 'yes' || highwayType === 'motorway';
    const walks = sidewalkSides(road.tags || {});
    const stops = road.geometry
      .map((n, i) => (junctions.get(nodeKey(n)) >= 3 ? cum[i] : null))
      .filter((s) => s !== null);

    for (const [a, b] of removeAround(inside, stops, JUNCTION_CLEAR)) {
      if (b - a < 1) continue;
      const piece = extract(points, cum, a, b);
      if (major) {
        // Solid edge lines, and a solid centre line on two-way roads (dashed lane line on one-way)
        mark(piece, 0.12, WHITE, width / 2 - 0.5);
        mark(piece, 0.12, WHITE, -(width / 2 - 0.5));
        if (oneway) for (const dash of dashPolyline(piece, 3, 6, a)) mark(dash, 0.1, WHITE);
        else mark(piece, 0.15, YELLOW);
      } else if (!oneway) {
        for (const dash of dashPolyline(piece, 3, 6, a)) mark(dash, 0.1, WHITE);
      }
      // Positive offset is the right-hand side of the way's direction
      if (walks.right) mark(piece, SIDEWALK_WIDTH / 2, SIDEWALK, width / 2 + SIDEWALK_WIDTH / 2, 0.02);
      if (walks.left) mark(piece, SIDEWALK_WIDTH / 2, SIDEWALK, -(width / 2 + SIDEWALK_WIDTH / 2), 0.02);
    }

    // Zebra crossing on every arm of a junction, just past where the sidewalks end (only where there are sidewalks)
    if (!walks.left && !walks.right) continue;
    const total = cum[cum.length - 1];
    for (const s of stops) {
      for (const at of [s - JUNCTION_CLEAR + 1.5, s + JUNCTION_CLEAR - 1.5]) {
        if (at < 1.5 || at > total - 1.5) continue;
        if (stops.some((o) => o !== s && Math.abs(o - at) < JUNCTION_CLEAR)) continue; // too close to another junction
        const { p, dir } = pointAt(points, cum, at);
        if (!inChunk(p)) continue; // the neighbouring chunk draws this one
        const seg = [p.clone().addScaledVector(dir, -1.5), p.clone().addScaledVector(dir, 1.5)];
        for (let off = -(width / 2 - 0.7); off <= width / 2 - 0.7 + 1e-6; off += 1) mark(seg, 0.25, WHITE, off);
      }
    }
  }

  if (geometries.length === 0) return null;

  // Merge all road geometries
  const mergedGeometry = mergeBufferGeometries(geometries);
  if (!mergedGeometry) return null;

  const hasVertexColors = !!mergedGeometry.attributes.color;
  const material = new THREE.MeshStandardMaterial({
    color: hasVertexColors ? 0xffffff : 0x333338,
    roughness: 0.85,
    metalness: 0.05,
    vertexColors: hasVertexColors,
    // Roads sit a few centimetres above a coarser terrain mesh; bias depth so they never z-fight
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const mesh = new THREE.Mesh(mergedGeometry, material);
  mesh.receiveShadow = true;

  return mesh;
}

const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const MINOR_MARKED = new Set(['residential', 'unclassified', 'living_street']);
const WHITE = [0.92, 0.92, 0.9];
const SIDEWALK = [0.34, 0.33, 0.31]; // linear: sun-bleached concrete, not white
const SIDEWALK_WIDTH = 2;
const JUNCTION_CLEAR = 9; // metres either side of a junction kept free of lines and sidewalks

const SIDEWALK_BY_DEFAULT = new Set(['primary', 'secondary', 'tertiary']);

/**
 * Which sides of a way get a sidewalk. OSM `sidewalk` tags win (left/right are relative to the way's
 * direction; "separate" means it is mapped as its own footway, so none is drawn here). Untagged
 * town streets (primary/secondary/tertiary) get both sides; residential lanes and highways get none,
 * so village streets and roads through fields are not lined with pavement.
 * @returns {{ left: boolean, right: boolean }}
 */
export function sidewalkSides(tags) {
  const both = tags['sidewalk:both'];
  const v = both ?? tags.sidewalk;
  const yes = (x) => x === 'yes' || x === 'both';
  if (v !== undefined || tags['sidewalk:left'] !== undefined || tags['sidewalk:right'] !== undefined) {
    return {
      left: v === 'left' || yes(v) || yes(tags['sidewalk:left']),
      right: v === 'right' || yes(v) || yes(tags['sidewalk:right']),
    };
  }
  const on = SIDEWALK_BY_DEFAULT.has(tags.highway);
  return { left: on, right: on };
}

const nodeKey = (n) => `${n.lat.toFixed(7)},${n.lon.toFixed(7)}`;

/**
 * Number of road arms meeting at each node: an end of a way counts 1, a node inside a way counts 2.
 * Three or more arms is a real junction (two is just a way continuing as another way).
 * @returns {Map<string, number>}
 */
export function findJunctions(roads) {
  const arms = new Map();
  for (const road of roads) {
    if (!DRIVABLE.has(road.tags?.highway) || !road.geometry) continue;
    const last = road.geometry.length - 1;
    road.geometry.forEach((n, i) => {
      const k = nodeKey(n);
      arms.set(k, (arms.get(k) || 0) + (i === 0 || i === last ? 1 : 2));
    });
  }
  return arms;
}

const YELLOW = [0.95, 0.75, 0.15];

function paint(geometry, [r, g, b]) {
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = r; colors[i + 1] = g; colors[i + 2] = b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Create a road strip from a polyline
 * 
 * @param {THREE.Vector2[]} points - 2D points (x, z)
 * @param {number} halfWidth 
 * @param {number[][]} elevationData
 * @param {number} chunkWorldX
 * @param {number} chunkWorldZ
 * @returns {THREE.BufferGeometry | null}
 */
function createRoadStrip(points, halfWidth, elevationData, chunkWorldX, chunkWorldZ, baseElevation = null, yLift = 0, offset = 0) {
  if (points.length < 2) return null;

  const vertices = [];
  const indices = [];
  const uvs = [];

  let totalDist = 0;

  for (let i = 0; i < points.length; i++) {
    // Compute direction
    let dir;
    if (i === 0) {
      dir = new THREE.Vector2().subVectors(points[1], points[0]).normalize();
    } else if (i === points.length - 1) {
      dir = new THREE.Vector2().subVectors(points[i], points[i - 1]).normalize();
    } else {
      // Average of previous and next direction for smooth corners
      const d1 = new THREE.Vector2().subVectors(points[i], points[i - 1]).normalize();
      const d2 = new THREE.Vector2().subVectors(points[i + 1], points[i]).normalize();
      dir = new THREE.Vector2().addVectors(d1, d2).normalize();
    }

    // Perpendicular (normal)
    const normal = new THREE.Vector2(-dir.y, dir.x);
    // Markings such as edge lines run parallel to the centre line, shifted sideways
    const center = new THREE.Vector2(points[i].x + normal.x * offset, points[i].y + normal.y * offset);

    // Left and right vertices
    const left = new THREE.Vector2(
      center.x + normal.x * halfWidth,
      center.y + normal.y * halfWidth
    );
    const right = new THREE.Vector2(
      center.x - normal.x * halfWidth,
      center.y - normal.y * halfWidth
    );

    // Add vertices (y = terrain elevation + offset)
    const yLeft = getElevationAt(left.x - chunkWorldX, left.y - chunkWorldZ, elevationData, baseElevation) + ROAD_Y_OFFSET + yLift;
    const yRight = getElevationAt(right.x - chunkWorldX, right.y - chunkWorldZ, elevationData, baseElevation) + ROAD_Y_OFFSET + yLift;
    
    vertices.push(left.x, yLeft, left.y);
    vertices.push(right.x, yRight, right.y);

    // UVs
    if (i > 0) {
      totalDist += points[i].distanceTo(points[i - 1]);
    }
    const u = totalDist / (halfWidth * 4);
    uvs.push(0, u);
    uvs.push(1, u);

    // Triangles (connect to previous pair)
    if (i > 0) {
      const idx = (i - 1) * 2;
      // Counter-clockwise seen from above (+Y) so the road faces up and is not culled
      indices.push(idx, idx + 2, idx + 1);
      indices.push(idx + 1, idx + 2, idx + 3);
    }
  }

  if (vertices.length < 6) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

/**
 * Simple geometry merger (without importing BufferGeometryUtils)
 */
function mergeBufferGeometries(geometries) {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0];

  let totalVertices = 0;
  let totalIndices = 0;
  let hasColor = false;

  for (const geom of geometries) {
    totalVertices += geom.attributes.position.count;
    totalIndices += geom.index ? geom.index.count : 0;
    if (geom.attributes.color) hasColor = true;
  }

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const colors = hasColor ? new Float32Array(totalVertices * 3) : null;
  const indices = new Uint32Array(totalIndices);

  let vertexOffset = 0;
  let indexOffset = 0;
  let vertexCount = 0;

  for (const geom of geometries) {
    // Copy positions
    const posAttr = geom.attributes.position;
    for (let i = 0; i < posAttr.count * 3; i++) {
      positions[vertexOffset * 3 + i] = posAttr.array[i];
    }

    // Copy normals
    if (geom.attributes.normal) {
      for (let i = 0; i < posAttr.count * 3; i++) {
        normals[vertexOffset * 3 + i] = geom.attributes.normal.array[i];
      }
    }

    // Copy colors
    if (colors && geom.attributes.color) {
      for (let i = 0; i < posAttr.count * 3; i++) {
        colors[vertexOffset * 3 + i] = geom.attributes.color.array[i];
      }
    } else if (colors) {
      // Default color: dark gray (road surface)
      for (let i = 0; i < posAttr.count; i++) {
        colors[(vertexOffset + i) * 3] = 0.07;
        colors[(vertexOffset + i) * 3 + 1] = 0.07;
        colors[(vertexOffset + i) * 3 + 2] = 0.078;
      }
    }

    // Copy indices with offset
    if (geom.index) {
      for (let i = 0; i < geom.index.count; i++) {
        indices[indexOffset + i] = geom.index.array[i] + vertexOffset;
      }
      indexOffset += geom.index.count;
    }

    vertexOffset += posAttr.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (colors) {
    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  return merged;
}
