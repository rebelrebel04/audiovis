/**
 * Built-in Preset Bank
 *
 * A curated collection of starting-point presets for each primitive,
 * seeded into the PresetStore on first launch. They're plain JSON (same
 * schema as user-saved presets) so they round-trip through the regular
 * load path without special casing.
 *
 * Each entry is a *partial* snapshot: we set only the fields we want to
 * override relative to code defaults. The `apply()` merge is key-by-key,
 * so any field we omit stays at the primitive's default, and we don't
 * have to enumerate every param just to tweak a few. Consequently, when
 * a new param gets added to a primitive in code, existing presets
 * inherit the new default automatically — nothing breaks.
 *
 * Seeding strategy — see seedBuiltins(): uses a monotonic version
 * counter in localStorage so that:
 *   - First launch seeds everything here.
 *   - Subsequent launches don't re-seed (user deletions stick).
 *   - Shipping a new batch later means bumping CURRENT_SEED and tagging
 *     new entries with a higher `seedVersion` — only those are added.
 */

import { PRESET_VERSION } from './presets.js';

const SEED_KEY = 'audiovis.presets.seed';
const CURRENT_SEED = 1;

/**
 * Small helper so each preset body reads like "primitive X with these
 * param / modulation overrides" instead of repeating boilerplate. The
 * `version` / `createdAt` fields match what snapshot() would produce so
 * an exported built-in looks identical to an exported user preset.
 */
function preset({ name, primitive, params, modulation, bus, posteffects, bloom, seedVersion = 1 }) {
  const body = {
    version: PRESET_VERSION,
    createdAt: new Date(0).toISOString(), // deterministic for built-ins
    primitive,
    primitives: {
      [primitive]: {
        params: params ?? {},
        modulation: modulation ?? {},
      },
    },
  };
  if (bus) body.bus = bus;
  if (posteffects) body.posteffects = posteffects;
  if (bloom) body.bloom = bloom;
  return { name, seedVersion, snapshot: body };
}

// =====================================================================
// POLYGON ENVELOPE
// =====================================================================

const POLYGON_PRESETS = [
  preset({
    name: '◆ classic triangle',
    primitive: 'polygon envelope',
    params: {
      sides: 3,
      envelopeCoverage: 1,
      lineCount: 90,
      polygonRadius: 0.78,
      lineOpacity: 0.55,
      color: '#ffffff',
      rotationSpeedX: 0.02,
      rotationSpeedY: 0.18,
      rotationSpeedZ: 0.015,
      phaseSpeed: 0.12,
      phaseAsymmetry: 0.5,
      globalTilt: 0.25,
    },
    modulation: {
      polygonRadius: { source: 'loud', amount: 0.08 },
      lineOpacity:   { source: 'high', amount: 0.12 },
      phaseSpeed:    { source: 'mid',  amount: 0.08 },
    },
    bloom: { strength: 1.1, radius: 0.8, threshold: 0.0 },
  }),

  preset({
    name: '◆ symmetric rosette',
    primitive: 'polygon envelope',
    params: {
      sides: 3,
      envelopeCoverage: 3,
      lineCount: 140,
      polygonRadius: 0.72,
      lineOpacity: 0.42,
      color: '#e8f4ff',
      rotationSpeedX: 0.01,
      rotationSpeedY: 0.08,
      rotationSpeedZ: 0.01,
      phaseSpeed: 0.08,
      phaseAsymmetry: 0.5,
      globalTilt: 0.0,
    },
    modulation: {
      polygonRadius: { source: 'loud',  amount: 0.10 },
      lineOpacity:   { source: 'high',  amount: 0.15 },
      rotationSpeedY:{ source: 'lfo-1', amount: 0.06 },
      phaseSpeed:    { source: 'mid',   amount: 0.06 },
      color:         { source: 'rand-1', amount: 0.08 },
    },
    bus: { randRate: 0.08, lfoRate: 0.15 },
    bloom: { strength: 1.2, radius: 1.0, threshold: 0.0 },
  }),

  preset({
    name: '◆ mandala crown',
    primitive: 'polygon envelope',
    params: {
      sides: 12,
      envelopeCoverage: 12,
      lineCount: 110,
      polygonRadius: 0.82,
      lineOpacity: 0.28,
      color: '#ffd9a8',
      rotationSpeedX: 0.0,
      rotationSpeedY: 0.05,
      rotationSpeedZ: 0.02,
      phaseSpeed: 0.06,
      phaseAsymmetry: 0.3,
      globalTilt: 0.0,
    },
    modulation: {
      polygonRadius:  { source: 'low',   amount: 0.12 },
      lineOpacity:    { source: 'high',  amount: 0.20 },
      rotationSpeedZ: { source: 'lfo-2', amount: 0.08 },
      phaseAsymmetry: { source: 'lfo-1', amount: 0.25 },
      color:          { source: 'rand-1', amount: 0.05 },
    },
    bus: { randRate: 0.04, lfoRate: 0.06, lfoRate2: 0.09 },
    bloom: { strength: 1.4, radius: 1.1, threshold: 0.0 },
  }),

  preset({
    name: '◆ chrome spinner',
    primitive: 'polygon envelope',
    params: {
      sides: 5,
      envelopeCoverage: 5,
      lineCount: 100,
      polygonRadius: 0.80,
      lineOpacity: 0.6,
      color: '#ffffff',
      rotationSpeedX: 0.05,
      rotationSpeedY: 0.55,
      rotationSpeedZ: 0.04,
      phaseSpeed: 0.22,
      phaseAsymmetry: 0.7,
      globalTilt: 0.4,
    },
    modulation: {
      polygonRadius:  { source: 'loud', amount: 0.10 },
      lineOpacity:    { source: 'high', amount: 0.20 },
      rotationSpeedY: { source: 'low',  amount: 0.20 },
      phaseSpeed:     { source: 'mid',  amount: 0.15 },
    },
    bloom: { strength: 1.6, radius: 0.7, threshold: 0.0 },
    posteffects: {
      params: { trailPersistence: 0.35, trailRadialPush: 0.0 },
      modulation: {
        trailPersistence: { source: '—', amount: 0.2 },
        trailRadialPush:  { source: '—', amount: 0.02 },
      },
    },
  }),
];

