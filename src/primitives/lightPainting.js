import * as THREE from 'three';
import { resolve } from '../modulation.js';

/**
 * Light Painting — ribbon-mesh technique
 *
 * Autonomous line agents that wander the canvas and leave fading neon
 * trails. Each agent has a position + heading; on each frame the path
 * generator nudges its heading and it integrates forward by `speed * dt`.
 * The last N positions are kept in a ring buffer.
 *
 * --- Rendering ---
 * Soft-edged ribbon mesh, ported from the Quine "Manifold" VST's
 * PhasePortrait. For each trail point we emit two mesh vertices offset
 * perpendicularly by `halfWidth` in world space (square pixels for our
 * fixed 1080×1920 ortho camera so world-space and screen-space half-widths
 * are isotropic). The pairs form a triangle strip along the trail.
 *
 * Per-vertex attributes:
 *   - age ∈ [0, 1] — 0 at oldest end, 1 at the head
 *   - u   ∈ {-1, +1} — cross-ribbon coordinate, ±1 at edges, 0 at centerline
 *
 * The fragment shader computes:
 *   - age fade          : pow(age, fadeExponent)        — tail decays
 *   - head-glow bump    : 1 + headGlow * pow(age, 6)    — bright tip
 *   - cross-ribbon edge : pow(1 - u², crossFalloff)     — soft tube
 * Their product is the per-pixel alpha. Color is premultiplied so additive
 * blending accumulates straight into the FBO.
 *
 * Why this looks better than thick Line2:
 *   - The soft "tube" gradient is *built into the geometry* via the cross-
 *     ribbon u coordinate, instead of being manufactured by bloom alone.
 *     The bloom pass becomes additional flair on top of an already-soft
 *     line, rather than the entire source of softness.
 *   - Adjacent ribbon vertices use *miter-averaged* perpendiculars (mean
 *     of the two adjacent segment perpendiculars), so corners join cleanly
 *     instead of producing the "kinked sausage" artifact you get with
 *     per-segment perpendiculars.
 *
 * --- Phase-2 hook (HDR composer) ---
 * In LDR (the current composer), `trailColor * brightness * a` clips at
 * 1.0 — so the centerline saturates to whatever the color × brightness is.
 * Once the composer's render targets become HalfFloat, we can push values
 * past 1.0 (via a `hdrPeak` uniform) and the centerline will blow out to
 * white while the ribbon edges retain hue, producing the white-hot core
 * Manifold has. The shader is already written for that path; only the
 * composer needs upgrading.
 *
 * --- Path generator (unchanged) ---
 * Blends a sum-of-sines curvy mode with distance-based ±90° snap turns
 * via the `straightness` axis. Beat-driven heading injection via
 * `beatTurnAngle`.
 */

export const params = {
  // --- Non-modulatable (rebuilds agents / ribbon geometry) ---
  lineCount: 3,
  trailLength: 220,

  // --- Agents (modulatable) ---
  speed: 0.55,            // world units / second
  lineWidth: 5.5,         // pixel diameter of the ribbon
  brightness: 1.0,        // overall intensity multiplier
  headGlow: 1.5,          // extra brightness bump at the head tip
  fadeExponent: 1.6,      // tail fade shape: 1=linear, >1 concentrates near head
  hdrPeak: 2.5,           // centerline HDR multiplier — values >1 blow out to white via tone mapping

  // --- Color ---
  color: '#ffffff',

  // --- Motion / path generator (modulatable) ---
  straightness: 0.0,      // 0 = curvy, 1 = architectural
  curviness: 1.4,         // amplitude of the curvy-mode angular velocity
  segmentLength: 0.35,    // world units between snap turns (architectural mode)

  // --- Beat turn ---
  // Injects a ±beatTurnAngle heading delta for every agent on each beat
  // event from the global bus. Set to 0 to disable.
  beatTurnAngle: 90,
};

