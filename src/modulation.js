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
 *   - `beat`:              rising-edge onset detector on a configurable
 *                          audio band (low/mid/high/loud) with hysteresis.
 *                          Pulses to 1.0 on fire, then decays exponentially.
 *
 * Params that select the same source share one signal (so multiple params
 * on `lfo-1` move in lockstep). Use `rand-1` vs `rand-2` (or `lfo-1` vs
 * `lfo-2`) when you want two independent oscillators.
 *
 * `resolve()` has two modes keyed by source shape:
 *   - **Symmetric** (rand/lfo/low/mid/high/loud): `base + (s - 0.5) * 2 * amount`.
 *     These sources average ~0.5 so the baseline contribution is zero.
 *   - **Unipolar** (beat): `base + s * amount`. Idle sits at `base`, the
 *     spike reaches `base + amount`. Beat pulses from 0 to 1 so a
 *     symmetric formula would drag the baseline to `base - amount`, which
 *     is counterintuitive for an event-trigger source.
 */

export const SOURCES = ['—', 'low', 'mid', 'high', 'loud', 'rand-1', 'rand-2', 'lfo-1', 'lfo-2', 'beat'];

/**
 * The audio bands that can drive the beat detector. Separate from SOURCES
 * because `beat` can't listen to itself, and oscillator sources wouldn't
 * make sense either.
 */
export const BEAT_BANDS = ['—', 'low', 'mid', 'high', 'loud'];

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

    // --- Beat / onset detection ---
    // `beatSource` picks an audio band to listen to. We read the *raw*
    // (pre-envelope-follower) normalized value from `audio.raw[band]` so
    // transients aren't smeared out.
    //
    // Detection is derivative-based: fire when the armed detector sees a
    // sample that is both above `beatThreshold` AND rising (this frame's
    // value is greater than last frame's by at least `_beatRiseEps`).
    // Re-arm as soon as the value stops rising — i.e. at the peak of the
    // transient — regardless of absolute level, plus a minimum refractory
    // period to reject micro-jitter within a single onset.
    //
    // Why not a value-based hysteresis (re-arm on fall below X% of
    // threshold)? That approach works for clean signals where the
    // inter-onset floor is near zero, but on bass-heavy or sustain-heavy
    // tracks the floor sits well above zero — and worse, the auto-gain
    // softMax slowly normalizes the sustain floor *up* toward the peak
    // until the hysteresis check is never satisfied, stranding the
    // detector disarmed forever. Derivative re-arm doesn't care about
    // the baseline: every new transient rises, peaks, then stops rising.
    //
    // Consumers: `bus.sourceValue('beat')` for the decaying pulse level,
    // or `bus.beatFired` for the one-shot event flag.
    this.beatSource = 'low';
    this.beatThreshold = 0.5;
    this.beatDecay = 4.0;
    this._beat = 0;
    this._beatPrev = 0;
    this._beatArmed = true;
    this._beatHoldT = 0;
    this._beatRefractory = 0.04; // 40ms — prevents double-trigger within an onset
    this._beatRiseEps = 0.01;    // minimum per-frame rise to count as "rising"
    this.beatFired = false;
  }

  /**
   * Advance oscillators. Call once per frame from main.js.
   * @param {number} dt     seconds since last tick
   * @param {number} time   seconds since start
   * @param {object} audio  current sampled audio features (optional — used for beat detection)
   */
  tick(dt, time, audio) {
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

    // Beat detection: derivative-based onset on the *raw* (pre-envelope)
    // band value. Reading raw means transients hit full amplitude (the
    // envelope follower's whole job is to smear them, which is the
    // opposite of what onset detection wants).
    this.beatFired = false;
    if (audio && this.beatSource && this.beatSource !== '—') {
      const val = this._rawBand(audio, this.beatSource);
      const dval = val - this._beatPrev;
      const rising = dval > this._beatRiseEps;

      if (this._beatArmed && val >= this.beatThreshold && rising) {
        this._beat = 1.0;
        this.beatFired = true;
        this._beatArmed = false;
        this._beatHoldT = 0;
      }
      if (!this._beatArmed) {
        this._beatHoldT += dt;
        // Re-arm when the transient has peaked (value stopped rising)
        // AND the refractory window has elapsed. Using "stopped rising"
        // instead of "fell below X" means a sustained bass tone can't
        // strand us disarmed — every new kick necessarily rises, peaks,
        // then plateaus, at which point we re-arm for the next one.
        if (this._beatHoldT >= this._beatRefractory && !rising) {
          this._beatArmed = true;
        }
      }
      this._beatPrev = val;
    } else {
      this._beatArmed = true;
      this._beatHoldT = 0;
      this._beatPrev = 0;
    }
    // Decay pulse between fires (skip decay on the firing tick so the
    // peak is sampled at full 1.0 during primitive.update this frame).
    if (!this.beatFired) {
      this._beat *= Math.exp(-this.beatDecay * dt);
      if (this._beat < 1e-4) this._beat = 0;
    }
  }

  /**
   * Raw (pre-envelope-follower) read of an audio band for onset detection.
   * Falls back to the smoothed value if the audio engine doesn't expose
   * `features.raw` yet (older callsites / tests).
   */
  _rawBand(audio, name) {
    const raw = audio.raw ?? audio;
    switch (name) {
      case 'low':  return raw.low  ?? 0;
      case 'mid':  return raw.mid  ?? 0;
      case 'high': return raw.high ?? 0;
      case 'loud': return raw.rms  ?? 0;
      default:     return 0;
    }
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
      case 'beat':   return this._beat;
      default:       return 0.5; // '—' or unknown: neutral center (no effect)
    }
  }
}

/**
 * Resolve the effective value of a modulatable param.
 *
 * Uses unipolar additive formula for `beat` (idle = base, spike = base +
 * amount) and the symmetric centered formula for all other sources.
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
  const v = mod.source === 'beat'
    ? base + s * mod.amount              // unipolar: idle=base, spike=base+amount
    : base + (s - 0.5) * 2 * mod.amount; // symmetric: centered at 0.5
  return Math.max(mod.min, Math.min(mod.max, v));
}
