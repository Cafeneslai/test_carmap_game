/**
 * tiles.js — Leaflet base layer with automatic fallback when a tile provider fails
 */

import L from 'leaflet';
import { TILE_LAYERS } from '../config.js';

const ERRORS_BEFORE_FALLBACK = 4;

/**
 * Add a base layer to the map. If the current provider keeps failing, switch to the next one.
 * @param {L.Map} map
 * @param {'dark' | 'street'} kind
 * @returns {{ current: () => L.TileLayer }}
 */
export function addBaseLayer(map, kind) {
  const providers = TILE_LAYERS[kind];
  let index = 0;
  let errors = 0;
  let layer = null;

  const mount = () => {
    if (layer) map.removeLayer(layer);
    const { url, options } = providers[index];
    layer = L.tileLayer(url, options);
    errors = 0;

    layer.on('tileerror', () => {
      errors++;
      if (errors >= ERRORS_BEFORE_FALLBACK && index < providers.length - 1) {
        index++;
        console.warn(`Tile provider failed, switching to ${providers[index].url}`);
        mount();
      }
    });
    layer.on('tileload', () => {
      errors = 0;
    });

    layer.addTo(map);
  };

  mount();
  return { current: () => layer };
}