export const modulation = {
  speed:         { source: 'mid',  amount: 0.40, min: 0.00, max: 3.00, step: 0.01  },
  lineWidth:     { source: 'high', amount: 4.00, min: 0.30, max: 30.0, step: 0.10  },
  brightness:    { source: '—',    amount: 0.30, min: 0.00, max: 1.00, step: 0.01  },
  headGlow:      { source: '—',    amount: 1.00, min: 0.00, max: 4.00, step: 0.05  },
  fadeExponent:  { source: '—',    amount: 0.50, min: 0.20, max: 4.00, step: 0.05  },
  straightness:  { source: '—',    amount: 0.40, min: 0.00, max: 1.00, step: 0.01  },
  curviness:     { source: 'loud', amount: 1.20, min: 0.00, max: 5.00, step: 0.05  },
  segmentLength: { source: '—',    amount: 0.30, min: 0.05, max: 1.50, step: 0.01  },

  color:         { source: '—',    amount: 0.10, kind: 'color' },
};

// Scratch objects (avoid per-frame allocation)
const _tmpColor = new THREE.Color();
const _tmpHsl = { h: 0, s: 0, l: 0 };

// World units per pixel for our fixed 1080x1920 ortho camera. Y range
// -1..1 spans 1920 px → 1 unit / 960 px → half-width in world units is
// (lineWidthPx / 2) / 960 = lineWidthPx / 1920.
const PX_TO_WORLD_HALF = 1.0 / 1920.0;

// Cross-ribbon edge softness exponent. Manifold uses 1.4; sharper values
// (~3) give a hard-edged "lasso" look, softer (~0.7) gives a heavy glow.
const CROSS_FALLOFF = 1.4;

// --- Shaders ---
// Standard three.js attribute (`position`) and uniforms (projectionMatrix,
// modelViewMatrix) are auto-injected by ShaderMaterial in GLSL3 mode.
const VERT = /* glsl */ `
  in float age;
  in float u;
  out float vAge;
  out float vU;
  void main() {
    vAge = age;
    vU = u;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  in float vAge;
  in float vU;
  out vec4 fragColor;
  uniform vec3 trailColor;
  uniform float brightness;
  uniform float fadeExponent;
  uniform float headGlow;
  uniform float crossFalloff;
  uniform float hdrPeak;
  void main() {
    float ageFade = pow(vAge, fadeExponent);
    float headBoost = 1.0 + headGlow * pow(vAge, 6.0);
    float edge = 1.0 - vU * vU;
    float crossA = pow(max(edge, 0.0), crossFalloff);
    float a = ageFade * headBoost * crossA;
    // Multiply RGB by hdrPeak — at the centerline (a≈1) this lifts the
    // color past 1.0 into HDR. With ACES tone mapping downstream, those
    // pixels blow out to white while ribbon edges (lower a, thus lower
    // post-multiply intensity) retain hue. That's the white-hot core.
    // Alpha stays in [0,1] so additive accumulation behaves sanely.
    vec3 col = trailColor * brightness * hdrPeak * a;
    fragColor = vec4(col, a);
  }
`;

// --- Internal state ---
let group = null;
let material = null;
let agents = [];
let cachedStructureKey = '';

/**
 * Create one agent: random starting position + heading + path-generator
 * phase, an empty trail ring buffer, and a triangle-strip BufferGeometry
 * with 2N vertices (top + bottom of the ribbon at each trail point) and
 * 6(N-1) indices (two triangles per quad).
 *
 * The `u` attribute (±1 alternating per pair) is filled once at creation
 * and never changes — only `position` and `age` are written each frame.
 */
function makeAgent(p, aspect) {
  const N = p.trailLength;

  const x = (Math.random() - 0.5) * aspect * 1.5;
  const y = (Math.random() - 0.5) * 1.6;

  const trailX = new Float32Array(N);
  const trailY = new Float32Array(N);
  trailX.fill(x);
  trailY.fill(y);

  // Ordered (oldest→newest) scratch buffers for the ribbon writer. Avoids
  // ring-buffer index gymnastics during perpendicular calculation.
  const orderedX = new Float32Array(N);
  const orderedY = new Float32Array(N);

  const geometry = new THREE.BufferGeometry();

  // 2 vertices per trail point, 3 floats each (xyz)
  const positions = new Float32Array(2 * N * 3);
  const ages = new Float32Array(2 * N);
  const us = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) {
    us[i * 2 + 0] = +1.0; // top
    us[i * 2 + 1] = -1.0; // bottom
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('age',      new THREE.BufferAttribute(ages, 1));
  geometry.setAttribute('u',        new THREE.BufferAttribute(us, 1));

  // Index buffer: for each quad k (0..N-2), two triangles built from the
  // four vertices at quad corners (top_k, bot_k, top_{k+1}, bot_{k+1}).
  // T1: (top_k, bot_k, top_{k+1})  T2: (bot_k, bot_{k+1}, top_{k+1})
  const indices = new Uint16Array(6 * (N - 1));
  for (let k = 0; k < N - 1; k++) {
    const i = k * 6;
    const v0 = k * 2;            // top_k
    const v1 = k * 2 + 1;        // bot_k
    const v2 = (k + 1) * 2;      // top_{k+1}
    const v3 = (k + 1) * 2 + 1;  // bot_{k+1}
    indices[i + 0] = v0; indices[i + 1] = v1; indices[i + 2] = v2;
    indices[i + 3] = v1; indices[i + 4] = v3; indices[i + 5] = v2;
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // Disable bounding sphere checks — trails roam outside their initial
  // bounds and our ortho camera always renders the full scene anyway.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  return {
    x, y,
    theta: Math.random() * Math.PI * 2,
    phase: Math.random() * 100,
    distSinceTurn: 0,
    trailX, trailY,
    orderedX, orderedY,
    head: 0, // index of most recently written entry
    geometry,
    mesh,
    positions,
    ages,
  };
}

