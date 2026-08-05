/**
 * main.js — App entry point
 */

import { Game } from './core/Game.js';

const canvas = document.getElementById('game-canvas');

if (!canvas) {
  throw new Error('Canvas element #game-canvas not found');
}

// Start the game
const game = new Game(canvas);

// Expose for debugging
if (import.meta.env.DEV) {
  window.__game = game;
}
