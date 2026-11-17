/**
 * CarController.js — Physics-based car control using Cannon-es RaycastVehicle
 *
 * Conventions (they matter, the car looks wrong if any of them is flipped):
 *  - The car's nose points along local +Z. Heading 0 faces +Z (south); north is -Z.
 *  - cannon-es drives toward local +Z when engineForce is NEGATIVE for this wheel axle setup.
 *  - A POSITIVE steering value turns the nose toward +X, which is a left turn for a car facing +Z.
 */

import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import {
  CAR_MASS, CAR_MAX_FORCE, CAR_MAX_BRAKE, CAR_MAX_STEER,
  CAR_MAX_SPEED_KMH, CAR_MAX_REVERSE_KMH, CAR_DIMENSIONS,
} from '../config.js';

const WHEEL_RADIUS = 0.35;
/** Where the suspension is attached, relative to the centre of mass */
const CONNECTION_Y = -0.1;
const SUSPENSION_REST_LENGTH = 0.35;

const COAST_BRAKE = 1.5;         // gentle engine braking when no pedal is pressed
const HANDBRAKE = 30;            // rear wheels only
const REAR_GRIP = 2.5;
const REAR_GRIP_HANDBRAKE = 1.8; // lets the tail slide without spinning out
const STOPPED_EPS = 1;           // m/s: below this S means reverse instead of brake
const DOWNFORCE = 2.2;           // N per (m/s)^2, keeps the car planted at speed
const FLIPPED_RESET_SECONDS = 2;
const FALL_DISTANCE = 60;        // metres below the last safe spot before we put the car back
const WHEELBASE = CAR_DIMENSIONS.z * 0.64;
const MAX_LATERAL_ACCEL = 14;    // m/s^2 the tyres can hold; limits steering angle at speed
const MIN_STEER = 0.06;          // radians, so the car still answers at top speed

export class CarController {
  /**
   * @param {CANNON.World} physicsWorld
   * @param {import('./CarModel.js').CarModel} carModel
   */
  constructor(physicsWorld, carModel) {
    this.physicsWorld = physicsWorld;
    this.carModel = carModel;
    this.speed = 0;        // km/h, horizontal, always >= 0
    this.forwardSpeed = 0; // m/s, positive when rolling forwards

    const { x, z } = CAR_DIMENSIONS;

    // The collision box is short and sits ABOVE the wheel hubs, so the bodywork can never
    // drag on the ground while the wheels (raycasts) carry the car.
    this.chassisBody = new CANNON.Body({
      mass: CAR_MASS,
      position: new CANNON.Vec3(0, 4, 0),
      linearDamping: 0.05,
      angularDamping: 0.4,
    });
    this.chassisBody.addShape(
      new CANNON.Box(new CANNON.Vec3(x / 2 * 0.95, 0.3, z / 2 * 0.9)),
      new CANNON.Vec3(0, 0.1, 0)
    );
    physicsWorld.addBody(this.chassisBody);

    this.vehicle = new CANNON.RaycastVehicle({
      chassisBody: this.chassisBody,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    });

    const wheelOptions = {
      radius: WHEEL_RADIUS,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: 35,
      suspensionRestLength: SUSPENSION_REST_LENGTH,
      frictionSlip: REAR_GRIP,
      dampingRelaxation: 2.3,
      dampingCompression: 4.4,
      maxSuspensionForce: 100000,
      rollInfluence: 0.01,
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(0, 0, 0),
      maxSuspensionTravel: 0.3,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true,
    };

    // 0 front-left, 1 front-right, 2 rear-left, 3 rear-right
    const wheelPositions = [
      new CANNON.Vec3(-x / 2, CONNECTION_Y, z * 0.32),
      new CANNON.Vec3(x / 2, CONNECTION_Y, z * 0.32),
      new CANNON.Vec3(-x / 2, CONNECTION_Y, -z * 0.32),
      new CANNON.Vec3(x / 2, CONNECTION_Y, -z * 0.32),
    ];
    for (const pos of wheelPositions) {
      this.vehicle.addWheel({ ...wheelOptions, chassisConnectionPointLocal: pos });
    }
    this.vehicle.addToWorld(physicsWorld);

    this.currentSteer = 0;
    this._flippedTime = 0;
    this._lastSafe = { x: 0, y: 4, z: 0, heading: 0 };

    // Scratch objects, reused every frame
    this._fwd = new CANNON.Vec3();
    this._up = new CANNON.Vec3();
    this._wheelPos = new THREE.Vector3();
    this._chassisPos = new THREE.Vector3();
    this._chassisQuat = new THREE.Quaternion();
    this._chassisQuatInv = new THREE.Quaternion();
    this._wheelQuat = new THREE.Quaternion();
    this._wheelTransforms = this.vehicle.wheelInfos.map(() => ({
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
    }));
  }

