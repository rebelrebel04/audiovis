import * as THREE from 'three';
import { resolve } from '../modulation.js';

/**
 * Particle Rings
 *
 * Concentric rings of additive-blended point sprites with differential
 * rotation — inner rings can spin faster (or slower) than outer rings,
 * producing the hypnotic "gearing" feel of mandala/infinite-mantra visuals.
 *
 * Aesthetic: leans heavily on the bloom pass. Each particle is a soft
 * radial falloff sprite, so when bloom catches them they smear into
 * luminous arcs. Default density is 24 × 64 = 1536 particles, which is
 * cheap but visually dense.
 *
 * Modulation hooks:
 *   - outerRadius on `loud`  → whole thing expands with the mix
 *   - twist       on `mid`   → mids shear the rings against each other
 *   - radialBreath on `low`  → kicks pulse the rings outward
 *   - particleSize on `high` → hats/cymbals brighten the sprites
 *
 * Contract (matches polygonEnvelope):
 *   { params, modulation, init(scene), dispose(scene),
 *     mountGui(parent, helpers), update({ time, dt, audio, bus }) }
 */

export const params = {
  // --- Non-modulatable (changing these rebuilds the geometry buffer) ---
  ringCount: 24,
  particlesPerRing: 64,

  // --- Geometry (modulatable) ---
  innerRadius: 0.22,
  outerRadius: 0.9,
  particleSize: 10,        // pixels (sizeAttenuation: false)
  brightness: 0.85,        // material opacity

  // --- Color ---
  color: '#ffffff',

  // --- Motion (modulatable) ---
  baseRotation: 0.08,      // rad/sec at outer ring
  twist: 0.6,              // differential factor: innerSpeed = base * (1 + twist)
  radialBreath: 0.0,       // audio-driven uniform radius pulse (base 0 — amount adds on top)
  wobble: 0.0,             // per-ring sinusoidal radial perturbation
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

  // Color is special-cased (hue shift) — see update().
  color:        { source: '—',    amount: 0.10, kind: 'color' },
};

// Scratch objects for color modulation (avoid per-frame allocation)
const _tmpColor = new THREE.Color();
const _tmpHsl = { h: 0, s: 0, l: 0 };

// --- Internal state (re-initialized on init()) ---
let points = null;
let geometry = null;
let material = null;
let pointTexture = null;
let group = null;
let cachedKey = '';

// Rotation accumulator (so baseRotation changes don't cause jumps)
let rotationAccum = 0;

/** Generate a soft radial-gradient sprite for point particles. */
function makePointTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Build or rebuild the particle buffer for the current structure. */
function rebuildGeometry(p) {
  const total = p.ringCount * p.particlesPerRing;
  if (geometry) geometry.dispose();
  geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(total * 3);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  cachedKey = `${p.ringCount}-${p.particlesPerRing}`;
}

/**
 * Write all particle positions for the current frame. Each ring gets
 * its own rotation offset (differential rotation via `twist`) and an
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
    const tRing = R > 1 ? r / (R - 1) : 0;  // 0 = innermost, 1 = outermost
    const baseRadius = innerRadius + (outerRadius - innerRadius) * tRing;

    // Differential rotation: at twist=1, inner ring spins 2× base, outer 1× base.
    // At twist=-1, inner ring is stationary while outer rotates normally.
    const ringRotation = rotation * (1 + twist * (1 - tRing));

    // Uniform radial breath (audio-driven pulse) plus per-ring sinusoidal wobble.
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
  pointTexture = makePointTexture();

  material = new THREE.PointsMaterial({
    color: new THREE.Color(params.color),
    size: params.particleSize,
    sizeAttenuation: false, // pixel-space size (crisp for bloom)
    map: pointTexture,
    transparent: true,
    opacity: params.brightness,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  rebuildGeometry(params);
  points = new THREE.Points(geometry, material);
  group.add(points);
  scene.add(group);

  rotationAccum = 0;
}

/** Remove scene objects and free GPU resources. Paired with init(). */
export function dispose(scene) {
  if (group) scene.remove(group);
  if (geometry) geometry.dispose();
  if (material) material.dispose();
  if (pointTexture) pointTexture.dispose();
  points = null;
  geometry = null;
  material = null;
  pointTexture = null;
  group = null;
  cachedKey = '';
}

/** Populate a lil-gui parent folder with this primitive's controls. */
export function mountGui(parent, { addModulated, addModulatedColor }) {
  const rings = parent.addFolder('rings');
  rings.add(params, 'ringCount', 1, 80, 1).name('ring count');
  rings.add(params, 'particlesPerRing', 3, 256, 1).name('particles / ring');
  addModulated(rings, params, modulation, 'innerRadius', 'inner radius');
  addModulated(rings, params, modulation, 'outerRadius', 'outer radius');
  addModulated(rings, params, modulation, 'particleSize', 'particle size');
  addModulated(rings, params, modulation, 'brightness', 'brightness');
  addModulatedColor(rings, params, modulation, 'color', 'color');
  rings.open();

  const motion = parent.addFolder('motion');
  addModulated(motion, params, modulation, 'baseRotation', 'base rotation');
  addModulated(motion, params, modulation, 'twist', 'twist');
  addModulated(motion, params, modulation, 'radialBreath', 'radial breath');
  addModulated(motion, params, modulation, 'wobble', 'wobble');
  motion.open();
}

/**
 * Per-frame update.
 * @param {object} ctx - { time, dt, audio, bus }
 */
export function update({ time, dt, audio, bus }) {
  const p = params;
  const m = modulation;

  // Detect structural change and rebuild.
  const key = `${p.ringCount}-${p.particlesPerRing}`;
  if (key !== cachedKey) {
    rebuildGeometry(p);
    points.geometry = geometry;
  }

  // Resolve all modulatable params for this frame
  const innerRadius  = resolve(p.innerRadius,  m.innerRadius,  audio, bus);
  const outerRadius  = resolve(p.outerRadius,  m.outerRadius,  audio, bus);
  const particleSize = resolve(p.particleSize, m.particleSize, audio, bus);
  const brightness   = resolve(p.brightness,   m.brightness,   audio, bus);
  const baseRotation = resolve(p.baseRotation, m.baseRotation, audio, bus);
  const twist        = resolve(p.twist,        m.twist,        audio, bus);
  const radialBreath = resolve(p.radialBreath, m.radialBreath, audio, bus);
  const wobble       = resolve(p.wobble,       m.wobble,       audio, bus);

  // Accumulate rotation so live rate changes don't cause jumps
  rotationAccum += baseRotation * dt;

  // Guard against inner >= outer (would collapse the field)
  const safeInner = Math.min(innerRadius, outerRadius - 0.01);

  writePositions(p, time, {
    innerRadius: safeInner,
    outerRadius,
    twist,
    radialBreath,
    wobble,
    rotation: rotationAccum,
  });

  material.size = Math.max(0.1, particleSize);
  material.opacity = Math.max(0, Math.min(1, brightness));

  // Color modulation (inline — hue shift, not scalar).
  const cm = m.color;
  if (cm && cm.source && cm.source !== '—') {
    _tmpColor.set(p.color).getHSL(_tmpHsl);
    const sv = bus.sourceValue(cm.source, audio);
    let h = _tmpHsl.h + (sv - 0.5) * 2 * cm.amount;
    h = ((h % 1) + 1) % 1; // wrap into [0, 1)
    material.color.setHSL(h, _tmpHsl.s, _tmpHsl.l);
  } else {
    material.color.set(p.color);
  }
}
