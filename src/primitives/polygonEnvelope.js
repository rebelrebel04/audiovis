import * as THREE from 'three';
import { resolve } from '../modulation.js';

/**
 * Polygon Envelope
 *
 * Generalizes the classic "triangle string-art envelope" to any N-gon.
 *
 * Construction: given a regular polygon with N sides, for each adjacent
 * edge-pair (up to `envelopeCoverage` of them), draw `lineCount` line
 * segments connecting points that traverse the two edges at offset rates.
 * The envelope of all those lines is a smooth curved region tangent to
 * both edges.
 *
 * At N=3, envelopeCoverage=1 → the classic asymmetric single-envelope
 * triangle (matches Kurt's opening reference image).
 * At N=3, envelopeCoverage=3 → symmetric triangular rosette.
 * At N=12+ with full coverage → mandala / rose-curve territory.
 *
 * Rendered as a single THREE.LineSegments for performance. The geometry
 * buffer is rebuilt when the line count / sides / coverage change;
 * positions are rewritten every frame based on animation phase.
 *
 * Modulation: every "continuous" param has a matching entry in `modulation`
 * (see modulation.js for the shape). Non-continuous params (sides,
 * envelopeCoverage, lineCount, color) remain fixed scalars.
 *
 * Contract exposed to main.js:
 *   { params, modulation, init(scene), update({ time, dt, audio, bus }) }
 */

export const params = {
  // --- Geometry (non-modulatable: changing these rebuilds the geometry buffer) ---
  sides: 3,                  // N-gon: 3..20
  envelopeCoverage: 1,       // How many adjacent edge-pairs get envelopes (1..sides)
  lineCount: 80,             // Line segments per envelope

  // --- Geometry (modulatable) ---
  polygonRadius: 0.75,
  lineOpacity: 0.45,

  // --- Color (not modulatable for now) ---
  color: '#ffffff',

  // --- Motion (all modulatable) ---
  rotationSpeedX: 0.05,
  rotationSpeedY: 0.35,
  rotationSpeedZ: 0.03,
  phaseSpeed: 0.12,          // How fast the two edge-walkers drift out of phase
  phaseAsymmetry: 0.5,       // 0 = both walkers same speed, 1 = fully offset
  globalTilt: 0.3,           // Static z-axis tilt offset
};

/**
 * Modulation metadata for each modulatable param.
 * min / max / step are also used by the UI to size sliders (single source of truth).
 *
 * Defaults below preserve the "subtle audio modulation" feel of the
 * pre-modulation version — loud breathes polygonRadius, mid drives phase,
 * etc. — while letting the user swap any source for any param.
 */
export const modulation = {
  polygonRadius:  { source: 'loud', amount: 0.05, min: 0.2,       max: 1.5,      step: 0.01 },
  lineOpacity:    { source: 'high', amount: 0.10, min: 0,         max: 1,        step: 0.01 },
  rotationSpeedX: { source: '—',    amount: 0.10, min: -1,        max: 1,        step: 0.01 },
  rotationSpeedY: { source: 'low',  amount: 0.08, min: -1,        max: 1,        step: 0.01 },
  rotationSpeedZ: { source: '—',    amount: 0.05, min: -1,        max: 1,        step: 0.01 },
  phaseSpeed:     { source: 'mid',  amount: 0.05, min: -1,        max: 1,        step: 0.01 },
  phaseAsymmetry: { source: '—',    amount: 0.10, min: 0,         max: 1,        step: 0.01 },
  globalTilt:     { source: '—',    amount: 0.20, min: -Math.PI,  max: Math.PI,  step: 0.01 },

  // Color is a special case: source modulates HUE (not a scalar), so it
  // uses a different metadata shape. `amount` is measured as a fraction
  // of the full color wheel (0.5 = ±180° swing). Handled inline in
  // update() — resolve() ignores entries flagged kind:'color'.
  color:          { source: '—',    amount: 0.10, kind: 'color' },
};

// Scratch objects for color modulation (avoid per-frame allocation)
const _tmpColor = new THREE.Color();
const _tmpHsl = { h: 0, s: 0, l: 0 };

// --- Internal state (re-initialized on init()) ---
let lineSegments = null;
let geometry = null;
let material = null;
let group = null;
let cachedKey = ''; // "sides-coverage-lineCount" — detects structural rebuild

// Animation accumulators (so param changes don't cause jumps)
let rotX = 0, rotY = 0, rotZ = 0;
let phaseAccum = 0;

