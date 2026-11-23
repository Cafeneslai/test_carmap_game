/**
 * PostFX.js — screen-space ambient occlusion (n8ao) so buildings sit on the ground: soft shadow
 * where walls meet the street, in courtyards, under eaves and trees.
 *
 * Rendering into a target skips three's tone mapping, so a last pass applies the same ACES curve
 * the plain renderer used, except on the sky (depth = far plane), which is tuned to be shown
 * without tone mapping (see DayNight.js). SMAA replaces the hardware anti-aliasing that a render
 * target does not have.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { N8AOPass } from 'n8ao';

const ToneMapShader = {
  uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, exposure: { value: 1 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float exposure;
    varying vec2 vUv;
    // three.js ACESFilmicToneMapping
    vec3 RRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 aces(vec3 color) {
      const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      color *= exposure / 0.6;
      color = ACESOutputMat * RRTAndODTFit(ACESInputMat * color);
      return clamp(color, 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c) {
      return mix(pow(c, vec3(0.41666)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
    }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      bool sky = texture2D(tDepth, vUv).r >= 0.99999;
      gl_FragColor = vec4(toSRGB(sky ? clamp(c.rgb, 0.0, 1.0) : aces(c.rgb)), 1.0);
    }`,
};

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.enabled = true;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.ao = new N8AOPass(scene, camera, size.x, size.y);
    Object.assign(this.ao.configuration, {
      aoRadius: 4,           // metres: a street-corner sized shadow
      distanceFalloff: 1,
      intensity: 3.5,
      gammaCorrection: false, // the tone-map pass below converts to sRGB once
      halfRes: true,          // cheap enough for laptops
    });
    this.ao.setQualityMode('Medium');
    this.toneMap = new ShaderPass(ToneMapShader);
    this.smaa = new SMAAPass(size.x, size.y);
    this.composer.addPass(this.ao);
    this.composer.addPass(this.toneMap);
    this.composer.addPass(this.smaa);
  }

  render(scene, camera) {
    if (!this.enabled) {
      this.renderer.render(scene, camera);
      return;
    }
    this.ao.scene = scene;
    this.ao.camera = camera;
    this.toneMap.uniforms.tDepth.value = this.ao.beautyRenderTarget.depthTexture;
    this.toneMap.uniforms.exposure.value = this.renderer.toneMappingExposure;
    this.composer.render();
  }

  setSize(w, h) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }
}