  /**
   * Update car physics inputs and visuals
   * @param {import('../core/InputManager.js').InputManager} input
   * @param {number} delta seconds since the previous frame
   */
  update(input, delta) {
    const body = this.chassisBody;
    body.vectorToWorldFrame(CANNON.Vec3.UNIT_Z, this._fwd);
    body.vectorToWorldFrame(CANNON.Vec3.UNIT_Y, this._up);

    const v = body.velocity;
    this.forwardSpeed = v.x * this._fwd.x + v.y * this._fwd.y + v.z * this._fwd.z;
    this.speed = Math.hypot(v.x, v.z) * 3.6;

    // ---- Pedals ----
    // W/S brake first when the car is rolling the other way, then switch to reverse/drive.
    let throttle = 0; // +1 drive forwards, -1 reverse
    let brake = 0;
    if (input.forward) {
      if (this.forwardSpeed < -STOPPED_EPS) brake = CAR_MAX_BRAKE;
      else throttle = 1;
    } else if (input.backward) {
      if (this.forwardSpeed > STOPPED_EPS) brake = CAR_MAX_BRAKE;
      else throttle = -1;
    } else {
      brake = COAST_BRAKE;
    }

    // Engine power fades out towards the top speed instead of cutting off abruptly
    let power = 0;
    if (throttle > 0) {
      const ratio = Math.max(0, this.forwardSpeed) / (CAR_MAX_SPEED_KMH / 3.6);
      power = Math.max(0, 1 - ratio * ratio);
    } else if (throttle < 0) {
      const ratio = Math.max(0, -this.forwardSpeed) / (CAR_MAX_REVERSE_KMH / 3.6);
      power = 0.6 * Math.max(0, 1 - ratio * ratio);
    }
    const engineForce = -CAR_MAX_FORCE * throttle * power;

    // ---- Steering ----
    // Full lock when crawling, but never more than the tyres can hold at the current speed:
    // lateral acceleration v^2 / r with r = wheelbase / tan(steer) must stay under MAX_LATERAL_ACCEL.
    const v2 = Math.max(this.forwardSpeed * this.forwardSpeed, 1);
    const steerLimit = Math.min(CAR_MAX_STEER, Math.max(MIN_STEER, Math.atan(WHEELBASE * MAX_LATERAL_ACCEL / v2)));
    let steerTarget = 0;
    if (input.left) steerTarget += steerLimit;   // positive = left
    if (input.right) steerTarget -= steerLimit;
    const rate = steerTarget === 0 ? 10 : 6;
    this.currentSteer += (steerTarget - this.currentSteer) * (1 - Math.exp(-rate * delta));

    // ---- Apply to the wheels ----
    const handbrake = input.handbrake;
    for (let i = 0; i < 4; i++) {
      this.vehicle.applyEngineForce(handbrake && i >= 2 ? 0 : engineForce, i); // 4WD
    }
    this.vehicle.setBrake(brake, 0);
    this.vehicle.setBrake(brake, 1);
    this.vehicle.setBrake(handbrake ? HANDBRAKE : brake, 2);
    this.vehicle.setBrake(handbrake ? HANDBRAKE : brake, 3);
    this.vehicle.wheelInfos[2].frictionSlip = handbrake ? REAR_GRIP_HANDBRAKE : REAR_GRIP;
    this.vehicle.wheelInfos[3].frictionSlip = handbrake ? REAR_GRIP_HANDBRAKE : REAR_GRIP;
    this.vehicle.setSteeringValue(this.currentSteer, 0);
    this.vehicle.setSteeringValue(this.currentSteer, 1);

    // Aerodynamic downforce
    const planar = this.speed / 3.6;
    body.force.y -= DOWNFORCE * planar * planar;

    this._recoverIfNeeded(input, delta);
    this._syncVisuals();
  }