/**
 * (Re)build all agents. Called on init and whenever lineCount or
 * trailLength change. Disposes old geometries before allocating new ones.
 */
function buildStructure(p, aspect) {
  for (const a of agents) {
    group.remove(a.mesh);
    a.geometry.dispose();
  }
  agents = [];

  for (let i = 0; i < p.lineCount; i++) {
    const a = makeAgent(p, aspect);
    group.add(a.mesh);
    agents.push(a);
  }
  cachedStructureKey = `${p.lineCount}-${p.trailLength}`;
}

/**
 * Curvy-mode angular velocity — sum of three sines at incommensurable
 * rates so the result doesn't repeat obviously.
 */
function smoothOmega(time, phase, amplitude) {
  const t = time + phase;
  return (
    Math.sin(t * 1.30) * 1.0 +
    Math.sin(t * 0.40 + 2.1) * 0.8 +
    Math.sin(t * 0.27 + 4.7) * 0.5
  ) * amplitude;
}

/**
 * Advance one agent by dt, pushing the new position onto its trail ring.
 * Path generator blends smooth-noise curvature with distance-triggered
 * ±90° snap turns based on `straightness`.
 */
function updateAgent(a, dt, time, resolved, aspect) {
  const { speed, straightness, curviness, segmentLength } = resolved;

  const curvy = 1 - straightness;
  if (curvy > 0.001) {
    const omega = smoothOmega(time * 0.5, a.phase, curviness) * curvy;
    a.theta += omega * dt;
  }

  if (straightness > 0.01) {
    a.distSinceTurn += speed * dt;
    if (a.distSinceTurn >= segmentLength) {
      if (Math.random() < straightness) {
        if (straightness > 0.5) {
          a.theta = Math.round(a.theta / (Math.PI / 2)) * (Math.PI / 2);
        }
        a.theta += (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2);
      }
      a.distSinceTurn = 0;
    }
  }

  a.x += Math.cos(a.theta) * speed * dt;
  a.y += Math.sin(a.theta) * speed * dt;

  const bx = aspect * 0.95;
  const by = 0.95;
  if (a.x < -bx) { a.x = -bx; a.theta = Math.PI - a.theta; }
  if (a.x >  bx) { a.x =  bx; a.theta = Math.PI - a.theta; }
  if (a.y < -by) { a.y = -by; a.theta = -a.theta; }
  if (a.y >  by) { a.y =  by; a.theta = -a.theta; }

  a.head = (a.head + 1) % a.trailX.length;
  a.trailX[a.head] = a.x;
  a.trailY[a.head] = a.y;
}

/**
 * Write an agent's trail into its ribbon mesh attributes.
 *
 * 1. Copy ring buffer into oldest-first scratch arrays so neighbor
 *    indexing for perpendiculars is straightforward.
 * 2. For each point, compute the miter-averaged perpendicular direction
 *    (mean of the two adjacent segment perpendiculars, normalized) — at
 *    endpoints fall back to the single available perpendicular.
 * 3. Emit the top vertex at p + n * halfWidth and bottom at p - n *
 *    halfWidth. Both share `age = i / (N-1)` so the FS interpolates the
 *    cross-ribbon `u` while keeping age constant across the strip.
 *
 * Width is in world units, computed by the caller from pixel `lineWidth`
 * via PX_TO_WORLD_HALF. Doing the perpendicular math in world space is
 * fine because our pixels are square (see PX_TO_WORLD_HALF comment).
 */