// =====================================================================
// PARTICLE RINGS
// =====================================================================

const PARTICLE_PRESETS = [
  preset({
    name: '✦ cosmic drift',
    primitive: 'particle rings',
    params: {
      ringCount: 18,
      particlesPerRing: 56,
      innerRadius: 0.28,
      outerRadius: 0.92,
      particleSize: 8,
      brightness: 0.7,
      color: '#cfe0ff',
      baseRotation: 0.035,
      twist: 0.35,
      radialBreath: 0.0,
      wobble: 0.04,
    },
    modulation: {
      outerRadius:  { source: 'loud',  amount: 0.08 },
      particleSize: { source: 'high',  amount: 5.0 },
      twist:        { source: 'lfo-1', amount: 0.4 },
      radialBreath: { source: 'low',   amount: 0.12 },
      wobble:       { source: 'lfo-2', amount: 0.08 },
    },
    bus: { lfoRate: 0.05, lfoRate2: 0.08 },
    bloom: { strength: 1.3, radius: 1.1, threshold: 0.0 },
  }),

  preset({
    name: '✦ galactic core',
    primitive: 'particle rings',
    params: {
      ringCount: 32,
      particlesPerRing: 96,
      innerRadius: 0.12,
      outerRadius: 1.05,
      particleSize: 12,
      brightness: 0.95,
      color: '#fff3c4',
      baseRotation: 0.12,
      twist: 1.1,
      radialBreath: 0.0,
      wobble: 0.0,
    },
    modulation: {
      outerRadius:  { source: 'loud', amount: 0.15 },
      particleSize: { source: 'high', amount: 9.0 },
      twist:        { source: 'mid',  amount: 0.8 },
      radialBreath: { source: 'low',  amount: 0.20 },
      color:        { source: 'rand-1', amount: 0.04 },
    },
    bus: { randRate: 0.03 },
    bloom: { strength: 1.8, radius: 0.9, threshold: 0.0 },
  }),

  preset({
    name: '✦ warp tunnel',
    primitive: 'particle rings',
    params: {
      ringCount: 22,
      particlesPerRing: 72,
      innerRadius: 0.08,
      outerRadius: 0.78,
      particleSize: 11,
      brightness: 0.85,
      color: '#a8e8ff',
      baseRotation: 0.18,
      twist: 0.85,
      radialBreath: 0.0,
      wobble: 0.0,
    },
    modulation: {
      outerRadius:  { source: 'loud', amount: 0.15 },
      particleSize: { source: 'high', amount: 7.0 },
      twist:        { source: 'mid',  amount: 1.0 },
      radialBreath: { source: 'low',  amount: 0.15 },
    },
    bloom: { strength: 1.5, radius: 0.8, threshold: 0.0 },
    posteffects: {
      params: { trailPersistence: 0.82, trailRadialPush: 0.045 },
      modulation: {
        trailPersistence: { source: '—',    amount: 0.05 },
        trailRadialPush:  { source: 'loud', amount: 0.04 },
      },
    },
  }),

  preset({
    name: '✦ stardust pulse',
    primitive: 'particle rings',
    params: {
      ringCount: 20,
      particlesPerRing: 64,
      innerRadius: 0.2,
      outerRadius: 0.88,
      particleSize: 7,
      brightness: 0.8,
      color: '#ffb3e6',
      baseRotation: 0.06,
      twist: 0.5,
      radialBreath: 0.0,
      wobble: 0.0,
    },
    modulation: {
      // Beat-forward: particle size spikes on kick, radius breathes on beat.
      outerRadius:  { source: 'beat', amount: 0.18 },
      particleSize: { source: 'beat', amount: 14.0 },
      twist:        { source: 'mid',  amount: 0.5 },
      radialBreath: { source: 'low',  amount: 0.10 },
      color:        { source: 'rand-1', amount: 0.06 },
    },
    bus: {
      beatSource: 'low',
      beatThreshold: 0.4,
      beatDecay: 5.0,
      randRate: 0.1,
    },
    bloom: { strength: 1.5, radius: 1.0, threshold: 0.0 },
    posteffects: {
      params: { trailPersistence: 0.55, trailRadialPush: 0.01 },
      modulation: {
        trailPersistence: { source: '—', amount: 0.10 },
        trailRadialPush:  { source: '—', amount: 0.02 },
      },
    },
  }),
];

