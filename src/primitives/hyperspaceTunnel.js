import * as THREE from 'three';
import { resolve } from '../modulation.js';

/**
 * Hyperspace Tunnel
 *
 * A field of glowing streaks rushing out from a central vanishing point —
 * the classic "warp speed" / wormhole travel effect. Each streak is a
 * short line in 3D space along the depth axis; a hand-rolled perspective
 * projection in the vertex shader (`screen.xy = world.xy / world.z * fov`)
 * makes streaks far away project near screen center and small, while
 * streaks close to camera project past the screen edges and large.
 *
 * As nearZ decreases each frame, every streak sweeps outward radially.
 * Each streak's near and far endpoints project to different screen radii
 * along the same radial line, so the streak is naturally elongated in the
 * radial direction — no "speed line" hack needed; the perspective math
 * just produces it.
 *
 * --- Architecture ---
 * Single InstancedBufferGeometry: one 4-vertex base quad shared across
 * all streaks, with per-instance attributes:
 *   iNearPos (vec3)  - (x, y, z) of the streak's near end. CPU writes this
 *                       every frame: z decreases by speed*dt; when
 *                       z < zMinClip, respawn at zFar with new (x, y).
 *   iSeed    (float) - random 0..1, drives per-streak hue and sparkle.
 *
 * Vertex shader uses two per-vertex attributes (u ∈ {±1}, isFar ∈ {0, 1})
 * to know which corner of the streak quad it's drawing.
 *
 * --- Rendering recipe ---
 * Same Manifold-style techniques used elsewhere:
 *   - Cross-streak alpha falloff via the u attribute → soft-edged neon tube
 *   - HDR core (color * hdrPeak) → ACES tone-maps centerline to white
 *   - Per-streak sparkle phase from iSeed
 *   - Hue gradient based on depth (zT) + per-streak seed offset
 * The existing HDR composer + ProgressiveBloomPass do the rest.
 *
 * --- Beat burst ---
 * On bus.beatFired, internal `speedBurst` jumps to `beatBurst` and decays
 * over time. Effective speed each frame = speed * (1 + speedBurst). Gives
 * a satisfying "kick" on the beat without changing direction.
 */

export const params = {
  // --- Non-modulatable structure (changes rebuild the buffer) ---
  streakCount: 600,

  // --- Geometry / motion (modulatable) ---
  speed: 4.0,             // z-units per second (tunnel travel speed)
  streakLength: 0.5,      // z-extent of each streak — longer = more motion-blur feel
  innerRadius: 0.4,       // streak spawn annulus, near edge
  outerRadius: 1.2,       // streak spawn annulus, far edge
  lineWidth: 2.0,         // pixel width of each streak ribbon
  brightness: 1.0,
  sparkle: 0.4,

  // --- Color ---
  color: '#a8c8ff',       // cool blue default — the canonical hyperspace hue
  hueSpread: 0.15,        // depth-driven hue rotation (positive = far redder, near bluer)

  // --- HDR / structural ---
  hdrPeak: 2.5,
  fadeFalloff: 1.4,       // cross-streak edge softness (same role as crossFalloff in lightPainting)

  // --- Beat burst ---
  beatBurst: 0.0,         // 0 disables. >0 = multiplicative speed kick on beat fire.
  beatBurstDecay: 3.0,    // exponential decay rate of the burst (1/sec)
};

export const modulation = {
  speed:        { source: '—',    amount: 2.00, min: 0.0,  max: 20.0, step: 0.05 },
  streakLength: { source: '—',    amount: 0.50, min: 0.05, max: 3.0,  step: 0.01 },
  innerRadius:  { source: '—',    amount: 0.30, min: 0.0,  max: 2.0,  step: 0.01 },
  outerRadius:  { source: 'loud', amount: 0.30, min: 0.2,  max: 3.0,  step: 0.01 },
  lineWidth:    { source: 'high', amount: 3.0,  min: 0.3,  max: 12.0, step: 0.05 },
  brightness:   { source: '—',    amount: 0.30, min: 0.0,  max: 2.0,  step: 0.01 },
  sparkle:      { source: '—',    amount: 0.30, min: 0.0,  max: 1.0,  step: 0.01 },

  color:        { source: '—',    amount: 0.10, kind: 'color' },
};

// Tunnel depth range. Hardcoded — exposing them as params would just let
// users break things; the real shape control is via the spawn radii and
// streak length. zMinClip is where streaks respawn (just behind camera);
// zFar is the spawn point.
const Z_MIN_CLIP = 0.06;
const Z_FAR = 8.0;
// Field-of-view scale — smaller compresses the tunnel, larger fans it out.
// 0.6 produces a comfortable mid-vista FOV.
const FOV_SCALE = 0.6;

// Scratch
const _tmpColor = new THREE.Color();
const _tmpHsl = { h: 0, s: 0, l: 0 };

