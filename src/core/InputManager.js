/**
 * InputManager.js — จัดการ keyboard input
 */

export class InputManager {
  constructor() {
    /** @type {Set<string>} */
    this.keysDown = new Set();

    /** @type {Set<string>} */
    this.keysJustPressed = new Set();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  _onKeyDown(e) {
    const code = e.code.toLowerCase();
    if (!this.keysDown.has(code)) {
      this.keysJustPressed.add(code);
    }
    this.keysDown.add(code);

    // Prevent space scrolling
    if (e.code === 'Space') e.preventDefault();
  }

  _onKeyUp(e) {
    this.keysDown.delete(e.code.toLowerCase());
  }

  /**
   * Check if key is currently held down
   * @param {string} key
   */
  isDown(key) {
    return this.keysDown.has(key.toLowerCase());
  }

  /**
   * Check if key was just pressed this frame
   * @param {string} key
   */
  justPressed(key) {
    return this.keysJustPressed.has(key.toLowerCase());
  }

  /** Call at end of each frame */
  update() {
    this.keysJustPressed.clear();
  }

  /** Forward/accelerate */
  get forward() {
    return this.isDown('keyw') || this.isDown('arrowup');
  }

  /** Backward/brake */
  get backward() {
    return this.isDown('keys') || this.isDown('arrowdown');
  }

  /** Steer left */
  get left() {
    return this.isDown('keya') || this.isDown('arrowleft');
  }

  /** Steer right */
  get right() {
    return this.isDown('keyd') || this.isDown('arrowright');
  }

  /** Handbrake */
  get handbrake() {
    return this.isDown('space');
  }

  /** Reset car */
  get reset() {
    return this.justPressed('keyr');
  }

  /** Toggle camera */
  get toggleCamera() {
    return this.justPressed('keyc');
  }

  /** Toggle settings */
  get toggleSettings() {
    return this.justPressed('escape');
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}