function writeRibbonBuffers(a, halfWidthWorld) {
  const N = a.trailX.length;
  const oldest = (a.head + 1) % N;

  // Linearize ring buffer
  for (let i = 0; i < N; i++) {
    const idx = (oldest + i) % N;
    a.orderedX[i] = a.trailX[idx];
    a.orderedY[i] = a.trailY[idx];
  }

  const positions = a.positions;
  const ages = a.ages;
  const ox = a.orderedX;
  const oy = a.orderedY;

  for (let i = 0; i < N; i++) {
    let nx, ny;
    if (i === 0) {
      // Endpoint: use forward segment's perpendicular
      const dx = ox[1] - ox[0];
      const dy = oy[1] - oy[0];
      const L = Math.hypot(dx, dy);
      if (L < 1e-7) { nx = 0; ny = 0; }
      else { nx = -dy / L; ny = dx / L; }
    } else if (i === N - 1) {
      const dx = ox[i] - ox[i - 1];
      const dy = oy[i] - oy[i - 1];
      const L = Math.hypot(dx, dy);
      if (L < 1e-7) { nx = 0; ny = 0; }
      else { nx = -dy / L; ny = dx / L; }
    } else {
      // Interior: average the two adjacent segment perpendiculars. This
      // gives smooth miter joins at corners — a kinked-sausage artifact
      // appears if you instead pick one segment arbitrarily.
      const dx1 = ox[i] - ox[i - 1];
      const dy1 = oy[i] - oy[i - 1];
      const L1 = Math.hypot(dx1, dy1);
      const n1x = L1 > 1e-7 ? -dy1 / L1 : 0;
      const n1y = L1 > 1e-7 ?  dx1 / L1 : 0;

      const dx2 = ox[i + 1] - ox[i];
      const dy2 = oy[i + 1] - oy[i];
      const L2 = Math.hypot(dx2, dy2);
      const n2x = L2 > 1e-7 ? -dy2 / L2 : 0;
      const n2y = L2 > 1e-7 ?  dx2 / L2 : 0;

      let sx = n1x + n2x;
      let sy = n1y + n2y;
      const Ln = Math.hypot(sx, sy);
      if (Ln < 1e-7) {
        // Hairpin: the two perpendiculars cancel. Fall back to the
        // perpendicular of the chord across the doubled-back point.
        const cx = ox[i + 1] - ox[i - 1];
        const cy = oy[i + 1] - oy[i - 1];
        const Lc = Math.hypot(cx, cy);
        nx = Lc > 1e-7 ? -cy / Lc : 0;
        ny = Lc > 1e-7 ?  cx / Lc : 0;
      } else {
        nx = sx / Ln;
        ny = sy / Ln;
      }
    }

    const px = ox[i];
    const py = oy[i];
    const offX = nx * halfWidthWorld;
    const offY = ny * halfWidthWorld;
    const age = i / (N - 1);

    const v = i * 2 * 3;
    positions[v + 0] = px + offX; positions[v + 1] = py + offY; positions[v + 2] = 0;
    positions[v + 3] = px - offX; positions[v + 4] = py - offY; positions[v + 5] = 0;

    ages[i * 2 + 0] = age;
    ages[i * 2 + 1] = age;
  }

  a.geometry.attributes.position.needsUpdate = true;
  a.geometry.attributes.age.needsUpdate = true;
}

export function init(scene) {
  group = new THREE.Group();

  material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      trailColor:   { value: new THREE.Color(0xffffff) },
      brightness:   { value: 1.0 },
      fadeExponent: { value: 1.6 },
      headGlow:     { value: 1.5 },
      crossFalloff: { value: CROSS_FALLOFF },
      hdrPeak:      { value: 2.5 },
    },
    // Pure additive (One/One). AdditiveBlending in three.js is
    // SrcAlpha/One, which would scale colors by alpha twice (we already
    // premultiplied in the shader). Using CustomBlending to match
    // Manifold's glBlendFunc(GL_ONE, GL_ONE) exactly.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide, // ribbon winding can flip at sharp turns
  });

  const aspect = 1080 / 1920;
  buildStructure(params, aspect);
  scene.add(group);
}