// --- Shaders ---
//
// Vertex shader skips three.js's camera matrices entirely — we compute
// clip-space coordinates directly via our own perspective math, since
// the primitive owns its own depth model. The outer ortho camera is just
// the canvas; we render straight to NDC and let it pass through.
const VERT = /* glsl */ `
  in float u;
  in float isFar;
  in vec3 iNearPos;
  in float iSeed;
  out float vU;
  out float vDepthT;
  out float vNearZ;
  out float vSeed;

  uniform float streakLength;
  uniform float fovScale;
  uniform float aspect;
  uniform float halfWidthPx;
  uniform vec2 resolution;
  uniform float zMinClip;

  void main() {
    // World position of this corner: same x,y as streak's near end,
    // z = nearZ + isFar * streakLength.
    vec3 wp = iNearPos;
    wp.z += isFar * streakLength;

    // Clamp z to prevent divide-by-zero / huge values when streak is
    // very close to camera. Fragment shader fades alpha at small z anyway.
    float z = max(wp.z, zMinClip);

    // Hand-rolled perspective: screen-space xy = world.xy / z * fov.
    // Screen units here are aspect-corrected (square pixels).
    vec2 sp = wp.xy / z * fovScale;

    // Cross-streak perpendicular: perpendicular to the radial direction
    // in screen space. radialDir is just sp (pointing from center outward),
    // so perpendicular is (-sp.y, sp.x) normalized. Constant for both ends
    // of a streak, since both ends share x,y in world space.
    vec2 radDir = sp;
    float radL = length(radDir);
    vec2 perp = radL > 1e-6 ? vec2(-radDir.y, radDir.x) / radL : vec2(1.0, 0.0);

    // Half-width in screen-NDC units. Resolution.y px maps to 2 NDC units
    // (y range -1..1), so 1 px = 2/resolution.y. Width is in same units
    // as screen y because pixels are square.
    float hw = halfWidthPx * 2.0 / resolution.y;

    vec2 finalPos = sp + perp * u * hw;

    // Convert to clip space. Ortho camera maps x ∈ [-aspect, aspect] to
    // NDC x ∈ [-1, 1], so we divide by aspect to bake that in.
    gl_Position = vec4(finalPos.x / aspect, finalPos.y, 0.0, 1.0);

    vU = u;
    vDepthT = isFar;
    vNearZ = iNearPos.z;
    vSeed = iSeed;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  in float vU;
  in float vDepthT;
  in float vNearZ;
  in float vSeed;
  out vec4 fragColor;

  uniform vec3 baseColor;
  uniform float brightness;
  uniform float hdrPeak;
  uniform float fadeFalloff;
  uniform float sparkle;
  uniform float sparkleRate;
  uniform float hueSpread;
  uniform float time;
  uniform float zMinClip;
  uniform float zFar;

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
    // Cross-streak (u-direction) edge falloff. Center of strip is u=0,
    // edges are u=±1. Soft tube shape, same trick as lightPainting.
    float edge = 1.0 - vU * vU;
    float crossA = pow(max(edge, 0.0), fadeFalloff);

    // Depth-based fade: streaks fade in at the far end (just-spawned)
    // and fade out at zMinClip (about to cross camera). zT ∈ [0,1]
    // where 0 is at clip plane and 1 is at spawn distance.
    float zT = clamp((vNearZ - zMinClip) / (zFar - zMinClip), 0.0, 1.0);
    // Fade in over the last ~12% of approach (just-spawned), and fade
    // out over the last ~5% near the camera. Asymmetric: most of the
    // streak's lifetime is at full brightness rushing past you.
    float fadeIn  = smoothstep(1.0, 0.88, zT);
    float fadeOut = smoothstep(0.0, 0.05, zT);
    float depthA  = fadeIn * fadeOut;

    // Along-streak intensity: brighter at the near end (the "head" of the
    // streak as it flies past), dimmer at the far end (the "tail"). isFar
    // is 0 at near end, 1 at far end → multiply by (1 - 0.55*isFar).
    float alongA = 1.0 - 0.55 * vDepthT;

    // Per-streak sparkle.
    float twink = 1.0 + sparkle * 0.5 * sin(time * sparkleRate + vSeed * 6.2831853);

    // Hue rotation: depth + per-streak seed. (zT - 0.5) so hueSpread=0
    // means no shift; positive shifts far streaks one way, near the other.
    vec3 hsv = rgb2hsv(baseColor);
    hsv.x = fract(hsv.x + (zT - 0.5) * hueSpread + (vSeed - 0.5) * 0.08 + 1.0);
    vec3 col = hsv2rgb(hsv);

    float a = crossA * depthA * alongA;
    vec3 outRgb = col * brightness * hdrPeak * twink;
    // Premultiplied; pure-additive blending below.
    fragColor = vec4(outRgb * a, a);
  }
`;