// =====================================================================
// LIGHT PAINTING
// =====================================================================

const LIGHT_PRESETS = [
  preset({
    name: '✎ architectural maze',
    primitive: 'light painting',
    params: {
      lineCount: 2,
      trailLength: 280,
      speed: 0.55,
      lineWidth: 2.8,
      brightness: 1.0,
      headGlow: 2.0,
      fadeExponent: 1.4,
      color: '#ffffff',
      straightness: 1.0,
      curviness: 0.0,
      segmentLength: 0.38,
      beatTurnAngle: 0,
    },
    modulation: {
      speed:     { source: 'mid',  amount: 0.25 },
      lineWidth: { source: 'high', amount: 2.5 },
      curviness: { source: '—',    amount: 0.0 },
    },
    bloom: { strength: 1.2, radius: 0.6, threshold: 0.0 },
  }),

  preset({
    name: '✎ flowing calligraphy',
    primitive: 'light painting',
    params: {
      lineCount: 1,
      trailLength: 420,
      speed: 0.42,
      lineWidth: 4.5,
      brightness: 1.0,
      headGlow: 2.2,
      fadeExponent: 1.8,
      color: '#fff0cc',
      straightness: 0.0,
      curviness: 1.6,
      segmentLength: 0.3,
      beatTurnAngle: 0,
    },
    modulation: {
      speed:     { source: 'mid',  amount: 0.20 },
      lineWidth: { source: 'high', amount: 3.0 },
      curviness: { source: 'loud', amount: 1.5 },
      color:     { source: 'rand-1', amount: 0.08 },
    },
    bus: { randRate: 0.05 },
    bloom: { strength: 1.5, radius: 1.0, threshold: 0.0 },
  }),

  preset({
    name: '✎ neon graffiti',
    primitive: 'light painting',
    params: {
      lineCount: 4,
      trailLength: 220,
      speed: 0.75,
      lineWidth: 3.0,
      brightness: 1.0,
      headGlow: 2.5,
      fadeExponent: 1.6,
      color: '#ff4fb0',
      straightness: 0.35,
      curviness: 1.2,
      segmentLength: 0.28,
      beatTurnAngle: 0,
    },
    modulation: {
      speed:     { source: 'mid',  amount: 0.35 },
      lineWidth: { source: 'high', amount: 3.5 },
      curviness: { source: 'loud', amount: 1.3 },
      color:     { source: 'rand-1', amount: 0.25 },
    },
    bus: { randRate: 0.15 },
    bloom: { strength: 1.7, radius: 0.9, threshold: 0.0 },
  }),

  preset({
    name: '✎ beat jolt',
    primitive: 'light painting',
    params: {
      lineCount: 3,
      trailLength: 240,
      speed: 0.55,
      lineWidth: 3.2,
      brightness: 1.0,
      headGlow: 2.0,
      fadeExponent: 1.5,
      color: '#8ff0ff',
      straightness: 0.5,
      curviness: 1.0,
      segmentLength: 0.35,
      beatTurnAngle: 110,
    },
    modulation: {
      speed:     { source: 'mid',  amount: 0.30 },
      lineWidth: { source: 'beat', amount: 4.0 },
      curviness: { source: 'loud', amount: 1.0 },
    },
    bus: {
      beatSource: 'low',
      beatThreshold: 0.35,
      beatDecay: 6.0,
    },
    bloom: { strength: 1.4, radius: 0.8, threshold: 0.0 },
  }),

  preset({
    name: '✎ zen ink wash',
    primitive: 'light painting',
    params: {
      lineCount: 1,
      trailLength: 520,
      speed: 0.28,
      lineWidth: 5.0,
      brightness: 0.85,
      headGlow: 1.8,
      fadeExponent: 2.4,
      color: '#e0e0e0',
      straightness: 0.15,
      curviness: 1.1,
      segmentLength: 0.5,
      beatTurnAngle: 0,
    },
    modulation: {
      speed:        { source: '—',    amount: 0.0 },
      lineWidth:    { source: 'loud', amount: 2.0 },
      curviness:    { source: 'lfo-1', amount: 0.8 },
      fadeExponent: { source: '—',    amount: 0.0 },
    },
    bus: { lfoRate: 0.04 },
    bloom: { strength: 1.0, radius: 1.1, threshold: 0.0 },
    posteffects: {
      params: { trailPersistence: 0.25, trailRadialPush: 0.0 },
      modulation: {
        trailPersistence: { source: '—', amount: 0.05 },
        trailRadialPush:  { source: '—', amount: 0.01 },
      },
    },
  }),
];

