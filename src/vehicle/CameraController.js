/**
 * CameraController.js — Third-person camera that follows the car
 */

import * as THREE from 'three';
import { CAMERA_OFFSET, CAMERA_LOOK_AHEAD, CAMERA_DAMPING } from '../config.js';

const CAMERA_MODES = ['THIRD_PERSON', 'BIRDS_EYE', 'HOOD'];

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
  }

  /**
   * @param {number} delta
   * @param {import('../core/InputManager.js').InputManager} input
   */
  update(delta, input) {
    // Toggle camera mode
    if (input.toggleCamera) {
      this.modeIndex = (this.modeIndex + 1) % CAMERA_MODES.length;
      this.mode = CAMERA_MODES[this.modeIndex];
    }

    const carPos = this.carController.getPosition();
    const carPosVec = new THREE.Vector3(carPos.x, carPos.y, carPos.z);
    const forward = this.carController.getForwardDirection();

    let targetPos, targetLookAt;

    switch (this.mode) {
      case 'THIRD_PERSON': {
        // Position behind and above car
        const offset = new THREE.Vector3(
          CAMERA_OFFSET.x,
          CAMERA_OFFSET.y,
          CAMERA_OFFSET.z
        );
        // Rotate offset by car's Y rotation
        const carQuat = new THREE.Quaternion();
        carQuat.set(
          this.carController.chassisBody.quaternion.x,
          this.carController.chassisBody.quaternion.y,
          this.carController.chassisBody.quaternion.z,
          this.carController.chassisBody.quaternion.w
        );
        offset.applyQuaternion(carQuat);

        targetPos = carPosVec.clone().add(offset);
        targetLookAt = carPosVec.clone().add(
          forward.clone().multiplyScalar(CAMERA_LOOK_AHEAD)
        );
        targetLookAt.y = carPos.y + 1;
        break;
      }

      case 'BIRDS_EYE': {
        targetPos = new THREE.Vector3(carPos.x, carPos.y + 50, carPos.z - 5);
        targetLookAt = carPosVec.clone();
        break;
      }

      case 'HOOD': {
        // On top of the hood, looking forward
        const hoodOffset = forward.clone().multiplyScalar(2);
        targetPos = new THREE.Vector3(
          carPos.x + hoodOffset.x,
          carPos.y + 1.5,
          carPos.z + hoodOffset.z
        );
        targetLookAt = carPosVec.clone().add(
          forward.clone().multiplyScalar(20)
        );
        targetLookAt.y = carPos.y + 1;
        break;
      }
    }

    // Initialize on first frame (no smoothing)
    if (!this._initialized) {
      this._currentPos.copy(targetPos);
      this._currentLookAt.copy(targetLookAt);
      this._initialized = true;
    }

    // Smooth camera movement
    const damping = 1 - Math.pow(CAMERA_DAMPING, delta * 60);
    this._currentPos.lerp(targetPos, damping);
    this._currentLookAt.lerp(targetLookAt, damping);

    this.camera.position.copy(this._currentPos);
    this.camera.lookAt(this._currentLookAt);
  }
}
