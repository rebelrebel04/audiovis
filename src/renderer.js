import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RadialTrailsPass } from './RadialTrailsPass.js';
import { ProgressiveBloomPass } from './ProgressiveBloomPass.js';

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

    // HDR pipeline: shaders that output values >1.0 (notably the light-
    // painting ribbon's hdrPeak-multiplied core) need a HalfFloat backing
    // store so those values aren't clipped before they reach bloom. The
    // OutputPass at the end of the chain runs whatever tone mapping the
    // renderer is configured for — ACESFilmic gives a soft warm rolloff
    // for blown-out values rather than the hard cyan-tinged clip you get
    // with no tone mapping. Exposure 1.0 keeps midrange close to the
    // pre-HDR look so existing primitives don't visibly shift.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

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
    //
    // Composer's read/write targets are HalfFloat so HDR (>1.0) shader
    // outputs propagate through the chain without clipping. The bloom
    // pass picks up the bright cores; OutputPass tone-maps back to LDR
    // for display.
    const hdrTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.composer = new EffectComposer(this.renderer, hdrTarget);
    this.composer.setSize(width, height);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.trailsPass = new RadialTrailsPass({ damp: 0.0, radialPush: 0.0 });
    this.composer.addPass(this.trailsPass);

    // Progressive-stride Gaussian bloom (Manifold-style). Tighter, more
    // "neon sign" character than UnrealBloomPass. Same {strength, radius,
    // threshold} interface so existing presets and the GUI bloom folder
    // work unchanged — only the visual character changes.
    //   strength  - bloom multiplier in the final composite
    //   radius    - stride scale; 1.0 = strides 1,2,4,8 (Manifold default)
    //   threshold - max-channel gate; 0 = everything blooms
    this.bloomPass = new ProgressiveBloomPass({
      strength: 2.0,
      radius: 1.0,
      threshold: 0.0,
    });
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
