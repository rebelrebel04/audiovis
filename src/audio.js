/**
 * Audio
 *
 * Handles audio file loading, playback, and analysis.
 * Exposes smoothed features: rms, low, mid, high (all in [0,1]).
 *
 * Smoothing philosophy (feedback_captivation_over_reactivity):
 *   - All features pass through an envelope follower with configurable
 *     attack/release. This turns jittery FFT bins into musical motion.
 *   - Features are normalized using a soft running-max so the tool adapts
 *     to tracks at different loudness without manual gain staging.
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;              // AudioContext (lazy — needs user gesture)
    this.analyser = null;         // AnalyserNode
    this.source = null;           // AudioBufferSourceNode (current playback)
    this.gain = null;             // master gain
    this.destinationForRecording = null; // MediaStreamDestination for capture

    this.buffer = null;           // decoded AudioBuffer
    this.trackName = null;

    this.startedAt = 0;           // ctx.currentTime at playback start
    this.pausedAt = 0;
    this.playing = false;

    // FFT output buffers
    this.fftSize = 2048;
    this.freqData = null;         // Uint8Array

    // Smoothed features (read by primitives every frame)
    this.features = {
      rms: 0,
      low: 0,
      mid: 0,
      high: 0,
    };

    // Envelope follower state (last smoothed values)
    this._env = { rms: 0, low: 0, mid: 0, high: 0 };
    // Running soft-max for auto-gain normalization (per band)
    this._softMax = { rms: 0.2, low: 0.2, mid: 0.2, high: 0.2 };

    // Smoothing knobs (tunable from UI later if we want)
    this.attack = 0.35;   // 0..1, higher = snappier rise
    this.release = 0.08;  // 0..1, higher = snappier fall
  }

  _ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = 0.6; // gentle FFT smoothing
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1.0;
      this.destinationForRecording = this.ctx.createMediaStreamDestination();

      // Routing: source → analyser → gain → {speakers, recorder destination}
      this.analyser.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this.gain.connect(this.destinationForRecording);

      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    }
    return this.ctx;
  }

  /** Load an audio File (from drop/picker). Returns a promise. */
  async loadFile(file) {
    this._ensureContext();
    const arrayBuf = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuf);
    this.trackName = file.name;
    this.pausedAt = 0;
  }

  /**
   * Stop and tear down the current source, if any.
   *
   * IMPORTANT: clears onended *before* calling stop(). Without this, the
   * stopped source's onended handler fires asynchronously a frame later,
   * at which point a new source may already be playing — and the stale
   * handler (closing over `this`) corrupts engine state. This was the
   * cause of the "scrubber works once then breaks everything" bug.
   */
  _teardownSource() {
    if (!this.source) return;
    this.source.onended = null;
    try { this.source.stop(); } catch {}
    try { this.source.disconnect(); } catch {}
    this.source = null;
  }

  play(offset = 0) {
    if (!this.buffer) return;
    this._ensureContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this._teardownSource();

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.analyser);
    // Capture the source in the closure so we can distinguish "this source
    // ended naturally" from "this source was torn down externally."
    src.onended = () => {
      if (this.source === src) {
        this.playing = false;
        this.pausedAt = 0;
        this.source = null;
      }
    };
    src.start(0, offset);

    this.source = src;
    this.startedAt = this.ctx.currentTime - offset;
    this.playing = true;
  }

  pause() {
    if (!this.playing || !this.source) return;
    this.pausedAt = this.ctx.currentTime - this.startedAt;
    this._teardownSource();
    this.playing = false;
  }

  toggle() {
    if (!this.buffer) return;
    if (this.playing) this.pause();
    else this.play(this.pausedAt || 0);
  }

  seekToStart() {
    this.seek(0);
  }

  /** Seek to an absolute time (seconds). Preserves play/pause state. */
  seek(time) {
    if (!this.buffer) return;
    const clamped = Math.max(0, Math.min(this.duration, time));
    const wasPlaying = this.playing;
    if (this.playing) this.pause();
    this.pausedAt = clamped;
    if (wasPlaying) this.play(clamped);
  }

  /** Current playback position in seconds. */
  get currentTime() {
    if (this.playing) return this.ctx.currentTime - this.startedAt;
    return this.pausedAt;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /**
   * Sample the analyser and update smoothed feature values.
   * Call once per frame from the render loop.
   */
  sample() {
    if (!this.analyser) return this.features;
    this.analyser.getByteFrequencyData(this.freqData);

    const bins = this.freqData.length;
    // Split roughly into low / mid / high by bin index.
    // These are approximate — at 44.1kHz with fftSize=2048, binWidth ≈ 21Hz.
    // low ≈ 0..~500Hz (bins 0..24), mid ≈ 500Hz..4kHz (bins 25..190),
    // high ≈ 4kHz..~20kHz (bins 191..1024)
    const lowEnd = Math.floor(bins * 0.024);   // ~500Hz
    const midEnd = Math.floor(bins * 0.185);   // ~4kHz

    let lowSum = 0, midSum = 0, highSum = 0, allSum = 0;
    for (let i = 0; i < bins; i++) {
      const v = this.freqData[i] / 255;
      allSum += v;
      if (i < lowEnd) lowSum += v;
      else if (i < midEnd) midSum += v;
      else highSum += v;
    }
    const rawLow  = lowSum  / Math.max(1, lowEnd);
    const rawMid  = midSum  / Math.max(1, midEnd - lowEnd);
    const rawHigh = highSum / Math.max(1, bins - midEnd);
    const rawRms  = allSum  / bins;

    this._env.low  = envFollow(this._env.low,  rawLow,  this.attack, this.release);
    this._env.mid  = envFollow(this._env.mid,  rawMid,  this.attack, this.release);
    this._env.high = envFollow(this._env.high, rawHigh, this.attack, this.release);
    this._env.rms  = envFollow(this._env.rms,  rawRms,  this.attack, this.release);

    // Auto-gain: normalize by a slowly-decaying per-band max so quiet vs loud
    // tracks both land roughly in [0,1]. Decays slowly so it adapts between
    // sections but doesn't pump on every kick.
    const decay = 0.9995;
    for (const k of ['low', 'mid', 'high', 'rms']) {
      this._softMax[k] = Math.max(this._softMax[k] * decay, this._env[k], 0.05);
      this.features[k] = Math.min(1, this._env[k] / this._softMax[k]);
    }
    return this.features;
  }
}

function envFollow(prev, target, attack, release) {
  const rate = target > prev ? attack : release;
  return prev + (target - prev) * rate;
}
