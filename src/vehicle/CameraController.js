/**
 * CameraController.js — Third-person camera that follows the car
 *
 * The camera follows the car's heading (yaw) only. Following the full orientation would make the
 * view pitch and roll with every bump and tip the horizon when the suspension compresses.
 */

import * as THREE from 'three';
import { CAMERA_FOV, CAMERA_OFFSET, CAMERA_LOOK_AHEAD, CAMERA_DAMPING } from '../config.js';

const CAMERA_MODES = ['THIRD_PERSON', 'BIRDS_EYE', 'HOOD'];
const FOV_BOOST_AT_TOP_SPEED = 12; // degrees added at ~150 km/h
const UP = new THREE.Vector3(0, 1, 0);

export class CameraController {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('./CarController.js').CarController} carController
   */
  constructor(camera, carController) {
    this.camera = camera;
    this.carController = carController;
    this.modeIndex = 0;
    this.mode = CAMERA_MODES[0];

    // Smoothed values
    this._currentPos = new THREE.Vector3();
    this._currentLookAt = new THREE.Vector3();
    this._initialized = false;

    // Scratch vectors
    this._carPos = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._targetPos = new THREE.Vector3();
    this._targetLookAt = new THREE.Vector3();
  }

  /**
   * @param {number} delta
   * @param {import('../core/InputManager.js').InputManager} input
   */
  update(delta, input) {
    if (input.toggleCamera) {
      this.modeIndex = (this.modeIndex + 1) % CAMERA_MODES.length;
      this.mode = CAMERA_MODES[this.modeIndex];
    }

    const carPos = this._carPos.copy(this.carController.getPosition());
    const heading = this.carController.getHeading();
    // Flat forward vector: the nose direction with pitch and roll removed
    const forward = this._forward.set(Math.sin(heading), 0, Math.cos(heading));

    const targetPos = this._targetPos;
    const targetLookAt = this._targetLookAt;

    switch (this.mode) {
      case 'THIRD_PERSON': {
        this._offset.set(CAMERA_OFFSET.x, CAMERA_OFFSET.y, CAMERA_OFFSET.z).applyAxisAngle(UP, heading);
        targetPos.copy(carPos).add(this._offset);
        targetLookAt.copy(carPos).addScaledVector(forward, CAMERA_LOOK_AHEAD);
        targetLookAt.y = carPos.y + 1;
        break;
      }

      case 'BIRDS_EYE': {
        targetPos.set(carPos.x, carPos.y + 50, carPos.z - 5);
        targetLookAt.copy(carPos);
        break;
      }

      case 'HOOD': {
        targetPos.copy(carPos).addScaledVector(forward, 2);
        targetPos.y = carPos.y + 0.8;
        targetLookAt.copy(carPos).addScaledVector(forward, 20);
        targetLookAt.y = carPos.y + 0.8;
        break;
      }
    }

    // Snap on the first frame and after reset(), then smooth
    if (!this._initialized) {
      this._currentPos.copy(targetPos);
      this._currentLookAt.copy(targetLookAt);
      this._initialized = true;
    }

    const damping = 1 - Math.pow(CAMERA_DAMPING, delta * 60);
    this._currentPos.lerp(targetPos, damping);
    this._currentLookAt.lerp(targetLookAt, damping);

    this.camera.position.copy(this._currentPos);
    this.camera.lookAt(this._currentLookAt);

    // Wider field of view at speed gives a sense of acceleration
    const wantedFov = CAMERA_FOV + Math.min(1, this.carController.speed / 150) * FOV_BOOST_AT_TOP_SPEED;
    if (Math.abs(this.camera.fov - wantedFov) > 0.05) {
      this.camera.fov += (wantedFov - this.camera.fov) * (1 - Math.exp(-4 * delta));
      this.camera.updateProjectionMatrix();
    }
  }

  /** Jump straight to the target on the next update (after teleporting the car) */
  reset() {
    this._initialized = false;
  }
}
