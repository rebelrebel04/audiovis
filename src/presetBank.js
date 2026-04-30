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
// Note: we don't carry a `CURRENT_SEED` constant — the "latest version"
// is derived from `max(seedVersion)` across PRESET_BANK at runtime (see
// seedBuiltins). This is more robust than a separate constant: during
// module hot-reload races, an old presetBank.js with only v1 entries can
// briefly resolve while a newer CURRENT_SEED constant has already taken
// effect, causing the seed counter to bump past entries that aren't in
// the loaded bank yet — they then get permanently skipped on subsequent
// launches. Deriving the target from the bank itself eliminates that.

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
// HYPERSPACE TUNNEL (seed version 2)
// =====================================================================

const HYPERSPACE_PRESETS = [
  preset({
    name: '🌌 classic warp',
    primitive: 'hyperspace tunnel',
    seedVersion: 2,
    params: {
      streakCount: 600,
      speed: 4.5,
      streakLength: 0.55,
      innerRadius: 0.35,
      outerRadius: 1.25,
      lineWidth: 2.2,
      brightness: 1.0,
      sparkle: 0.35,
      color: '#a8c8ff',
      hueSpread: 0.18,
      hdrPeak: 2.5,
      fadeFalloff: 1.4,
      beatBurst: 0.0,
    },
    modulation: {
      outerRadius: { source: 'loud', amount: 0.30 },
      lineWidth:   { source: 'high', amount: 2.0 },
      speed:       { source: 'low',  amount: 1.5 },
    },
    bloom: { strength: 3.0, radius: 1.0, threshold: 0.0 },
    posteffects: {
      params: { trailPersistence: 0.0, trailRadialPush: 0.0 },
      modulation: {
        trailPersistence: { source: '—', amount: 0.05 },
        trailRadialPush:  { source: '—', amount: 0.01 },
      },
    },
  }),

  preset({
    name: '🌌 beat hyperdrive',
    primitive: 'hyperspace tunnel',
    seedVersion: 2,
    params: {
      // Dense, fast, beat-kicked. Halftime kick tracks land beautifully.
      streakCount: 900,
      speed: 3.2,
      streakLength: 0.7,
      innerRadius: 0.25,
      outerRadius: 1.4,
      lineWidth: 2.5,
      brightness: 1.0,
      sparkle: 0.25,
      color: '#9fb4ff',
      hueSpread: 0.22,
      hdrPeak: 2.8,
      fadeFalloff: 1.3,
      // Each beat punches a 2.5x speed kick decaying over ~0.5s.
      beatBurst: 2.5,
      beatBurstDecay: 4.5,
    },
    modulation: {
      outerRadius: { source: 'loud', amount: 0.25 },
      lineWidth:   { source: 'high', amount: 3.0 },
      brightness:  { source: 'beat', amount: 0.40 },
    },
    bus: {
      beatSource: 'low',
      beatThreshold: 0.4,
      beatDecay: 5.0,
    },
    bloom: { strength: 3.5, radius: 1.0, threshold: 0.0 },
    posteffects: {
      params: { trailPersistence: 0.25, trailRadialPush: 0.005 },
      modulation: {
        trailPersistence: { source: '—',    amount: 0.10 },
        trailRadialPush:  { source: 'loud', amount: 0.015 },
      },
    },
  }),

  preset({
    name: '🌌 rainbow vortex',
    primitive: 'hyperspace tunnel',
    seedVersion: 2,
    params: {
      // High hue spread + per-streak seed variation = colorful tunnel.
      streakCount: 800,
      speed: 3.8,
      streakLength: 0.6,
      innerRadius: 0.3,
      outerRadius: 1.3,
      lineWidth: 2.4,
      brightness: 1.0,
      sparkle: 0.5,
      color: '#ff6ad9',          // saturated magenta as the base; hueSpread fans it
      hueSpread: 0.55,           // wide depth-driven hue rotation
      hdrPeak: 2.6,
      fadeFalloff: 1.4,
      beatBurst: 0.0,
    },
    modulation: {
      outerRadius: { source: 'loud',  amount: 0.25 },
      lineWidth:   { source: 'high',  amount: 2.5 },
      sparkle:     { source: 'lfo-1', amount: 0.30 },
      color:       { source: 'rand-1', amount: 0.15 },
    },
    bus: { lfoRate: 0.08, randRate: 0.05 },
    bloom: { strength: 3.2, radius: 1.1, threshold: 0.0 },
  }),

  preset({
    name: '🌌 zen drift',
    primitive: 'hyperspace tunnel',
    seedVersion: 2,
    params: {
      // Slow, contemplative — feels like floating, not racing.
      streakCount: 350,
      speed: 1.2,
      streakLength: 0.85,        // long streaks at slow speed = elegant trails
      innerRadius: 0.2,
      outerRadius: 1.0,
      lineWidth: 2.8,
      brightness: 0.85,
      sparkle: 0.6,
      color: '#cce0ff',
      hueSpread: 0.1,
      hdrPeak: 2.2,
      fadeFalloff: 1.6,          // softer edges
      beatBurst: 0.0,
    },
    modulation: {
      outerRadius:  { source: 'lfo-1', amount: 0.15 },
      lineWidth:    { source: 'high',  amount: 1.5 },
      brightness:   { source: 'loud',  amount: 0.20 },
      sparkle:      { source: 'lfo-2', amount: 0.30 },
    },
    bus: { lfoRate: 0.03, lfoRate2: 0.07 },
    bloom: { strength: 2.2, radius: 1.2, threshold: 0.0 },
  }),

  preset({
    name: '🌌 plasma storm',
    primitive: 'hyperspace tunnel',
    seedVersion: 2,
    params: {
      // Maxed-out chaos — high count, fast, wide, hot magenta/orange.
      streakCount: 1400,
      speed: 6.5,
      streakLength: 0.4,         // shorter streaks at high speed = dense flecks
      innerRadius: 0.15,
      outerRadius: 1.5,
      lineWidth: 1.6,
      brightness: 1.0,
      sparkle: 0.45,
      color: '#ff7a3a',          // hot orange base
      hueSpread: 0.4,            // fans toward magenta at depth
      hdrPeak: 3.0,              // extra blowout
      fadeFalloff: 1.2,          // crisper edges suit the chaos
      beatBurst: 1.5,
      beatBurstDecay: 5.5,
    },
    modulation: {
      outerRadius: { source: 'loud', amount: 0.40 },
      lineWidth:   { source: 'high', amount: 3.0 },
      speed:       { source: 'mid',  amount: 2.5 },
      brightness:  { source: 'beat', amount: 0.30 },
    },
    bus: {
      beatSource: 'low',
      beatThreshold: 0.5,
      beatDecay: 6.0,
    },
    bloom: { strength: 3.8, radius: 0.9, threshold: 0.0 },
    posteffects: {
      params: { trailPersistence: 0.35, trailRadialPush: 0.012 },
      modulation: {
        trailPersistence: { source: '—',    amount: 0.10 },
        trailRadialPush:  { source: 'loud', amount: 0.02 },
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
  ...HYPERSPACE_PRESETS,
];

/**
 * Seed built-in presets into the store. Idempotent across launches:
 * uses a monotonic seed version in localStorage so each batch of
 * built-ins is written at most once. User deletions survive — we don't
 * re-add presets from a seed version already processed.
 *
 * The target seed value is `max(seedVersion)` across the loaded bank —
 * NOT a separate constant. This guarantees that if the module ever
 * loads in a partial state (HMR race, dev-server cache), we'll only
 * advance the stored seed to whatever batch is actually present in the
 * bank that ran. Next clean launch with the full bank will pick up
 * anything we missed.
 *
 * To ship new built-ins later: add them to PRESET_BANK tagged with a
 * higher `seedVersion`. No constant to bump. Existing entries stay
 * put; only the new ones are installed on next launch.
 */
export function seedBuiltins(store) {
  let lastSeed = 0;
  try {
    lastSeed = parseInt(localStorage.getItem(SEED_KEY) || '0', 10) || 0;
  } catch {}

  // Highest seedVersion present in the bank we loaded. This is our real
  // target — not a hardcoded constant that could outpace the bank.
  let bankMaxSv = 0;
  for (const entry of PRESET_BANK) {
    const sv = entry.seedVersion ?? 1;
    if (sv > bankMaxSv) bankMaxSv = sv;
  }
  if (lastSeed >= bankMaxSv) return;

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
    localStorage.setItem(SEED_KEY, String(bankMaxSv));
  } catch {}

  if (added > 0) {
    console.log(`[presets] seeded ${added} built-in presets (now at v${bankMaxSv})`);
  }
}
