/**
 * CarModel.js — Procedurally generated 3D car mesh
 */

import * as THREE from 'three';
import { CAR_DIMENSIONS } from '../config.js';

export class CarModel {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();

    // Everything except the wheels. Lowered so the underside sits just above the wheel hubs;
    // the physics chassis origin is the car's centre of mass, not the middle of the bodywork.
    this.shell = new THREE.Group();
    this.shell.position.y = -0.25;
    this.group.add(this.shell);

    this._buildBody();
    this._buildWindshield();
    this._buildWheels();
    this._buildLights();

    this.group.position.set(0, 2, 0);
    scene.add(this.group);
  }

  _buildBody() {
    const { x, y, z } = CAR_DIMENSIONS;

    // Main body (lower)
    const bodyGeom = new THREE.BoxGeometry(x, y * 0.5, z);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xcc2233,
      roughness: 0.3,
      metalness: 0.6,
    });
    this.body = new THREE.Mesh(bodyGeom, bodyMat);
    this.body.position.y = y * 0.25;
    this.body.castShadow = true;
    this.shell.add(this.body);

    // Cabin (upper)
    const cabinGeom = new THREE.BoxGeometry(x * 0.85, y * 0.4, z * 0.55);
    const cabinMat = new THREE.MeshStandardMaterial({
      color: 0xaa1a2a,
      roughness: 0.3,
      metalness: 0.5,
    });
    this.cabin = new THREE.Mesh(cabinGeom, cabinMat);
    this.cabin.position.set(0, y * 0.7, -z * 0.05);
    this.cabin.castShadow = true;
    this.shell.add(this.cabin);
  }

  _buildWindshield() {
    const { x, y, z } = CAR_DIMENSIONS;

    // Front windshield
    const windshieldGeom = new THREE.BoxGeometry(x * 0.8, y * 0.35, 0.05);
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x88bbdd,
      roughness: 0.1,
      metalness: 0.8,
      transparent: true,
      opacity: 0.6,
    });

    const frontGlass = new THREE.Mesh(windshieldGeom, glassMat);
    frontGlass.position.set(0, y * 0.72, z * 0.21);
    frontGlass.rotation.x = 0.2;
    this.shell.add(frontGlass);

    // Rear windshield
    const rearGlass = new THREE.Mesh(windshieldGeom, glassMat);
    rearGlass.position.set(0, y * 0.72, -z * 0.3);
    rearGlass.rotation.x = -0.2;
    this.shell.add(rearGlass);

    // Side windows
    const sideGeom = new THREE.BoxGeometry(0.05, y * 0.3, z * 0.4);
    const leftWindow = new THREE.Mesh(sideGeom, glassMat);
    leftWindow.position.set(-x * 0.43, y * 0.7, -z * 0.05);
    this.shell.add(leftWindow);

    const rightWindow = new THREE.Mesh(sideGeom, glassMat);
    rightWindow.position.set(x * 0.43, y * 0.7, -z * 0.05);
    this.shell.add(rightWindow);
  }

  _buildWheels() {
    const { x, y, z } = CAR_DIMENSIONS;
    const wheelRadius = 0.35;
    const wheelWidth = 0.25;

    const wheelGeom = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 16);
    wheelGeom.rotateZ(Math.PI / 2);

    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0x222222,
      roughness: 0.6,
      metalness: 0.3,
    });

    // Hub cap
    const hubGeom = new THREE.CylinderGeometry(wheelRadius * 0.5, wheelRadius * 0.5, wheelWidth + 0.02, 8);
    hubGeom.rotateZ(Math.PI / 2);
    const hubMat = new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 0.2,
      metalness: 0.8,
    });

    this.wheels = [];

    const positions = [
      { x: -x / 2 - wheelWidth / 2, y: 0, z: z * 0.32 },  // front-left
      { x: x / 2 + wheelWidth / 2, y: 0, z: z * 0.32 },   // front-right
      { x: -x / 2 - wheelWidth / 2, y: 0, z: -z * 0.32 }, // rear-left
      { x: x / 2 + wheelWidth / 2, y: 0, z: -z * 0.32 },  // rear-right
    ];

    for (const pos of positions) {
      const wheelGroup = new THREE.Group();

      const wheel = new THREE.Mesh(wheelGeom, wheelMat);
      wheel.castShadow = true;
      wheelGroup.add(wheel);

      const hub = new THREE.Mesh(hubGeom, hubMat);
      wheelGroup.add(hub);

      wheelGroup.position.set(pos.x, pos.y, pos.z);
      this.wheels.push(wheelGroup);
      this.group.add(wheelGroup);
    }
  }

  _buildLights() {
    const { x, y, z } = CAR_DIMENSIONS;

    // Headlights
    const headlightGeom = new THREE.SphereGeometry(0.12, 8, 8);
    const headlightMat = new THREE.MeshStandardMaterial({
      color: 0xffffcc,
      emissive: 0xffffaa,
      emissiveIntensity: 0.8,
      roughness: 0.1,
    });

    const hl1 = new THREE.Mesh(headlightGeom, headlightMat);
    hl1.position.set(-x * 0.35, y * 0.25, z * 0.5);
    this.shell.add(hl1);

    const hl2 = new THREE.Mesh(headlightGeom, headlightMat);
    hl2.position.set(x * 0.35, y * 0.25, z * 0.5);
    this.shell.add(hl2);

    // Taillights
    const taillightGeom = new THREE.BoxGeometry(0.2, 0.1, 0.05);
    const taillightMat = new THREE.MeshStandardMaterial({
      color: 0xff2200,
      emissive: 0xff0000,
      emissiveIntensity: 0.5,
      roughness: 0.2,
    });

    const tl1 = new THREE.Mesh(taillightGeom, taillightMat);
    tl1.position.set(-x * 0.35, y * 0.25, -z * 0.5);
    this.shell.add(tl1);

    const tl2 = new THREE.Mesh(taillightGeom, taillightMat);
    tl2.position.set(x * 0.35, y * 0.25, -z * 0.5);
    this.shell.add(tl2);
  }

  /**
   * Update wheel visuals from physics data
   * @param {{ position: THREE.Vector3, quaternion: THREE.Quaternion }[]} wheelTransforms
   */
  updateWheels(wheelTransforms) {
    for (let i = 0; i < Math.min(this.wheels.length, wheelTransforms.length); i++) {
      const { position, quaternion } = wheelTransforms[i];
      this.wheels[i].position.copy(position);
      this.wheels[i].quaternion.copy(quaternion);
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });
  }
}
