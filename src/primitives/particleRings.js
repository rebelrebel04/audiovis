import * as THREE from 'three';
import { resolve } from '../modulation.js';

/**
 * Particle Rings
 *
 * Concentric rings of additive-blended point sprites with differential
 * rotation — inner rings can spin faster (or slower) than outer rings,
 * producing the hypnotic "gearing" feel of mandala/infinite-mantra visuals.
 *
 * --- Rendering ---
 * Custom ShaderMaterial (no sprite texture) that bakes the radial
 * falloff into the fragment shader via gl_PointCoord. Same Manifold-
 * style technique used in lightPainting:
 *   - Soft radial alpha: pow(1 - d², edgeFalloff)
 *   - HDR core: color * hdrPeak — the centerline (a≈1) goes past 1.0,
 *     and ACES tone mapping rolls those pixels off to white. Result:
 *     each particle has a white-hot core fading into a colored halo.
 *   - Per-particle sparkle: a random `phase` attribute drives a
 *     time-varying brightness multiplier so the field twinkles instead
 *     of looking statically lit. Cheap, dramatic visual lift.
 *   - Inner→outer hue gradient: `hueSpread` rotates the per-particle
 *     hue based on the ringT attribute (0=inner, 1=outer). Zero gives a
 *     single color; positive values produce a chrome/holographic sweep.
 *   - Beat wave: on each beat fire from the global bus, a Gaussian
 *     ripple emanates from center to edge, brightening (and slightly
 *     enlarging) particles in the wavefront. Strength is set per
 *     primitive via beatWaveStrength; speed via waveSpeed.
 *
 * --- Modulation hooks ---
 *   - outerRadius on `loud`  → whole thing expands with the mix
 *   - twist       on `mid`   → mids shear the rings against each other
 *   - radialBreath on `low`  → kicks pulse the rings outward
 *   - particleSize on `high` → hats/cymbals brighten the sprites
 *   - sparkle               (modulatable) → tie the twinkle to anything
 *
 * Contract (matches polygonEnvelope):
 *   { params, modulation, init(scene), dispose(scene),
 *     mountGui(parent, helpers), update({ time, dt, audio, bus }) }
 */

export const params = {
  // --- Non-modulatable structure (changes rebuild the buffer) ---
  ringCount: 24,
  particlesPerRing: 64,

  // --- Geometry (modulatable) ---
  innerRadius: 0.22,
  outerRadius: 0.9,
  particleSize: 10,        // pixels (sizeAttenuation: false)
  brightness: 0.85,        // overall intensity multiplier

  // --- Color ---
  color: '#ffffff',
  hueSpread: 0.0,          // ring-index hue rotation (HSV-space, fraction of full wheel; ±1 = ±360°)

  // --- HDR / sparkle (non-modulatable structural choices) ---
  hdrPeak: 2.0,            // centerline HDR multiplier — values >1 blow out to white via tone mapping
  sparkleRate: 1.5,        // twinkle frequency (Hz, roughly)

  // --- Sparkle amplitude (modulatable) ---
  sparkle: 0.3,            // 0 = perfectly steady, 1 = strong per-particle twinkle

  // --- Motion (modulatable) ---
  baseRotation: 0.08,
  twist: 0.6,
  radialBreath: 0.0,
  wobble: 0.0,

  // --- Beat wave ---
  // Triggered by the global bus.beatFired flag (configure source/threshold
  // in the modulators folder). 0 = disabled. The wave's brightness boost
  // is multiplied by beatWaveStrength; waveSpeed sets how fast it sweeps
  // from inner (ringT=0) to outer (ringT=1).
  beatWaveStrength: 0.0,   // 0..2
  waveSpeed: 1.5,          // ringT units per second
};

export const modulation = {
  innerRadius:  { source: '—',    amount: 0.10, min: 0.00, max: 1.00, step: 0.005 },
  outerRadius:  { source: 'loud', amount: 0.10, min: 0.20, max: 1.50, step: 0.005 },
  particleSize: { source: 'high', amount: 6.00, min: 0.50, max: 30.0, step: 0.10  },
  brightness:   { source: '—',    amount: 0.20, min: 0.00, max: 1.00, step: 0.01  },
  baseRotation: { source: '—',    amount: 0.10, min: -1.0, max: 1.00, step: 0.005 },
  twist:        { source: 'mid',  amount: 0.40, min: -3.0, max: 3.00, step: 0.01  },
  radialBreath: { source: 'low',  amount: 0.20, min: 0.00, max: 0.50, step: 0.005 },
  wobble:       { source: '—',    amount: 0.10, min: 0.00, max: 0.30, step: 0.005 },
  sparkle:      { source: '—',    amount: 0.30, min: 0.00, max: 1.00, step: 0.01  },

  // Color is special-cased (hue shift on the BASE color before per-ring
  // hueSpread is applied in the shader).
  color:        { source: '—',    amount: 0.10, kind: 'color' },
};

