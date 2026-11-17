/**
 * CarController.js — Physics-based car control using Cannon-es RaycastVehicle
 */

import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import {
  CAR_MASS, CAR_MAX_FORCE, CAR_MAX_BRAKE, CAR_MAX_STEER,
  CAR_DIMENSIONS
} from '../config.js';

export class CarController {
  /**
   * @param {CANNON.World} physicsWorld
   * @param {import('./CarModel.js').CarModel} carModel
   */
  constructor(physicsWorld, carModel) {
    this.physicsWorld = physicsWorld;
    this.carModel = carModel;
    this.speed = 0; // km/h

    const { x, y, z } = CAR_DIMENSIONS;

    // Chassis body
    const chassisShape = new CANNON.Box(new CANNON.Vec3(x / 2, y / 2, z / 2));
    this.chassisBody = new CANNON.Body({
      mass: CAR_MASS,
      position: new CANNON.Vec3(0, 4, 0),
      shape: chassisShape,
      linearDamping: 0.1,
      angularDamping: 0.5,
    });
    physicsWorld.addBody(this.chassisBody);

    // Vehicle
    this.vehicle = new CANNON.RaycastVehicle({
      chassisBody: this.chassisBody,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    });

    // Wheel options
    const wheelOptions = {
      radius: 0.35,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: 30,
      suspensionRestLength: 0.4,
      frictionSlip: 2.5,
      dampingRelaxation: 2.3,
      dampingCompression: 4.4,
      maxSuspensionForce: 100000,
      rollInfluence: 0.1,
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(0, 0, 0),
      maxSuspensionTravel: 0.3,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true,
    };

    const wheelPositions = [
      new CANNON.Vec3(-x / 2, -0.2, z * 0.32),  // front-left
      new CANNON.Vec3(x / 2, -0.2, z * 0.32),   // front-right
      new CANNON.Vec3(-x / 2, -0.2, -z * 0.32), // rear-left
      new CANNON.Vec3(x / 2, -0.2, -z * 0.32),  // rear-right
    ];

    for (const pos of wheelPositions) {
      const opts = { ...wheelOptions };
      opts.chassisConnectionPointLocal = pos;
      this.vehicle.addWheel(opts);
    }

    this.vehicle.addToWorld(physicsWorld);

    // Create wheel bodies for visualization
    this.wheelBodies = [];
    for (const wheel of this.vehicle.wheelInfos) {
      const wheelBody = new CANNON.Body({
        mass: 0,
        type: CANNON.Body.KINEMATIC,
        collisionFilterGroup: 0, // Don't collide with anything
      });
      physicsWorld.addBody(wheelBody);
      this.wheelBodies.push(wheelBody);
    }

    // Current steering angle
    this.currentSteer = 0;
  }

  /**
   * Update car physics and visuals
   * @param {import('../core/InputManager.js').InputManager} input
   * @param {number} delta
   */
  update(input, delta) {
    // Engine force
    let engineForce = 0;
    if (input.forward) {
      engineForce = -CAR_MAX_FORCE;
    } else if (input.backward) {
      engineForce = CAR_MAX_FORCE * 0.6;
    }

    // Braking
    let brakeForce = 0;
    if (input.handbrake) {
      brakeForce = CAR_MAX_BRAKE;
    } else if (!input.forward && !input.backward) {
      brakeForce = 5; // Natural deceleration
    }

    // Steering
    let targetSteer = 0;
    if (input.left) targetSteer = -CAR_MAX_STEER;
    if (input.right) targetSteer = CAR_MAX_STEER;

    // Smooth steering
    this.currentSteer += (targetSteer - this.currentSteer) * 0.15;

    // Apply to front wheels (indices 0, 1)
    this.vehicle.applyEngineForce(engineForce, 2); // rear-left
    this.vehicle.applyEngineForce(engineForce, 3); // rear-right

    this.vehicle.setBrake(brakeForce, 0);
    this.vehicle.setBrake(brakeForce, 1);
    this.vehicle.setBrake(brakeForce * 1.5, 2); // handbrake affects rear more
    this.vehicle.setBrake(brakeForce * 1.5, 3);

    this.vehicle.setSteeringValue(this.currentSteer, 0); // front-left
    this.vehicle.setSteeringValue(this.currentSteer, 1); // front-right

    // Calculate speed in km/h
    const vel = this.chassisBody.velocity;
    this.speed = Math.sqrt(vel.x ** 2 + vel.z ** 2) * 3.6;

    // Reset car if upside down
    if (input.reset) {
      this._resetCar();
    }

    // Sync visual model to physics
    this._syncVisuals();
  }

  _syncVisuals() {
    // Chassis
    const pos = this.chassisBody.position;
    const quat = this.chassisBody.quaternion;

    this.carModel.group.position.set(pos.x, pos.y, pos.z);
    this.carModel.group.quaternion.set(quat.x, quat.y, quat.z, quat.w);

    // Wheels
    const wheelTransforms = [];
    for (let i = 0; i < this.vehicle.wheelInfos.length; i++) {
      this.vehicle.updateWheelTransform(i);
      const t = this.vehicle.wheelInfos[i].worldTransform;

      // Convert to local space (relative to chassis)
      const wheelWorldPos = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
      const chassisWorldPos = new THREE.Vector3(pos.x, pos.y, pos.z);
      const chassisQuat = new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w);
      const chassisQuatInv = chassisQuat.clone().invert();

      const localPos = wheelWorldPos.sub(chassisWorldPos).applyQuaternion(chassisQuatInv);

      const wheelQuat = new THREE.Quaternion(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);
      const localQuat = chassisQuatInv.clone().multiply(wheelQuat);

      wheelTransforms.push({
        position: localPos,
        quaternion: localQuat,
      });
    }

    this.carModel.updateWheels(wheelTransforms);
  }

  _resetCar() {
    const pos = this.chassisBody.position;
    this.chassisBody.position.set(pos.x, pos.y + 3, pos.z);
    this.chassisBody.quaternion.set(0, 0, 0, 1);
    this.chassisBody.velocity.set(0, 0, 0);
    this.chassisBody.angularVelocity.set(0, 0, 0);
  }

  /**
   * Set car spawn position and orientation on road
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} heading - rotation in radians
   */
  setSpawnPosition(x, y, z, heading = 0) {
    this.chassisBody.position.set(x, y, z);
    this.chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), heading);
    this.chassisBody.velocity.set(0, 0, 0);
    this.chassisBody.angularVelocity.set(0, 0, 0);
    this._syncVisuals();
  }

  /**
   * Get car world position
   * @returns {{ x: number, y: number, z: number }}
   */
  getPosition() {
    const p = this.chassisBody.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  /**
   * Get car forward direction
   * @returns {THREE.Vector3}
   */
  getForwardDirection() {
    const q = this.chassisBody.quaternion;
    const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    const forward = new THREE.Vector3(0, 0, 1);
    forward.applyQuaternion(quat);
    return forward;
  }

  /**
   * Get the car yaw for HUD/minimap rotation.
   * @returns {number} heading in radians
   */
  getHeading() {
    const { x, y, z, w } = this.chassisBody.quaternion;
    return Math.atan2(
      2 * (w * y + x * z),
      1 - 2 * (y * y + z * z)
    );
  }

  dispose() {
    this.vehicle.removeFromWorld(this.physicsWorld);
    this.physicsWorld.removeBody(this.chassisBody);
    for (const wb of this.wheelBodies) {
      this.physicsWorld.removeBody(wb);
    }
  }
}
