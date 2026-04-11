import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RadialTrailsPass } from './RadialTrailsPass.js';

/**
 * Renderer
 *
 * Owns the three.js scene, camera, and post-processing chain (bloom).
 * Renders at a fixed 9:16 internal resolution (reel-native) and lets
 * CSS scale the canvas to fit the viewport.
 *
 * The scene uses an orthographic camera so 2D primitives can be expressed
 * in natural unit coordinates (roughly -1..1 on the short axis), while
 * still living in a 3D scene that can grow into particles/meshes later.
 */
export class Renderer {
  constructor(canvas, { width = 1080, height = 1920 } = {}) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true, // needed for MediaRecorder capture
    });
    this.renderer.setPixelRatio(1); // render at exact internal resolution
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(0x000000, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    // Orthographic camera: half-height = 1 unit, so y ∈ [-1, 1].
    // x range is derived from aspect ratio so things aren't squished.
    const aspect = width / height;
    this.camera = new THREE.OrthographicCamera(
      -aspect, aspect, 1, -1, 0.1, 100
    );
    this.camera.position.set(0, 0, 5);
    this.camera.lookAt(0, 0, 0);

    // Post-processing chain: scene → trails (feedback) → bloom → output.
    // Trails live before bloom so their persistent content is bloomed too —
    // that's what turns them into molten glowing streams rather than flat
    // after-image copies. With persistence=0 the trails pass is a cheap
    // pass-through, so it's safe to leave always-enabled.
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(width, height);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.trailsPass = new RadialTrailsPass({ damp: 0.0, radialPush: 0.0 });
    this.composer.addPass(this.trailsPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      1.0,  // strength
      0.8,  // radius
      0.0   // threshold (0 = bloom everything, higher = only bright)
    );
    this.composer.addPass(this.bloomPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
  }

  /** Update bloom params from the UI. */
  setBloom({ strength, radius, threshold }) {
    if (strength !== undefined) this.bloomPass.strength = strength;
    if (radius !== undefined) this.bloomPass.radius = radius;
    if (threshold !== undefined) this.bloomPass.threshold = threshold;
  }

  /** Update trail feedback params (called each frame from main after modulation resolve). */
  setTrails({ persistence, radialPush }) {
    if (persistence !== undefined) this.trailsPass.uniforms.damp.value = persistence;
    if (radialPush !== undefined) this.trailsPass.uniforms.radialPush.value = radialPush;
  }

  render() {
    this.composer.render();
  }
}