// Scratch objects (avoid per-frame allocation)
const _tmpColor = new THREE.Color();
const _tmpHsl = { h: 0, s: 0, l: 0 };

// Edge falloff exponent — same role as crossFalloff in lightPainting.
// 1.6 gives a nice soft-but-present glow; 3+ is harder, 0.7 is mushy.
const EDGE_FALLOFF = 1.6;

// --- Shaders ---
// Standard projection; per-vertex attributes drive both the sized point
// sprite and per-particle effects in the fragment shader.
const VERT = /* glsl */ `
  in float ringT;
  in float phase;
  out float vRingT;
  out float vPhase;
  uniform float pixelSize;
  uniform float waveFront;
  uniform float waveSigma;
  uniform float waveStrength;
  void main() {
    vRingT = ringT;
    vPhase = phase;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Wave bump: brief enlargement of particles whose ringT sits near
    // the wavefront. Same Gaussian as the brightness bump in the FS.
    float wd = ringT - waveFront;
    float bump = exp(-(wd * wd) / max(waveSigma * waveSigma, 1e-6)) * waveStrength;
    gl_PointSize = pixelSize * (1.0 + bump * 0.55);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  in float vRingT;
  in float vPhase;
  out vec4 fragColor;
  uniform vec3 baseColor;
  uniform float brightness;
  uniform float hdrPeak;
  uniform float edgeFalloff;
  uniform float sparkle;
  uniform float sparkleRate;
  uniform float hueSpread;
  uniform float time;
  uniform float waveFront;
  uniform float waveSigma;
  uniform float waveStrength;

  // Smallest-instruction-count HSV<->RGB pair (Sam Hocevar). Lets us do
  // per-particle hue shifts in the shader without precomputing per-ring
  // colors CPU-side.
  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
  }
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    // Radial falloff inside the point sprite. d=0 at center, 1 at edge.
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float a = pow(max(1.0 - d * d, 0.0), edgeFalloff);

    // Per-particle twinkle: phase ∈ [0,1] randomized per particle, so
    // adjacent particles oscillate out of sync. mix(1, sin, sparkle)
    // keeps amplitude controllable.
    float tw = sin(time * sparkleRate + vPhase * 6.2831853);
    float twinkle = 1.0 + sparkle * 0.5 * tw;

    // Inner→outer hue rotation. (vRingT - 0.5) centers the rotation so
    // setting hueSpread doesn't drag every particle's hue in one direction.
    vec3 hsv = rgb2hsv(baseColor);
    hsv.x = fract(hsv.x + (vRingT - 0.5) * hueSpread + 1.0);
    vec3 col = hsv2rgb(hsv);

    // Beat wave brightness bump.
    float wd = vRingT - waveFront;
    float waveBump = exp(-(wd * wd) / max(waveSigma * waveSigma, 1e-6)) * waveStrength;

    vec3 outRgb = col * brightness * hdrPeak * twinkle * (1.0 + waveBump * 1.2);
    // Premultiplied — paired with pure-additive blending below so stacked
    // particles accumulate luminance without alpha tinting.
    fragColor = vec4(outRgb * a, a);
  }
`;

// --- Internal state ---
let group = null;
let geometry = null;
let material = null;
let points = null;
let cachedKey = '';
let rotationAccum = 0;

// Beat-wave state. waveFront is the current radial position (0..1+);
// waveStrength decays/zeros when the wave finishes. Only one wave at a
// time — re-firing on a new beat restarts the wave from center.
let waveFront = 1.5;       // start past the outer ring → no wave on init
let waveStrength = 0;

