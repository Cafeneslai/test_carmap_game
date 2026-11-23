/**
 * Game.js — Main game loop & state management
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GAME_STATES, CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR, PHYSICS_STEP } from '../config.js';
import { InputManager } from './InputManager.js';
import { ChunkManager } from '../world/ChunkManager.js';
import { CarController } from '../vehicle/CarController.js';
import { CarModel } from '../vehicle/CarModel.js';
import { CameraController } from '../vehicle/CameraController.js';
import { EngineSound } from '../vehicle/EngineSound.js';
import { LocationPicker } from '../ui/LocationPicker.js';
import { LoadingScreen } from '../ui/LoadingScreen.js';
import { HUD } from '../ui/HUD.js';
import { SettingsPanel } from '../ui/SettingsPanel.js';
import { metersToLatLng } from '../data/GeoUtils.js';
import { preloadRegion, findSpawnPoint, clearRegion } from '../data/OSMFetcher.js';

export class Game {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.state = GAME_STATES.LOCATION_SELECT;

    /** @type {{ lat: number, lng: number, name: string } | null} */
    this.selectedLocation = null;

    // ---- Three.js ----
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // sky blue
    this.scene.fog = new THREE.Fog(0x87ceeb, 200, 700);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      CAMERA_NEAR,
      CAMERA_FAR
    );
    this.camera.position.set(0, 20, -30);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    // ---- Lighting ----
    this._setupLighting();

    // ---- Physics ----
    this.physicsWorld = new CANNON.World({
      gravity: new CANNON.Vec3(0, -9.82, 0),
    });
    this.physicsWorld.broadphase = new CANNON.SAPBroadphase(this.physicsWorld);
    this.physicsWorld.defaultContactMaterial.friction = 0.3;
    this.physicsWorld.defaultContactMaterial.restitution = 0.1;

    // ---- Modules ----
    this.input = new InputManager();
    this.input.bindTouchButtons(document);
    this.engineSound = new EngineSound();
    this.chunkManager = null;  // initialized after location selected
    this.carController = null;
    this.carModel = null;
    this.cameraController = null;

    // ---- UI ----
    this.locationPicker = new LocationPicker(this);
    this.loadingScreen = new LoadingScreen();
    this.hud = new HUD();
    this.settingsPanel = new SettingsPanel(this);

    // ---- Clock ----
    this.clock = new THREE.Clock();
    this.fpsFrames = 0;
    this.fpsTime = 0;
    this.currentFps = 0;

    // ---- Events ----
    window.addEventListener('resize', () => this._onResize());

    // ---- Start ----
    this._loop();
  }

  _setupLighting() {
    // Ambient
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambient);

    // Hemisphere
    const hemi = new THREE.HemisphereLight(0x87ceeb, 0x556633, 0.6);
    this.scene.add(hemi);

    // Directional (sun)
    this.sunLight = new THREE.DirectionalLight(0xfff4e6, 1.2);
    this.sunLight.position.set(100, 150, 100);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -100;
    this.sunLight.shadow.camera.right = 100;
    this.sunLight.shadow.camera.top = 100;
    this.sunLight.shadow.camera.bottom = -100;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 400;
    this.sunLight.shadow.bias = -0.001;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
  }

  // ---- Public methods called by UI ----

  /**
   * Called when user selects a location and clicks Start
   * @param {{ lat: number, lng: number, name: string }} location
   */
  async startGame(location) {
    this.selectedLocation = location;
    this.state = GAME_STATES.LOADING;
    this.engineSound.start(); // still inside the Start click, so the browser allows audio

    // Show loading screen
    this.loadingScreen.show();
    this.loadingScreen.setText('กำลังเตรียมระบบ...');
    this.loadingScreen.setProgress(5);

    try {
      // 1. Preload regional OSM map (roads, buildings, greenery in 600m radius in 1 fast query)
      this.loadingScreen.setText('กำลังดาวน์โหลดข้อมูลถนนและอาคาร...');
      this.loadingScreen.setProgress(10);
      await preloadRegion(location.lat, location.lng, 600);

      // 2. Setup chunk manager
      this.loadingScreen.setText('กำลังเริ่มต้นระบบ Chunk...');
      this.loadingScreen.setProgress(20);
      this.chunkManager = new ChunkManager(this.scene, this.physicsWorld, location.lat, location.lng);
      this.settingsPanel.applyTo(this.chunkManager);

      // 3. Setup car
      this.loadingScreen.setText('กำลังสร้างรถ...');
      this.loadingScreen.setProgress(30);
      this.carModel = new CarModel(this.scene);
      this.carController = new CarController(this.physicsWorld, this.carModel);

      // 4. Setup camera
      this.cameraController = new CameraController(this.camera, this.carController);

      // 5. Load initial chunks (3x3 grid around player)
      this.loadingScreen.setText('กำลังสร้างโลก 3D...');
      this.loadingScreen.setProgress(40);
      await this.chunkManager.loadInitialChunks((progress, text) => {
        this.loadingScreen.setProgress(40 + progress * 50);
        if (text) this.loadingScreen.setText(text);
      });

      // 6. Put the car on the nearest drivable road, pointing along it, resting on the terrain
      const spawn = findSpawnPoint(this.chunkManager.getLoadedRoads(), location.lat, location.lng);
      const sx = spawn?.x ?? 0;
      const sz = spawn?.z ?? 0;
      const ground = this.chunkManager.getTerrainHeight(sx, sz) ?? 0;
      this.carController.setSpawnPosition(sx, ground + 1.5, sz, spawn?.heading ?? 0);
      this.cameraController.reset();

      // 7. Ready!
      this.loadingScreen.setText('พร้อมขับสำรวจ!');
      this.loadingScreen.setProgress(100);

      await new Promise(r => setTimeout(r, 400));

      this.loadingScreen.hide();
      this.hud.show(location.name);
      this.state = GAME_STATES.PLAYING;

    } catch (err) {
      console.error('Failed to start game:', err);
      this.loadingScreen.setText('เกิดข้อผิดพลาด: ' + err.message + ' — กำลังกลับไปหน้าเลือกสถานที่...');
      // Without this the player is stuck on the loading screen with no way out
      await new Promise(r => setTimeout(r, 3000));
      this.loadingScreen.hide();
      this.resetToLocationSelect();
    }
  }

  resetToLocationSelect() {
    // Clean up
    clearRegion();
    if (this.chunkManager) {
      this.chunkManager.dispose();
      this.chunkManager = null;
    }
    if (this.carController) {
      this.carController.dispose();
      this.carController = null;
    }
    if (this.carModel) {
      this.carModel.dispose();
      this.carModel = null;
    }
    this.cameraController = null;

    this.hud.hide();
    this.settingsPanel.hide();
    this.locationPicker.show();
    this.state = GAME_STATES.LOCATION_SELECT;
  }

  // ---- Game Loop ----

  _loop() {
    requestAnimationFrame(() => this._loop());

    this.input.pollGamepad();
    const delta = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();

    // FPS counter
    this.fpsFrames++;
    this.fpsTime += delta;
    if (this.fpsTime >= 0.5) {
      this.currentFps = Math.round(this.fpsFrames / this.fpsTime);
      this.hud.updateFps(this.currentFps);
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }

    if (this.state === GAME_STATES.PLAYING) {
      // Settings toggle
      if (this.input.toggleSettings) {
        if (this.settingsPanel.visible) {
          this.settingsPanel.hide();
          this.state = GAME_STATES.PLAYING;
        } else {
          this.settingsPanel.show();
          this.state = GAME_STATES.PAUSED;
        }
      }

      this._updatePlaying(delta, elapsed);
    } else if (this.state === GAME_STATES.PAUSED) {
      if (this.input.toggleSettings) {
        this.settingsPanel.hide();
        this.state = GAME_STATES.PLAYING;
      }
    }

    this.engineSound.update(
      this.carController?.speed ?? 0,
      this.input.forward || this.input.backward,
      this.state === GAME_STATES.PLAYING && !!this.carController
    );

    this.input.update();
    this.renderer.render(this.scene, this.camera);
  }

  _updatePlaying(delta, elapsed) {
    // A long frame (tab in background, GC pause) must not become one giant physics step
    delta = Math.min(delta, 0.1);
    this.physicsWorld.step(PHYSICS_STEP, delta, 3);

    // Car
    if (this.carController) {
      this.carController.update(this.input, delta);
      this.hud.updateSpeed(this.carController.speed);
    }

    // Camera
    if (this.cameraController) {
      this.cameraController.update(delta, this.input);
    }

    // Chunks — stream world around car
    if (this.chunkManager && this.carController) {
      const pos = this.carController.getPosition();
      this.chunkManager.update(pos);

      // Move sun with car
      this.sunLight.position.set(pos.x + 100, 150, pos.z + 100);
      this.sunLight.target.position.set(pos.x, 0, pos.z);

      // Update Minimap
      const { lat, lng } = metersToLatLng(
        pos.x,
        pos.z,
        this.chunkManager.worldBuilder.originLat,
        this.chunkManager.worldBuilder.originLng
      );
      this.hud.updateMinimap(lat, lng, this.carController.getHeading());
    }
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