/** Build or rebuild the line-segment geometry for the current structure. */
function rebuildGeometry(p) {
  const envelopeCount = Math.min(p.envelopeCoverage, p.sides);
  const segmentsPerEnvelope = p.lineCount;
  const totalSegments = envelopeCount * segmentsPerEnvelope;
  const vertexCount = totalSegments * 2;

  if (geometry) geometry.dispose();
  geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(vertexCount * 3);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setDrawRange(0, vertexCount);

  cachedKey = `${p.sides}-${envelopeCount}-${segmentsPerEnvelope}`;
}

/** Compute the N vertices of a regular polygon of radius r. */
function polygonVertices(sides, radius) {
  const verts = [];
  for (let i = 0; i < sides; i++) {
    // Start at top (angle = -π/2) so triangles point up by default
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
    verts.push([Math.cos(a) * radius, Math.sin(a) * radius, 0]);
  }
  return verts;
}

/** Write envelope line positions into the buffer based on current phase. */
function writeEnvelopes(p, phase, radius, phaseAsymmetry) {
  const verts = polygonVertices(p.sides, radius);
  const envelopeCount = Math.min(p.envelopeCoverage, p.sides);
  const n = p.lineCount;
  const positions = geometry.attributes.position.array;

  let ptr = 0;
  for (let e = 0; e < envelopeCount; e++) {
    const v0 = verts[e];
    const v1 = verts[(e + 1) % p.sides];
    const v2 = verts[(e + 2) % p.sides];

    for (let i = 0; i < n; i++) {
      const tA = i / (n - 1);
      let tB = (tA + phase * phaseAsymmetry) % 1;
      if (tB < 0) tB += 1;

      const ax = v0[0] + (v1[0] - v0[0]) * tA;
      const ay = v0[1] + (v1[1] - v0[1]) * tA;
      const bx = v1[0] + (v2[0] - v1[0]) * tB;
      const by = v1[1] + (v2[1] - v1[1]) * tB;

      positions[ptr++] = ax;
      positions[ptr++] = ay;
      positions[ptr++] = 0;
      positions[ptr++] = bx;
      positions[ptr++] = by;
      positions[ptr++] = 0;
    }
  }
  geometry.attributes.position.needsUpdate = true;
}

export function init(scene) {
  group = new THREE.Group();

  material = new THREE.LineBasicMaterial({
    color: new THREE.Color(params.color),
    transparent: true,
    opacity: params.lineOpacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  rebuildGeometry(params);
  writeEnvelopes(params, 0, params.polygonRadius, params.phaseAsymmetry);

  lineSegments = new THREE.LineSegments(geometry, material);
  group.add(lineSegments);
  scene.add(group);

  rotX = 0;
  rotY = 0;
  rotZ = 0;
  phaseAccum = 0;
}

/**
 * Per-frame update.
 * @param {object} ctx - { time, dt, audio, bus }
 */
export function update({ time, dt, audio, bus }) {
  const p = params;
  const m = modulation;

  // Detect structural change and rebuild.
  const coverage = Math.min(p.envelopeCoverage, p.sides);
  const key = `${p.sides}-${coverage}-${p.lineCount}`;
  if (key !== cachedKey) {
    rebuildGeometry(p);
    lineSegments.geometry = geometry;
  }

  // Resolve all modulatable params for this frame
  const polygonRadius  = resolve(p.polygonRadius,  m.polygonRadius,  audio, bus);
  const lineOpacity    = resolve(p.lineOpacity,    m.lineOpacity,    audio, bus);
  const rotationSpeedX = resolve(p.rotationSpeedX, m.rotationSpeedX, audio, bus);
  const rotationSpeedY = resolve(p.rotationSpeedY, m.rotationSpeedY, audio, bus);
  const rotationSpeedZ = resolve(p.rotationSpeedZ, m.rotationSpeedZ, audio, bus);
  const phaseSpeed     = resolve(p.phaseSpeed,     m.phaseSpeed,     audio, bus);
  const phaseAsymmetry = resolve(p.phaseAsymmetry, m.phaseAsymmetry, audio, bus);
  const globalTilt     = resolve(p.globalTilt,     m.globalTilt,     audio, bus);

  // Accumulators use resolved rates so audio/mod effects integrate smoothly
  rotX += rotationSpeedX * dt;
  rotY += rotationSpeedY * dt;
  rotZ += rotationSpeedZ * dt;
  phaseAccum += phaseSpeed * dt;

  group.rotation.set(rotX, rotY, rotZ + globalTilt);

  material.opacity = Math.max(0, Math.min(1, lineOpacity));

  // Color modulation (inline — hue shift, not scalar).
  // Base color → HSL → shift H by (source - 0.5) * 2 * amount → back.
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

  writeEnvelopes(p, phaseAccum, polygonRadius, phaseAsymmetry);
}
