import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { resolve } from '../modulation.js';

/**
 * Light Painting
 *
 * Autonomous line agents that wander the canvas and leave fading trails,
 * the way a light-painting photograph captures long-exposure traces. Each
 * agent has a position + heading; on each frame its heading is nudged by a
 * path generator and it integrates forward by `speed * dt`. The last N
 * positions are kept in a ring buffer and rendered as a thick fading
 * `Line2` — head bright, tail decaying to black.
 *
 * Path generator — one axis, two modes blended by `straightness`:
 *   - Curvy (straightness=0): sum-of-sines drives a smoothly-varying
 *     angular velocity → spirals, conches, entropic wandering.
 *   - Architectural (straightness=1): heading is piecewise constant,
 *     snapping ±90° at distance intervals of `segmentLength` → the
 *     right-angle enclosures of the reference images.
 *   - In between: gently curving paths with occasional sharp corners.
 *
 * Distance-based snap turns keep speed and segment length decoupled — when
 * you speed the agents up, they don't start turning more often.
 *
 * Rendering uses Line2 (thick pixel-space lines with per-vertex color).
 * We allocate LineGeometry once per agent in init() and write directly to
 * the interleaved attribute buffers each frame (no per-frame GPU allocs).
 * `frustumCulled = false` because trails roam outside their initial bounds.
 *
 * Composes well with the global RadialTrailsPass: the primitive's fade
 * controls the trail *shape*, and the trails pass adds streaming-outward
 * *drift* on top.
 */