// --- Internal state ---
let group = null;
let geometry = null;
let material = null;
let mesh = null;
let cachedKey = '';

// Per-streak ring buffer: nearZ values + (x, y) angular positions.
// Repacked into the InstancedBufferAttribute every frame.
let nearPosArray = null;
let seedArray = null;
let streakAngles = null; // cached angle per streak — used on respawn
let streakRadii = null;

// Beat burst state
let speedBurst = 0;

const RESOLUTION_X = 1080;
const RESOLUTION_Y = 1920;
const ASPECT = RESOLUTION_X / RESOLUTION_Y;

/** Spawn a streak at zFar with a fresh angle/radius. */
function spawnStreak(idx, p) {
  const a = Math.random() * Math.PI * 2;
  const r = p.innerRadius + Math.random() * (p.outerRadius - p.innerRadius);
  streakAngles[idx] = a;
  streakRadii[idx] = r;
  nearPosArray[idx * 3 + 0] = Math.cos(a) * r;
  nearPosArray[idx * 3 + 1] = Math.sin(a) * r;
  // Distribute initial nearZ uniformly across the tunnel so we don't see a
  // single "wave" of all streaks marching together. After this initial
  // build, all respawns happen at zFar.
  nearPosArray[idx * 3 + 2] = Z_FAR; // overwritten in build path below
}

/** Build the InstancedBufferGeometry for the current streakCount. */
function buildGeometry(p) {
  const N = p.streakCount;

  if (geometry) geometry.dispose();
  geometry = new THREE.InstancedBufferGeometry();

  // Per-vertex base quad (4 corners of one streak).
  // Vertex 0: u=+1, isFar=0  (near end, top)
  // Vertex 1: u=-1, isFar=0  (near end, bottom)
  // Vertex 2: u=+1, isFar=1  (far end, top)
  // Vertex 3: u=-1, isFar=1  (far end, bottom)
  const u = new Float32Array([+1, -1, +1, -1]);
  const isFar = new Float32Array([0, 0, 1, 1]);
  geometry.setAttribute('u', new THREE.BufferAttribute(u, 1));
  geometry.setAttribute('isFar', new THREE.BufferAttribute(isFar, 1));
  // Two triangles: (0,1,2) and (1,3,2) — same winding pattern as the
  // lightPainting ribbon segments.
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 1, 3, 2]), 1));

  // Per-instance attributes
  nearPosArray = new Float32Array(N * 3);
  seedArray = new Float32Array(N);
  streakAngles = new Float32Array(N);
  streakRadii = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    spawnStreak(i, p);
    // Initial z spread: uniform across [zMinClip, zFar) so the tunnel is
    // already populated when init() finishes (no "wave" startup).
    nearPosArray[i * 3 + 2] = Z_MIN_CLIP + Math.random() * (Z_FAR - Z_MIN_CLIP);
    seedArray[i] = Math.random();
  }

  geometry.setAttribute('iNearPos', new THREE.InstancedBufferAttribute(nearPosArray, 3));
  geometry.setAttribute('iSeed',    new THREE.InstancedBufferAttribute(seedArray, 1));
  geometry.instanceCount = N;

  // Bypass culling — we're emitting clip-space coords directly, so the
  // bounding sphere isn't meaningful.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

  cachedKey = `${N}`;
}

export function init(scene) {
  group = new THREE.Group();

  material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      baseColor:    { value: new THREE.Color(params.color) },
      brightness:   { value: 1.0 },
      hdrPeak:      { value: params.hdrPeak },
      fadeFalloff:  { value: params.fadeFalloff },
      sparkle:      { value: params.sparkle },
      sparkleRate:  { value: 2.5 },
      hueSpread:    { value: params.hueSpread },
      time:         { value: 0 },
      streakLength: { value: params.streakLength },
      fovScale:     { value: FOV_SCALE },
      aspect:       { value: ASPECT },
      halfWidthPx:  { value: params.lineWidth * 0.5 },
      resolution:   { value: new THREE.Vector2(RESOLUTION_X, RESOLUTION_Y) },
      zMinClip:     { value: Z_MIN_CLIP },
      zFar:         { value: Z_FAR },
    },
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
    side: THREE.DoubleSide,
  });

  buildGeometry(params);
  mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  group.add(mesh);
  scene.add(group);

  speedBurst = 0;
}

export function dispose(scene) {
  if (group) scene.remove(group);
  if (geometry) geometry.dispose();
  if (material) material.dispose();
  geometry = null;
  material = null;
  mesh = null;
  group = null;
  cachedKey = '';
}

