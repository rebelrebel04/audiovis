import {
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * ProgressiveBloomPass
 *
 * Cascading separable Gaussian bloom. Each iteration runs an H + V
 * 9-tap Gaussian blur at stride `(1 << i) * radius` texels — 1, 2, 4, 8
 * by default. Each iteration's output feeds the next iteration's input,
 * so the spread accumulates geometrically without enlarging the kernel
 * (which would cause ringing).
 *
 * Ported from the Quine "Manifold" VST's PhasePortrait recipe. Compared
 * to UnrealBloomPass's mip-pyramid downsample/upsample bloom, this
 * produces a tighter halo with a crisper inner edge — the "neon sign"
 * character — instead of UnrealBloom's softer, more cinematic feel.
 *
 * Interface mirrors UnrealBloomPass for drop-in replaceability:
 *   strength   - bloom intensity multiplier in the final composite
 *   radius     - stride scale; radius=1 → strides 1,2,4,8 (Manifold-
 *                equivalent). Larger widens the halo.
 *   threshold  - input pixels with max-channel below this are gated to
 *                zero before blurring, so only bright cores bloom.
 *
 * Render targets are HalfFloat to preserve HDR content (>1.0) coming
 * out of the lightPainting ribbon shader.
 */

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Pre-filter: gate input pixels by max-channel luminance against
// `threshold`. Only pixels above the gate contribute to the bloom; the
// scene itself is preserved unaltered for the final composite.
const PRE_FILTER_FRAG = /* glsl */ `
  uniform sampler2D srcTex;
  uniform float threshold;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(srcTex, vUv);
    float lum = max(c.r, max(c.g, c.b));
    float gate = step(threshold, lum);
    gl_FragColor = c * gate;
  }
`;

// 9-tap Gaussian, sigma~3 — same weights as Manifold's PhasePortrait.
// `texelStep` controls the sample stride (and thus direction): set
// (stride/w, 0) for horizontal, (0, stride/h) for vertical.
const BLUR_FRAG = /* glsl */ `
  uniform sampler2D srcTex;
  uniform vec2 texelStep;
  varying vec2 vUv;
  const float w0 = 0.227027;
  const float w1 = 0.194595;
  const float w2 = 0.121622;
  const float w3 = 0.054054;
  const float w4 = 0.016216;
  void main() {
    vec4 c = texture2D(srcTex, vUv) * w0;
    c += texture2D(srcTex, vUv + texelStep * 1.0) * w1;
    c += texture2D(srcTex, vUv - texelStep * 1.0) * w1;
    c += texture2D(srcTex, vUv + texelStep * 2.0) * w2;
    c += texture2D(srcTex, vUv - texelStep * 2.0) * w2;
    c += texture2D(srcTex, vUv + texelStep * 3.0) * w3;
    c += texture2D(srcTex, vUv - texelStep * 3.0) * w3;
    c += texture2D(srcTex, vUv + texelStep * 4.0) * w4;
    c += texture2D(srcTex, vUv - texelStep * 4.0) * w4;
    gl_FragColor = c;
  }
`;

// Final composite: scene + bloom * strength. Alpha pulled from scene so
// the OutputPass downstream sees a well-defined alpha channel.
const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D sceneTex;
  uniform sampler2D bloomTex;
  uniform float strength;
  varying vec2 vUv;
  void main() {
    vec4 scene = texture2D(sceneTex, vUv);
    vec4 bloom = texture2D(bloomTex, vUv);
    gl_FragColor = vec4(scene.rgb + bloom.rgb * strength, scene.a);
  }
`;

export class ProgressiveBloomPass extends Pass {
  constructor({ strength = 2.0, radius = 1.0, threshold = 0.0, iterations = 4 } = {}) {
    super();
    this.strength = strength;
    this.radius = radius;
    this.threshold = threshold;
    this.iterations = iterations;

    const rtOpts = {
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      type: HalfFloatType,
      format: RGBAFormat,
    };
    // rtPre: thresholded copy of input (bloom source)
    // rtA / rtB: ping-pong for H/V blur cascade
    this.rtPre = new WebGLRenderTarget(1, 1, rtOpts);
    this.rtA   = new WebGLRenderTarget(1, 1, rtOpts);
    this.rtB   = new WebGLRenderTarget(1, 1, rtOpts);

    this.preFilterMat = new ShaderMaterial({
      uniforms: {
        srcTex: { value: null },
        threshold: { value: threshold },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: PRE_FILTER_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new ShaderMaterial({
      uniforms: {
        srcTex: { value: null },
        texelStep: { value: new Vector2() },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMat = new ShaderMaterial({
      uniforms: {
        sceneTex: { value: null },
        bloomTex: { value: null },
        strength: { value: strength },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.preQuad = new FullScreenQuad(this.preFilterMat);
    this.blurQuad = new FullScreenQuad(this.blurMat);
    this.compositeQuad = new FullScreenQuad(this.compositeMat);

    this._size = new Vector2(1, 1);
  }

  setSize(width, height) {
    this.rtPre.setSize(width, height);
    this.rtA.setSize(width, height);
    this.rtB.setSize(width, height);
    this._size.set(width, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    const w = this._size.x;
    const h = this._size.y;

    // 0. Pre-filter: gate by threshold so only bright cores bloom.
    this.preFilterMat.uniforms.srcTex.value = readBuffer.texture;
    this.preFilterMat.uniforms.threshold.value = this.threshold;
    renderer.setRenderTarget(this.rtPre);
    this.preQuad.render(renderer);

    // 1. Cascading blur: H+V at stride 1, 2, 4, 8 (× radius). Each
    //    iteration takes the previous iteration's V output as its input,
    //    so spreads accumulate. The 9-tap kernel stays tight (sigma~3),
    //    but the stride doubling lifts each iteration to a wider effective
    //    sigma without enlarging the kernel itself.
    let read = this.rtPre;
    for (let i = 0; i < this.iterations; i++) {
      const stride = (1 << i) * this.radius;

      // H pass: read → rtA
      this.blurMat.uniforms.srcTex.value = read.texture;
      this.blurMat.uniforms.texelStep.value.set(stride / w, 0);
      renderer.setRenderTarget(this.rtA);
      this.blurQuad.render(renderer);

      // V pass: rtA → rtB
      this.blurMat.uniforms.srcTex.value = this.rtA.texture;
      this.blurMat.uniforms.texelStep.value.set(0, stride / h);
      renderer.setRenderTarget(this.rtB);
      this.blurQuad.render(renderer);

      read = this.rtB;
    }

    // 2. Composite: scene + bloom * strength → writeBuffer (or screen).
    this.compositeMat.uniforms.sceneTex.value = readBuffer.texture;
    this.compositeMat.uniforms.bloomTex.value = this.rtB.texture;
    this.compositeMat.uniforms.strength.value = this.strength;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.compositeQuad.render(renderer);
  }

  dispose() {
    this.rtPre.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.preFilterMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.preQuad.dispose();
    this.blurQuad.dispose();
    this.compositeQuad.dispose();
  }
}