export const params = {
  // --- Non-modulatable (rebuilds agents / line geometry) ---
  lineCount: 3,
  trailLength: 220,

  // --- Agents (modulatable) ---
  speed: 0.55,            // world units / second
  lineWidth: 3.5,         // pixels (worldUnits: false)
  brightness: 1.0,        // overall intensity multiplier
  headGlow: 1.5,          // extra brightness bump at the head tip
  fadeExponent: 1.6,      // tail fade shape: 1=linear, >1 concentrates near head

  // --- Color ---
  color: '#ffffff',

  // --- Motion / path generator (modulatable) ---
  straightness: 0.0,      // 0 = curvy, 1 = architectural
  curviness: 1.4,         // amplitude of the curvy-mode angular velocity
  segmentLength: 0.35,    // world units between snap turns (architectural mode)

  // --- Beat turn ---
  // Injects a ±beatTurnAngle heading delta for every agent on each beat
  // event from the global bus (configure source/threshold/decay in the
  // modulators folder). Set to 0 to disable.
  beatTurnAngle: 90,      // degrees of heading delta per beat
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

// --- Internal state ---
let group = null;
let material = null;
let agents = [];
let cachedStructureKey = '';

/**
 * Create one agent at a random position within the canvas, with a random
 * initial heading and phase (so multiple agents don't move in lockstep).
 * Allocates a LineGeometry of fixed capacity and a Line2 sharing the
 * primitive's material.
 */
function makeAgent(p, aspect) {
  const N = p.trailLength;

  // Starting position: random point within a central region of the canvas
  const x = (Math.random() - 0.5) * aspect * 1.5;
  const y = (Math.random() - 0.5) * 1.6;

  const trailX = new Float32Array(N);
  const trailY = new Float32Array(N);
  // Initialize all trail points to the starting position so the line
  // starts as a degenerate point and fans out as the agent moves.
  trailX.fill(x);
  trailY.fill(y);

  const geometry = new LineGeometry();
  // Prime the interleaved buffers with zeros (6*(N-1) floats each) so
  // we can write to them directly every frame without reallocating.
  const initial = new Float32Array(N * 3); // [x,y,z, x,y,z, ...]
  geometry.setPositions(initial);
  geometry.setColors(new Float32Array(N * 3));

  const line = new Line2(geometry, material);
  line.frustumCulled = false; // trails wander outside initial bounds
  line.scale.set(1, 1, 1);

  return {
    x, y,
    theta: Math.random() * Math.PI * 2,
    phase: Math.random() * 100,
    distSinceTurn: 0,
    trailX,
    trailY,
    // Ring buffer head: index of the most recently written entry.
    // Oldest entry lives at (head + 1) % N.
    head: 0,
    geometry,
    line,
  };
}

/**
 * (Re)build all agents. Called on init and whenever lineCount or
 * trailLength change. Old agents' geometries are disposed before the
 * new ones are created to avoid GPU leaks on structural edits.
 */
function buildStructure(p, aspect) {
  for (const a of agents) {
    group.remove(a.line);
    a.geometry.dispose();
  }
  agents = [];

  for (let i = 0; i < p.lineCount; i++) {
    const a = makeAgent(p, aspect);
    group.add(a.line);
    agents.push(a);
  }
  cachedStructureKey = `${p.lineCount}-${p.trailLength}`;
}

/**
 * Curvy-mode angular velocity — sum of three sines at different rates so
 * the result doesn't repeat obviously. Amplitude is the `curviness` param.
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

  // --- Curvy component: smooth angular velocity, scaled by 1 - straightness
  const curvy = 1 - straightness;
  if (curvy > 0.001) {
    const omega = smoothOmega(time * 0.5, a.phase, curviness) * curvy;
    a.theta += omega * dt;
  }

  // --- Architectural component: distance-gated snap turns
  if (straightness > 0.01) {
    a.distSinceTurn += speed * dt;
    if (a.distSinceTurn >= segmentLength) {
      // Probability of actually turning at this interval scales with
      // straightness. Below ~0.5 we still allow sub-90 drift; above, we
      // snap the heading to the nearest cardinal before adding ±90 so
      // the path stays axis-aligned.
      if (Math.random() < straightness) {
        if (straightness > 0.5) {
          a.theta = Math.round(a.theta / (Math.PI / 2)) * (Math.PI / 2);
        }
        a.theta += (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2);
      }
      a.distSinceTurn = 0;
    }
  }

  // --- Integrate position
  a.x += Math.cos(a.theta) * speed * dt;
  a.y += Math.sin(a.theta) * speed * dt;

  // --- Bounce off canvas edges. Preserves ±90° headings in architectural
  // mode and gives clean reflections for curvy mode.
  const bx = aspect * 0.95;
  const by = 0.95;
  if (a.x < -bx) { a.x = -bx; a.theta = Math.PI - a.theta; }
  if (a.x >  bx) { a.x =  bx; a.theta = Math.PI - a.theta; }
  if (a.y < -by) { a.y = -by; a.theta = -a.theta; }
  if (a.y >  by) { a.y =  by; a.theta = -a.theta; }

  // --- Push onto ring buffer
  a.head = (a.head + 1) % a.trailX.length;
  a.trailX[a.head] = a.x;
  a.trailY[a.head] = a.y;
}

/**
 * Write an agent's current trail into the interleaved Line2 buffers.
 *
 * Format (see LineSegmentsGeometry.setPositions): stride 6, one "segment"
 * per adjacent pair of points. For N trail points there are N-1 segments,
 * each [x1, y1, z1, x2, y2, z2]. Same layout for colors.
 *
 * We walk the ring buffer from oldest → newest and write segment i as
 * (trail[i], trail[i+1]). Intensity ramps from 0 at oldest to
 * `(1 + headGlow)` at the head, shaped by fadeExponent.
 */
function writeTrailBuffers(a, color, brightness, headGlow, fadeExponent) {
  const N = a.trailX.length;
  const positions = a.geometry.attributes.instanceStart.data.array;
  const colors    = a.geometry.attributes.instanceColorStart.data.array;

  const oldest = (a.head + 1) % N;
  const br = color.r * brightness;
  const bg = color.g * brightness;
  const bb = color.b * brightness;

  // Helper: intensity at trail position t ∈ [0, 1] (0=oldest, 1=head)
  // - base fade: t^fadeExponent (linear at fe=1, concentrates near head for fe>1)
  // - head glow: sharp peak at the tip so the leading point feels alive
  function intensity(t) {
    const fade = Math.pow(t, fadeExponent);
    const glow = 1 + headGlow * Math.pow(t, 6);
    return fade * glow;
  }

  for (let seg = 0; seg < N - 1; seg++) {
    const iStart = (oldest + seg) % N;
    const iEnd   = (oldest + seg + 1) % N;

    // t at the two endpoints of this segment (0..1 across the whole trail)
    const tStart = seg / (N - 1);
    const tEnd   = (seg + 1) / (N - 1);
    const iA = intensity(tStart);
    const iB = intensity(tEnd);

    const p = seg * 6;
    positions[p    ] = a.trailX[iStart];
    positions[p + 1] = a.trailY[iStart];
    positions[p + 2] = 0;
    positions[p + 3] = a.trailX[iEnd];
    positions[p + 4] = a.trailY[iEnd];
    positions[p + 5] = 0;

    colors[p    ] = br * iA;
    colors[p + 1] = bg * iA;
    colors[p + 2] = bb * iA;
    colors[p + 3] = br * iB;
    colors[p + 4] = bg * iB;
    colors[p + 5] = bb * iB;
  }

  // Flag the shared InstancedInterleavedBuffers for GPU upload this frame.
  a.geometry.attributes.instanceStart.data.needsUpdate = true;
  a.geometry.attributes.instanceColorStart.data.needsUpdate = true;
}

export function init(scene) {
  group = new THREE.Group();

  material = new LineMaterial({
    vertexColors: true,
    linewidth: params.lineWidth,
    worldUnits: false,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    dashed: false,
  });
  // Required for pixel-space line width. We render at a fixed internal
  // 1080x1920 so this never needs updating at runtime.
  material.resolution.set(1080, 1920);

  const aspect = 1080 / 1920;
  buildStructure(params, aspect);
  scene.add(group);
}

/** Remove scene objects and free GPU resources. Paired with init(). */
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

/** Populate a lil-gui parent folder with this primitive's controls. */
export function mountGui(parent, { addModulated, addModulatedColor }) {
  const agentsFolder = parent.addFolder('agents');
  agentsFolder.add(params, 'lineCount', 1, 8, 1).name('line count');
  agentsFolder.add(params, 'trailLength', 20, 600, 1).name('trail length');
  addModulated(agentsFolder, params, modulation, 'speed', 'speed');
  addModulated(agentsFolder, params, modulation, 'lineWidth', 'line width');
  addModulated(agentsFolder, params, modulation, 'brightness', 'brightness');
  addModulated(agentsFolder, params, modulation, 'headGlow', 'head glow');
  addModulated(agentsFolder, params, modulation, 'fadeExponent', 'tail shape');
  addModulatedColor(agentsFolder, params, modulation, 'color', 'color');
  agentsFolder.open();

  const motionFolder = parent.addFolder('motion');
  addModulated(motionFolder, params, modulation, 'straightness', 'straightness');
  addModulated(motionFolder, params, modulation, 'curviness', 'curviness');
  addModulated(motionFolder, params, modulation, 'segmentLength', 'segment length');
  // Beat turn: plain scalar because it's consumed as an event trigger
  // (gated on bus.beatFired), not a continuous modulation. 0 disables.
  // Configure the beat source/threshold globally in the modulators folder.
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

  material.linewidth = Math.max(0.1, lineWidth);

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

  // Event-driven beat turn: read the global beat detector on the bus and,
  // on a fire, inject a ±beatTurnAngle heading delta per agent with a
  // random sign so they fly apart rather than pivoting in parallel.
  const beatFired = bus.beatFired && p.beatTurnAngle > 0;
  const beatRad = p.beatTurnAngle * Math.PI / 180;

  const aspect = 1080 / 1920;
  const resolved = { speed, straightness, curviness, segmentLength };
  for (const a of agents) {
    if (beatFired) {
      const sign = Math.random() < 0.5 ? 1 : -1;
      a.theta += sign * beatRad;
      // Reset the architectural-mode turn counter so the scheduled snap
      // doesn't fire immediately after the beat turn and produce a
      // doubled corner at the same spot.
      a.distSinceTurn = 0;
    }
    updateAgent(a, dt, time, resolved, aspect);
    writeTrailBuffers(a, _tmpColor, brightness, headGlow, fadeExponent);
  }
}