// =====================================================================
// EXPORT
// =====================================================================

export const PRESET_BANK = [
  ...POLYGON_PRESETS,
  ...PARTICLE_PRESETS,
  ...LIGHT_PRESETS,
];

/**
 * Seed built-in presets into the store. Idempotent across launches:
 * uses a monotonic seed version in localStorage so each batch of
 * built-ins is written at most once. User deletions survive — we don't
 * re-add presets from a seed version already processed.
 *
 * To ship new built-ins later: add them to PRESET_BANK tagged with a
 * higher `seedVersion`, and bump CURRENT_SEED. Existing entries stay
 * put; only the new ones are installed on next launch.
 */
export function seedBuiltins(store) {
  let lastSeed = 0;
  try {
    lastSeed = parseInt(localStorage.getItem(SEED_KEY) || '0', 10) || 0;
  } catch {}
  if (lastSeed >= CURRENT_SEED) return;

  let added = 0;
  for (const entry of PRESET_BANK) {
    const sv = entry.seedVersion ?? 1;
    if (sv <= lastSeed) continue;
    // Only add if not currently present — lets a user rename a built-in
    // without us silently re-installing the original on next launch.
    if (store.load(entry.name)) continue;
    store.save(entry.name, entry.snapshot);
    added++;
  }

  try {
    localStorage.setItem(SEED_KEY, String(CURRENT_SEED));
  } catch {}

  if (added > 0) {
    console.log(`[presets] seeded ${added} built-in presets`);
  }
}