export function mountGui(parent, { addModulated, addModulatedColor }) {
  const tunnel = parent.addFolder('tunnel');
  tunnel.add(params, 'streakCount', 50, 3000, 10).name('streak count');
  addModulated(tunnel, params, modulation, 'speed', 'speed (z/s)');
  addModulated(tunnel, params, modulation, 'streakLength', 'streak length');
  addModulated(tunnel, params, modulation, 'innerRadius', 'inner radius');
  addModulated(tunnel, params, modulation, 'outerRadius', 'outer radius');
  addModulated(tunnel, params, modulation, 'lineWidth', 'line width');
  addModulated(tunnel, params, modulation, 'brightness', 'brightness');
  tunnel.add(params, 'hdrPeak', 1.0, 5.0, 0.05).name('HDR peak');
  tunnel.add(params, 'fadeFalloff', 0.5, 4.0, 0.05).name('edge softness');
  tunnel.open();

  const colorFolder = parent.addFolder('color');
  addModulatedColor(colorFolder, params, modulation, 'color', 'color');
  colorFolder.add(params, 'hueSpread', -1.0, 1.0, 0.01).name('hue spread (depth)');
  colorFolder.open();

  const sparkleFolder = parent.addFolder('sparkle');
  addModulated(sparkleFolder, params, modulation, 'sparkle', 'amount');
  sparkleFolder.add(material.uniforms.sparkleRate, 'value', 0, 8, 0.05).name('rate (Hz)');
  sparkleFolder.open();

  const beat = parent.addFolder('beat burst');
  beat.add(params, 'beatBurst', 0, 5, 0.05).name('strength');
  beat.add(params, 'beatBurstDecay', 0.5, 10, 0.1).name('decay (1/s)');
  beat.open();
}

export function update({ time, dt, audio, bus }) {
  const p = params;
  const m = modulation;

  // Structural rebuild
  const key = `${p.streakCount}`;
  if (key !== cachedKey) {
    buildGeometry(p);
    mesh.geometry = geometry;
  }

  // Resolve modulatable scalars
  const speed        = resolve(p.speed,        m.speed,        audio, bus);
  const streakLength = resolve(p.streakLength, m.streakLength, audio, bus);
  const innerRadius  = resolve(p.innerRadius,  m.innerRadius,  audio, bus);
  const outerRadius  = resolve(p.outerRadius,  m.outerRadius,  audio, bus);
  const lineWidth    = resolve(p.lineWidth,    m.lineWidth,    audio, bus);
  const brightness   = resolve(p.brightness,   m.brightness,   audio, bus);
  const sparkle      = resolve(p.sparkle,      m.sparkle,      audio, bus);

  // Beat burst: on fire, snap speedBurst to beatBurst; decay otherwise.
  if (bus.beatFired && p.beatBurst > 0) {
    speedBurst = p.beatBurst;
  } else if (speedBurst > 0) {
    speedBurst *= Math.exp(-p.beatBurstDecay * dt);
    if (speedBurst < 1e-3) speedBurst = 0;
  }

  // Effective speed includes the current burst factor
  const effectiveSpeed = speed * (1 + speedBurst);

  // Advance every streak's nearZ. Respawn at zFar when we cross the
  // camera (z < zMinClip). Use cached angles/radii so respawned streaks
  // get a fresh angular position; speed-and-respawn is the only CPU work
  // per frame.
  const N = p.streakCount;
  // Cache the spawn radius range — innerRadius/outerRadius can be
  // modulated, so the band is updated only at respawn time (not retroactive).
  const safeInner = Math.min(innerRadius, outerRadius - 0.01);
  for (let i = 0; i < N; i++) {
    const zi = i * 3 + 2;
    let z = nearPosArray[zi] - effectiveSpeed * dt;
    if (z < Z_MIN_CLIP) {
      // Respawn at far end with fresh angle/radius
      const a = Math.random() * Math.PI * 2;
      const r = safeInner + Math.random() * (outerRadius - safeInner);
      nearPosArray[i * 3 + 0] = Math.cos(a) * r;
      nearPosArray[i * 3 + 1] = Math.sin(a) * r;
      streakAngles[i] = a;
      streakRadii[i] = r;
      z = Z_FAR;
    }
    nearPosArray[zi] = z;
  }
  geometry.attributes.iNearPos.needsUpdate = true;

  // Push uniforms
  const u = material.uniforms;
  u.brightness.value   = Math.max(0, brightness);
  u.streakLength.value = Math.max(0.01, streakLength);
  u.halfWidthPx.value  = Math.max(0.3, lineWidth) * 0.5;
  u.hdrPeak.value      = Math.max(1, p.hdrPeak);
  u.fadeFalloff.value  = Math.max(0.1, p.fadeFalloff);
  u.sparkle.value      = Math.max(0, Math.min(1, sparkle));
  u.hueSpread.value    = p.hueSpread;
  u.time.value         = time;

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
  u.baseColor.value.copy(_tmpColor);
}
