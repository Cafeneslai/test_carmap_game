/**
 * DrivingSide.js — which side of the road traffic keeps to at a place.
 * shortcut: rough boxes around left-hand-traffic regions, so border areas can be wrong
 * (e.g. Laos/Cambodia next to Thailand); use a country lookup if that matters.
 */

// [south, west, north, east]
const LEFT_HAND_BOXES = [
  [49.8, -11, 61, 1.8],       // UK, Ireland
  [24, 122, 46, 146],         // Japan
  [5.6, 97.3, 20.5, 105.6],   // Thailand
  [5.8, 60.8, 37, 92.5],      // India, Pakistan, Nepal, Bangladesh, Sri Lanka
  [-11, 95, 7.5, 141],        // Indonesia, Malaysia, Singapore, Brunei, Timor-Leste
  [22.1, 113.8, 22.6, 114.5], // Hong Kong, Macau
  [-44, 112, -10, 154],       // Australia
  [-47.5, 166, -34, 179],     // New Zealand
  [-35, 11, -8, 41],          // Southern & East Africa (South Africa ... Kenya)
  [-5, 29, 5, 42],            // Uganda, Kenya, Tanzania
];

/**
 * Thailand and its neighbours (Laos, Cambodia, Vietnam, Myanmar, Malaysia): overhead wires on every
 * street, pickups, motorbikes and tuk-tuks in traffic. shortcut: one box, rough at the borders.
 */
export function isSoutheastAsia(lat, lng) {
  return lat > 0.8 && lat < 28.5 && lng > 92 && lng < 110;
}

/** @returns {boolean} true where traffic drives on the left */
export function isLeftHandTraffic(lat, lng) {
  return LEFT_HAND_BOXES.some(([s, w, n, e]) => lat >= s && lat <= n && lng >= w && lng <= e);
}