/** Build or rebuild the particle geometry for the current structure. */
function rebuildGeometry(p) {
  const total = p.ringCount * p.particlesPerRing;
  if (geometry) geometry.dispose();
  geometry = new THREE.BufferGeometry();

  const positions = new Float32Array(total * 3);
  const ringT = new Float32Array(total);
  const phase = new Float32Array(total);

  // ringT and phase are set ONCE per structure rebuild and never change.
  // ringT: ring index normalized 0..1 (innermost..outermost)
  // phase: random 0..1 — each particle's twinkle phase offset
  let ptr = 0;
  for (let r = 0; r < p.ringCount; r++) {
    const t = p.ringCount > 1 ? r / (p.ringCount - 1) : 0;
    for (let i = 0; i < p.particlesPerRing; i++) {
      ringT[ptr] = t;
      phase[ptr] = Math.random();
      ptr++;
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('ringT',    new THREE.BufferAttribute(ringT, 1));
  geometry.setAttribute('phase',    new THREE.BufferAttribute(phase, 1));

  // Generous bounding sphere — particles drift but stay within ~1.5 units.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);

  cachedKey = `${p.ringCount}-${p.particlesPerRing}`;
}

/**
 * Write all particle positions for the current frame. Each ring gets
 * its own rotation offset (differential rotation via twist) and an
 * optional per-ring wobble.
 */
function writePositions(p, time, resolved) {
  const { innerRadius, outerRadius, twist, radialBreath, wobble, rotation } = resolved;
  const positions = geometry.attributes.position.array;
  const R = p.ringCount;
  const N = p.particlesPerRing;
  const twoPi = Math.PI * 2;
  let ptr = 0;

  for (let r = 0; r < R; r++) {
    const tRing = R > 1 ? r / (R - 1) : 0;
    const baseRadius = innerRadius + (outerRadius - innerRadius) * tRing;
    const ringRotation = rotation * (1 + twist * (1 - tRing));
    const wob = wobble === 0 ? 0 : wobble * Math.sin(time * 2 + r * 0.7);
    const finalRadius = baseRadius * (1 + radialBreath) + wob;

    for (let i = 0; i < N; i++) {
      const a = ringRotation + (i / N) * twoPi;
      positions[ptr++] = Math.cos(a) * finalRadius;
      positions[ptr++] = Math.sin(a) * finalRadius;
      positions[ptr++] = 0;
    }
  }
  geometry.attributes.position.needsUpdate = true;
}

export function init(scene) {
  group = new THREE.Group();

  material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      baseColor:    { value: new THREE.Color(0xffffff) },
      brightness:   { value: 1.0 },
      hdrPeak:      { value: 2.0 },
      edgeFalloff:  { value: EDGE_FALLOFF },
      sparkle:      { value: 0.3 },
      sparkleRate:  { value: 1.5 },
      hueSpread:    { value: 0.0 },
      time:         { value: 0.0 },
      pixelSize:    { value: 10.0 },
      waveFront:    { value: 1.5 },
      // Wavefront width (in ringT units). 0.18 gives a wide-but-defined
      // pulse — about 3 rings wide visually. Larger smears the ripple.
      waveSigma:    { value: 0.18 },
      waveStrength: { value: 0.0 },
    },
    // Pure additive (matches lightPainting / Manifold). AdditiveBlending
    // in three.js is SrcAlpha/One, which double-applies our pre-mul.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  rebuildGeometry(params);
  points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  group.add(points);
  scene.add(group);

  rotationAccum = 0;
  waveFront = 1.5;
  waveStrength = 0;
}

export function dispose(scene) {
  if (group) scene.remove(group);
  if (geometry) geometry.dispose();
  if (material) material.dispose();
  points = null;
  geometry = null;
  material = null;
  group = null;
  cachedKey = '';
}

export function mountGui(parent, { addModulated, addModulatedColor }) {
  const rings = parent.addFolder('rings');
  rings.add(params, 'ringCount', 1, 80, 1).name('ring count');
  rings.add(params, 'particlesPerRing', 3, 256, 1).name('particles / ring');
  addModulated(rings, params, modulation, 'innerRadius', 'inner radius');
  addModulated(rings, params, modulation, 'outerRadius', 'outer radius');
  addModulated(rings, params, modulation, 'particleSize', 'particle size');
  addModulated(rings, params, modulation, 'brightness', 'brightness');
  addModulatedColor(rings, params, modulation, 'color', 'color');
  // Hue spread: rotates per-particle hue across rings. Non-modulatable
  // because it's a structural color choice, not a wiggle parameter.
  rings.add(params, 'hueSpread', -1.0, 1.0, 0.005).name('hue spread (rings)');
  rings.add(params, 'hdrPeak',    1.0,  5.0, 0.05).name('HDR peak');
  rings.open();

  const sparkleFolder = parent.addFolder('sparkle');
  addModulated(sparkleFolder, params, modulation, 'sparkle', 'amount');
  sparkleFolder.add(params, 'sparkleRate', 0, 8, 0.05).name('rate (Hz)');
  sparkleFolder.open();

  const motion = parent.addFolder('motion');
  addModulated(motion, params, modulation, 'baseRotation', 'base rotation');
  addModulated(motion, params, modulation, 'twist', 'twist');
  addModulated(motion, params, modulation, 'radialBreath', 'radial breath');
  addModulated(motion, params, modulation, 'wobble', 'wobble');
  motion.open();

  const beat = parent.addFolder('beat wave');
  beat.add(params, 'beatWaveStrength', 0, 2, 0.01).name('strength');
  beat.add(params, 'waveSpeed',        0.1, 5, 0.05).name('speed (rings/s)');
  beat.open();
}

export function update({ time, dt, audio, bus }) {
  const p = params;
  const m = modulation;

  // Structural rebuild
  const key = `${p.ringCount}-${p.particlesPerRing}`;
  if (key !== cachedKey) {
    rebuildGeometry(p);
    points.geometry = geometry;
  }

  // Resolve modulatable scalars
  const innerRadius  = resolve(p.innerRadius,  m.innerRadius,  audio, bus);
  const outerRadius  = resolve(p.outerRadius,  m.outerRadius,  audio, bus);
  const particleSize = resolve(p.particleSize, m.particleSize, audio, bus);
  const brightness   = resolve(p.brightness,   m.brightness,   audio, bus);
  const baseRotation = resolve(p.baseRotation, m.baseRotation, audio, bus);
  const twist        = resolve(p.twist,        m.twist,        audio, bus);
  const radialBreath = resolve(p.radialBreath, m.radialBreath, audio, bus);
  const wobble       = resolve(p.wobble,       m.wobble,       audio, bus);
  const sparkle      = resolve(p.sparkle,      m.sparkle,      audio, bus);

  // Continuous rotation accumulator
  rotationAccum += baseRotation * dt;

  // Guard inner < outer so the field doesn't collapse
  const safeInner = Math.min(innerRadius, outerRadius - 0.01);

  writePositions(p, time, {
    innerRadius: safeInner,
    outerRadius,
    twist,
    radialBreath,
    wobble,
    rotation: rotationAccum,
  });

  // Beat-driven radial wave: trigger on bus.beatFired, advance by
  // waveSpeed each frame. We let it run a bit past 1.0 (the outermost
  // ring) so the wavefront's Gaussian tail finishes leaving the field
  // cleanly rather than getting clipped.
  if (bus.beatFired && p.beatWaveStrength > 0) {
    waveFront = -0.15;            // start just inside the inner ring
    waveStrength = p.beatWaveStrength;
  }
  if (waveStrength > 0) {
    waveFront += p.waveSpeed * dt;
    if (waveFront > 1.4) {
      waveStrength = 0;
    }
  }

  // Push uniforms
  const u = material.uniforms;
  u.brightness.value   = Math.max(0, brightness);
  u.pixelSize.value    = Math.max(0.5, particleSize);
  u.hdrPeak.value      = Math.max(1, p.hdrPeak);
  u.sparkle.value      = Math.max(0, Math.min(1, sparkle));
  u.sparkleRate.value  = Math.max(0, p.sparkleRate);
  u.hueSpread.value    = p.hueSpread;
  u.time.value         = time;
  u.waveFront.value    = waveFront;
  u.waveStrength.value = waveStrength;

  // Base color (with hue-shift modulation applied first, before the
  // per-ring hueSpread fan-out in the shader).
  const cm = m.color;
  if (cm && cm.source && cm.source !== '—') {
    _tmpColor.set(p.color).getHSL(_tmpHsl);
    const sv = bus.sourceValue(cm.source, audio);
    let h = _tmpHsl.h + (sv - 0.5) * 2 * cm.amount;
    h = ((h % 1) + 1) % 1;
    _tmpColor.setHSL(h, _tmpHsl.s, _tmpHsl.l);
  } else {
    _tmpColor.set(p.color);
  }
  u.baseColor.value.copy(_tmpColor);
}
