import {
  HalfFloatType,
  LinearFilter,
  MeshBasicMaterial,
  ShaderMaterial,
  UniformsUtils,
  WebGLRenderTarget,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * RadialTrailsPass
 *
 * Screen-space feedback pass that leaves persistent trails from previous
 * frames while also pulling the feedback outward from the canvas center.
 * The result is the "streaming outward toward the viewer" look — motion
 * trails that appear to expand off the edges of the frame.
 *
 * Based on three's stock AfterimagePass (same ping-pong render-target
 * strategy and `max(oldTrail, newFrame)` blend), with one addition: the
 * fragment shader samples `tOld` at a UV slightly pulled toward center,
 * which makes the previous frame's content appear larger (drifted
 * outward) in the current frame.
 *
 *   persistence (damp):  0 = no trails; 0.99 = very long trails
 *   radialPush:          0 = static trails; ~0.01 = strong outward drift
 *
 * With persistence=0 the pass becomes a pass-through (old texel * 0 = 0,
 * output = new frame), so it's cheap to leave always-enabled.
 *
 * Placed before bloom in the composer chain so trails inherit the glow.
 */

const RadialTrailsShader = {
  uniforms: {
    damp:       { value: 0.0 },
    radialPush: { value: 0.0 },
    tOld:       { value: null },
    tNew:       { value: null },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */`
    uniform float damp;
    uniform float radialPush;
    uniform sampler2D tOld;
    uniform sampler2D tNew;

    varying vec2 vUv;

    // AfterimagePass's threshold trick — zero out very dim pixels so
    // noise / bloom residue doesn't accumulate over time into a hazy fog.
    vec4 whenGt(vec4 x, float y) {
      return max(sign(x - y), 0.0);
    }

    void main() {
      // Sample the previous frame at a UV pulled toward center. Content
      // at (center + offset) in the old frame now appears at (center +
      // offset / (1 - radialPush)) in this frame — i.e. farther from
      // center. That's the "streaming outward" illusion.
      vec2 centered = vUv - 0.5;
      vec2 feedbackUv = 0.5 + centered * (1.0 - radialPush);

      vec4 texelOld = texture2D(tOld, feedbackUv);
      vec4 texelNew = texture2D(tNew, vUv);

      texelOld *= damp * whenGt(texelOld, 0.1);

      gl_FragColor = max(texelNew, texelOld);
    }
  `,
};

export class RadialTrailsPass extends Pass {
  constructor({ damp = 0.0, radialPush = 0.0 } = {}) {
    super();

    this.shader = RadialTrailsShader;
    this.uniforms = UniformsUtils.clone(this.shader.uniforms);
    this.uniforms.damp.value = damp;
    this.uniforms.radialPush.value = radialPush;

    // LinearFilter (not Nearest like AfterimagePass) so the scaled
    // feedback sample interpolates smoothly — otherwise the radial drift
    // produces visible stair-stepping at low push values.
    const rtOptions = { magFilter: LinearFilter, minFilter: LinearFilter, type: HalfFloatType };
    this.textureComp = new WebGLRenderTarget(window.innerWidth, window.innerHeight, rtOptions);
    this.textureOld  = new WebGLRenderTarget(window.innerWidth, window.innerHeight, rtOptions);

    this.compFsMaterial = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: this.shader.vertexShader,
      fragmentShader: this.shader.fragmentShader,
    });
    this.compFsQuad = new FullScreenQuad(this.compFsMaterial);

    this.copyFsMaterial = new MeshBasicMaterial();
    this.copyFsQuad = new FullScreenQuad(this.copyFsMaterial);
  }

  render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
    this.uniforms.tOld.value = this.textureOld.texture;
    this.uniforms.tNew.value = readBuffer.texture;

    // 1. Composite (old feedback + new frame) into textureComp
    renderer.setRenderTarget(this.textureComp);
    this.compFsQuad.render(renderer);

    // 2. Output the composite
    this.copyFsQuad.material.map = this.textureComp.texture;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.copyFsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      this.copyFsQuad.render(renderer);
    }

    // 3. Swap buffers (pointer swap, no copy). After this, textureOld
    //    holds the frame we just rendered — ready as feedback next frame.
    const tmp = this.textureOld;
    this.textureOld = this.textureComp;
    this.textureComp = tmp;
  }

  setSize(width, height) {
    this.textureComp.setSize(width, height);
    this.textureOld.setSize(width, height);
  }

  dispose() {
    this.textureComp.dispose();
    this.textureOld.dispose();
    this.compFsMaterial.dispose();
    this.copyFsMaterial.dispose();
    this.compFsQuad.dispose();
    this.copyFsQuad.dispose();
  }
}
