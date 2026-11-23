/**
 * Polyline.js — measuring, cutting and clipping 2D polylines (x, z stored in THREE.Vector2 x / y).
 * Everything works in "distance along the line" so pieces cut in different chunks line up exactly.
 */

import * as THREE from 'three';

/** @param {THREE.Vector2[]} points @returns {number[]} distance from the start at each point */
export function cumulativeLengths(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + points[i].distanceTo(points[i - 1]));
  return cum;
}

/** Point and unit direction at a distance along a polyline */
export function pointAt(points, cum, s) {
  let i = 1;
  while (i < points.length - 1 && cum[i] < s) i++;
  const a = points[i - 1], b = points[i];
  const len = cum[i] - cum[i - 1] || 1;
  const p = a.clone().lerp(b, (s - cum[i - 1]) / len);
  return { p, dir: b.clone().sub(a).normalize() };
}

/** The part of the polyline between distances a and b */
export function extract(points, cum, a, b) {
  const piece = [pointAt(points, cum, a).p];
  const add = (p) => { if (p.distanceTo(piece[piece.length - 1]) > 0.01) piece.push(p); }; // no zero-length segments
  for (let i = 0; i < points.length; i++) if (cum[i] > a && cum[i] < b) add(points[i].clone());
  add(pointAt(points, cum, b).p);
  return piece;
}

/**
 * Intervals (in distance along the line) that lie inside an axis-aligned rectangle.
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} rect
 * @returns {[number, number][]}
 */
export function insideIntervals(points, cum, rect) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const t = clipSegment(points[i], points[i + 1], rect);
    if (!t) continue;
    const len = cum[i + 1] - cum[i];
    const a = cum[i] + t[0] * len, b = cum[i] + t[1] * len;
    const last = out[out.length - 1];
    if (last && a - last[1] < 1e-6) last[1] = b; // continues the previous interval
    else out.push([a, b]);
  }
  return out;
}

/** Liang-Barsky: parameter range [t0, t1] of segment a->b inside rect, or null */
function clipSegment(a, b, rect) {
  const dx = b.x - a.x, dz = b.y - a.y;
  let t0 = 0, t1 = 1;
  const edges = [[-dx, a.x - rect.minX], [dx, rect.maxX - a.x], [-dz, a.y - rect.minZ], [dz, rect.maxZ - a.y]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
  }
  return t0 < t1 ? [t0, t1] : null;
}

/** keep minus every [s - clear, s + clear] around each stop */
export function removeAround(keep, stops, clear) {
  for (const s of stops) {
    const next = [];
    for (const [a, b] of keep) {
      if (s + clear <= a || s - clear >= b) next.push([a, b]);
      else {
        if (s - clear > a) next.push([a, s - clear]);
        if (s + clear < b) next.push([s + clear, b]);
      }
    }
    keep = next;
  }
  return keep;
}

/**
 * Cut a polyline into dashes. `phase` is the distance along the whole road where this piece starts,
 * so dashes drawn by two chunks for the same road continue the same rhythm.
 * @returns {THREE.Vector2[][]} one short polyline per dash
 */
export function dashPolyline(points, dash, gap, phase = 0) {
  const period = dash + gap;
  const dashes = [];
  let current = null;
  let pos = ((phase % period) + period) % period;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const len = a.distanceTo(b);
    let t = 0;
    while (t < len - 1e-9) {
      const inDash = pos < dash;
      const step = Math.min(len - t, inDash ? dash - pos : period - pos);
      if (inDash) {
        const p0 = a.clone().lerp(b, t / len);
        const p1 = a.clone().lerp(b, (t + step) / len);
        if (!current) { current = [p0]; dashes.push(current); }
        current.push(p1);
      }
      t += step;
      pos += step;
      if (inDash && pos >= dash - 1e-9) current = null; // this dash is finished
      if (pos >= period - 1e-9) pos = 0;
    }
  }
  return dashes.filter((d) => d.length >= 2 && d[0].distanceTo(d[d.length - 1]) > 0.5);
}

