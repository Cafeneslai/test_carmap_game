/**
 * InputManager.js — keyboard, gamepad and on-screen touch buttons.
 * Gamepad and touch are mapped onto the same key codes, so the rest of the game only sees keys.
 */

// Standard-mapping gamepad button index -> key code it acts as
const PAD_BUTTONS = {
  7: 'keyw',   // RT
  6: 'keys',   // LT
  0: 'keyw',   // A
  1: 'keys',   // B
  2: 'space',  // X  handbrake
  3: 'keyr',   // Y  reset
  8: 'keyc',   // Back/View  camera
  9: 'escape', // Start/Menu settings
  12: 'keyw', 13: 'keys', 14: 'keya', 15: 'keyd', // d-pad
};
const STICK_DEADZONE = 0.3;

export class InputManager {
  constructor() {
    /** @type {Set<string>} */
    this.keysDown = new Set();

    /** @type {Set<string>} */
    this.keysJustPressed = new Set();

    /** Keys held by the gamepad and by touch buttons, kept apart so they never release a real key */
    this.padDown = new Set();
    this.touchDown = new Set();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  _onKeyDown(e) {
    // Typing in the location search (or any form field) is not driving
    if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')) return;
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
    const k = key.toLowerCase();
    return this.keysDown.has(k) || this.padDown.has(k) || this.touchDown.has(k);
  }

  /** Read the first connected gamepad. Call once at the start of each frame. */
  pollGamepad() {
    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    const now = new Set();
    if (pad) {
      pad.buttons.forEach((b, i) => { if (b.pressed && PAD_BUTTONS[i]) now.add(PAD_BUTTONS[i]); });
      const x = pad.axes[0] ?? 0;
      if (x < -STICK_DEADZONE) now.add('keya');
      if (x > STICK_DEADZONE) now.add('keyd');
    }
    for (const k of now) if (!this.padDown.has(k)) this.keysJustPressed.add(k);
    this.padDown = now;
  }

  /**
   * Wire on-screen buttons: every element with data-key="keyw" etc. holds that key while pressed.
   * @param {ParentNode} root
   */
  bindTouchButtons(root) {
    for (const el of root.querySelectorAll('[data-key]')) {
      const key = el.dataset.key;
      const press = (e) => {
        e.preventDefault();
        if (!this.touchDown.has(key)) this.keysJustPressed.add(key);
        this.touchDown.add(key);
        el.setPointerCapture?.(e.pointerId);
      };
      const release = () => this.touchDown.delete(key);
      el.addEventListener('pointerdown', press);
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
    }
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