  /** Reset key, flipped-over timeout and falling through the world */
  _recoverIfNeeded(input, delta) {
    const body = this.chassisBody;

    const upright = this._up.y > 0.3;
    this._flippedTime = upright ? 0 : this._flippedTime + delta;
    if (input.reset || this._flippedTime > FLIPPED_RESET_SECONDS) {
      this._resetCar();
      return;
    }

    let contacts = 0;
    for (const w of this.vehicle.wheelInfos) if (w.isInContact) contacts++;
    if (contacts >= 3 && this._up.y > 0.7) {
      const p = body.position;
      this._lastSafe = { x: p.x, y: p.y, z: p.z, heading: this.getHeading() };
    } else if (body.position.y < this._lastSafe.y - FALL_DISTANCE) {
      this.setSpawnPosition(this._lastSafe.x, this._lastSafe.y + 2, this._lastSafe.z, this._lastSafe.heading);
    }
  }

  _syncVisuals() {
    const pos = this.chassisBody.position;
    const quat = this.chassisBody.quaternion;

    this.carModel.group.position.set(pos.x, pos.y, pos.z);
    this.carModel.group.quaternion.set(quat.x, quat.y, quat.z, quat.w);

    this._chassisPos.set(pos.x, pos.y, pos.z);
    this._chassisQuat.set(quat.x, quat.y, quat.z, quat.w);
    this._chassisQuatInv.copy(this._chassisQuat).invert();

    for (let i = 0; i < this.vehicle.wheelInfos.length; i++) {
      this.vehicle.updateWheelTransform(i);
      const t = this.vehicle.wheelInfos[i].worldTransform;
      const out = this._wheelTransforms[i];

      // World -> chassis-local, because the wheel meshes are children of the car group
      out.position.set(t.position.x, t.position.y, t.position.z)
        .sub(this._chassisPos)
        .applyQuaternion(this._chassisQuatInv);
      this._wheelQuat.set(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);
      out.quaternion.copy(this._chassisQuatInv).multiply(this._wheelQuat);
    }

    this.carModel.updateWheels(this._wheelTransforms);
  }

  /** Stand the car back up where it is, keeping its heading */
  _resetCar() {
    const p = this.chassisBody.position;
    this.setSpawnPosition(p.x, p.y + 1.5, p.z, this.getHeading());
  }

  /**
   * Place the car and point it along a heading
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} heading yaw in radians about +Y (0 = facing +Z)
   */
  setSpawnPosition(x, y, z, heading = 0) {
    const body = this.chassisBody;
    body.position.set(x, y, z);
    body.quaternion.setFromAxisAngle(CANNON.Vec3.UNIT_Y, heading);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    body.force.set(0, 0, 0);
    body.torque.set(0, 0, 0);
    this.currentSteer = 0;
    this._flippedTime = 0;
    this._lastSafe = { x, y, z, heading };
    body.vectorToWorldFrame(CANNON.Vec3.UNIT_Z, this._fwd);
    body.vectorToWorldFrame(CANNON.Vec3.UNIT_Y, this._up);
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
    return new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  }

  /**
   * Yaw of the nose around +Y in radians (0 = facing +Z, PI/2 = facing +X).
   * Derived from the forward vector, so it stays correct while the car pitches and rolls.
   */
  getHeading() {
    this.chassisBody.vectorToWorldFrame(CANNON.Vec3.UNIT_Z, this._fwd);
    return Math.atan2(this._fwd.x, this._fwd.z);
  }

  dispose() {
    this.vehicle.removeFromWorld(this.physicsWorld);
    this.physicsWorld.removeBody(this.chassisBody);
  }
}