export function dispose(scene) {
  if (group) scene.remove(group);
  for (const a of agents) {
    if (a.geometry) a.geometry.dispose();
  }
  if (material) material.dispose();
  agents = [];
  group = null;
  material = null;
  cachedStructureKey = '';
}

export function mountGui(parent, { addModulated, addModulatedColor }) {
  const agentsFolder = parent.addFolder('agents');
  agentsFolder.add(params, 'lineCount', 1, 8, 1).name('line count');
  agentsFolder.add(params, 'trailLength', 20, 600, 1).name('trail length');
  addModulated(agentsFolder, params, modulation, 'speed', 'speed');
  addModulated(agentsFolder, params, modulation, 'lineWidth', 'line width');
  addModulated(agentsFolder, params, modulation, 'brightness', 'brightness');
  addModulated(agentsFolder, params, modulation, 'headGlow', 'head glow');
  addModulated(agentsFolder, params, modulation, 'fadeExponent', 'tail shape');
  // hdrPeak lifts the centerline past 1.0 in HDR so it blows out to
  // white via tone mapping. Non-modulatable: it's a structural color
  // choice, not something to wiggle on the beat.
  agentsFolder.add(params, 'hdrPeak', 1.0, 5.0, 0.05).name('HDR peak');
  addModulatedColor(agentsFolder, params, modulation, 'color', 'color');
  agentsFolder.open();

  const motionFolder = parent.addFolder('motion');
  addModulated(motionFolder, params, modulation, 'straightness', 'straightness');
  addModulated(motionFolder, params, modulation, 'curviness', 'curviness');
  addModulated(motionFolder, params, modulation, 'segmentLength', 'segment length');
  motionFolder.add(params, 'beatTurnAngle', 0, 180, 1).name('beat turn (°)');
  motionFolder.open();
}

export function update({ time, dt, audio, bus }) {
  const p = params;
  const m = modulation;

  // Structural rebuild (lineCount / trailLength changes)
  const key = `${p.lineCount}-${p.trailLength}`;
  if (key !== cachedStructureKey) {
    buildStructure(p, 1080 / 1920);
  }

  // Resolve modulated scalars for this frame
  const speed         = resolve(p.speed,         m.speed,         audio, bus);
  const lineWidth     = resolve(p.lineWidth,     m.lineWidth,     audio, bus);
  const brightness    = resolve(p.brightness,    m.brightness,    audio, bus);
  const headGlow      = resolve(p.headGlow,      m.headGlow,      audio, bus);
  const fadeExponent  = resolve(p.fadeExponent,  m.fadeExponent,  audio, bus);
  const straightness  = resolve(p.straightness,  m.straightness,  audio, bus);
  const curviness     = resolve(p.curviness,     m.curviness,     audio, bus);
  const segmentLength = resolve(p.segmentLength, m.segmentLength, audio, bus);

  // Push scalar uniforms (color set after hue-mod block below)
  material.uniforms.brightness.value   = Math.max(0, brightness);
  material.uniforms.fadeExponent.value = Math.max(0.05, fadeExponent);
  material.uniforms.headGlow.value     = Math.max(0, headGlow);
  material.uniforms.hdrPeak.value      = Math.max(1, p.hdrPeak);

  // Base color (with hue-shift modulation)
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
  material.uniforms.trailColor.value.copy(_tmpColor);

  // Convert pixel line width to world-space half-width for the ribbon
  // perpendicular offsets. Floor at 0.3 px so the line never disappears.
  const halfWidthWorld = Math.max(0.3, lineWidth) * PX_TO_WORLD_HALF;

  // Event-driven beat turn: read the global beat detector on the bus and,
  // on a fire, inject a ±beatTurnAngle heading delta per agent.
  const beatFired = bus.beatFired && p.beatTurnAngle > 0;
  const beatRad = p.beatTurnAngle * Math.PI / 180;

  const aspect = 1080 / 1920;
  const resolved = { speed, straightness, curviness, segmentLength };
  for (const a of agents) {
    if (beatFired) {
      const sign = Math.random() < 0.5 ? 1 : -1;
      a.theta += sign * beatRad;
      a.distSinceTurn = 0;
    }
    updateAgent(a, dt, time, resolved, aspect);
    writeRibbonBuffers(a, halfWidthWorld);
  }
}
