/**
 * Modulation
 *
 * Per-param modulation system, inspired by Magic MusicVisuals.
 *
 * Every "modulatable" param in a primitive has a companion entry in the
 * primitive's `modulation` object:
 *
 *   modulation.rotationSpeedY = {
 *     source: 'low',    // one of SOURCES below
 *     amount: 0.08,     // how much the source deviates the base value
 *     min: -1, max: 1,  // clamp range (also used by UI to size sliders)
 *     step: 0.01,       // UI step
 *   };
 *
 * The effective value each frame is:
 *
 *   base + (sourceValue - 0.5) * 2 * amount,    clamped to [min, max]
 *
 * where `sourceValue` is in [0, 1]. When source is '—' (none) the base
 * passes through unchanged.
 *
 * Shared oscillator sources on the ModulationBus:
 *   - `rand-1` / `rand-2`: slow smooth random walks at independent rates
 *   - `lfo-1`  / `lfo-2`:  slow sine waves at independent rates
 *
 * Params that select the same source share one signal (so multiple params
 * on `lfo-1` move in lockstep). Use `rand-1` vs `rand-2` (or `lfo-1` vs
 * `lfo-2`) when you want two independent oscillators.
 */

export const SOURCES = ['—', 'low', 'mid', 'high', 'loud', 'rand-1', 'rand-2', 'lfo-1', 'lfo-2'];

export class ModulationBus {
  constructor() {
    // Rates are in Hz. Defaults favor slow, mesmerizing motion.
    this.randRate = 0.15;
    this.randRate2 = 0.4;
    this.lfoRate = 0.1;
    this.lfoRate2 = 0.25;

    // Random-walk state for rand: smoothstep between two endpoints
    this._randA = Math.random();
    this._randB = Math.random();
    this._randPhase = 0;
    this._rand = 0.5;

    // Random-walk state for rand2 (independent)
    this._randA2 = Math.random();
    this._randB2 = Math.random();
    this._randPhase2 = 0;
    this._rand2 = 0.5;

    // LFO state (sine wave position is recomputed from `time` each tick,
    // so these just hold the latest sampled value)
    this._lfo = 0.5;
    this._lfo2 = 0.5;
  }

  /** Advance oscillators. Call once per frame from main.js. */
  tick(dt, time) {
    // LFOs: independent sine waves mapped to [0, 1]
    this._lfo  = 0.5 + 0.5 * Math.sin(time * this.lfoRate  * Math.PI * 2);
    this._lfo2 = 0.5 + 0.5 * Math.sin(time * this.lfoRate2 * Math.PI * 2);

    // Random walks: smoothstep from A to B, pick new B when phase wraps
    this._randPhase += dt * this.randRate;
    while (this._randPhase >= 1) {
      this._randA = this._randB;
      this._randB = Math.random();
      this._randPhase -= 1;
    }
    const t1 = this._randPhase;
    const s1 = t1 * t1 * (3 - 2 * t1);
    this._rand = this._randA * (1 - s1) + this._randB * s1;

    this._randPhase2 += dt * this.randRate2;
    while (this._randPhase2 >= 1) {
      this._randA2 = this._randB2;
      this._randB2 = Math.random();
      this._randPhase2 -= 1;
    }
    const t2 = this._randPhase2;
    const s2 = t2 * t2 * (3 - 2 * t2);
    this._rand2 = this._randA2 * (1 - s2) + this._randB2 * s2;
  }

  /** Return the current [0,1] value for a named source. */
  sourceValue(name, audio) {
    switch (name) {
      case 'low':    return audio?.low  ?? 0;
      case 'mid':    return audio?.mid  ?? 0;
      case 'high':   return audio?.high ?? 0;
      case 'loud':   return audio?.rms  ?? 0;
      case 'rand-1': return this._rand;
      case 'rand-2': return this._rand2;
      case 'lfo-1':  return this._lfo;
      case 'lfo-2':  return this._lfo2;
      default:       return 0.5; // '—' or unknown: neutral center (no effect)
    }
  }
}

/**
 * Resolve the effective value of a modulatable param.
 *
 * @param {number} base   - base value from the slider
 * @param {object} mod    - { source, amount, min, max }
 * @param {object} audio  - smoothed audio features
 * @param {ModulationBus} bus
 * @returns {number}
 */
export function resolve(base, mod, audio, bus) {
  if (!mod || !mod.source || mod.source === '—') return base;
  const s = bus.sourceValue(mod.source, audio);
  const v = base + (s - 0.5) * 2 * mod.amount;
  return Math.max(mod.min, Math.min(mod.max, v));
}
