import GUI from 'lil-gui';
import { SOURCES } from './modulation.js';

/**
 * Params / UI
 *
 * Wires lil-gui sliders to the active primitive's params, its per-param
 * modulation metadata, the shared ModulationBus (rand/lfo rates), bloom
 * post-processing, and the transport controls (play, seek, scrub, record).
 *
 * Every *modulatable* primitive param produces three UI rows:
 *   - the base value slider
 *   - a source dropdown (—, low, mid, high, loud, rand, lfo)
 *   - an amount slider (swing magnitude when source is active)
 *
 * Kurt likes to see all the knobs at once (exploratory workflow), so folders
 * are opened by default and nothing is hidden behind accordions.
 */

/** Add a modulatable scalar param as three rows (value + source + amount). */
function addModulated(folder, params, modulation, key, label) {
  const m = modulation[key];
  folder.add(params, key, m.min, m.max, m.step).name(label);
  folder.add(m, 'source', SOURCES).name(`  ↳ src`);
  // Amount's max is half the param range — enough to swing the full extent
  // from either end of the base value.
  const maxAmount = (m.max - m.min) / 2;
  const amtStep = maxAmount / 200;
  folder.add(m, 'amount', 0, maxAmount, amtStep).name(`  ↳ amt`);
}

/**
 * Add a modulatable color param as three rows (color picker + source + hue-shift amount).
 * Modulation for colors is hue-shift: amount is measured as a fraction of the
 * full color wheel (0 = no shift, 0.5 = ±180° swing = full wheel sweep).
 */
function addModulatedColor(folder, params, modulation, key, label) {
  const m = modulation[key];
  folder.addColor(params, key).name(label);
  folder.add(m, 'source', SOURCES).name(`  ↳ src`);
  folder.add(m, 'amount', 0, 0.5, 0.005).name(`  ↳ hue shift`);
}

export function buildGui({
  primitiveParams,
  primitiveModulation,
  renderer,
  audio,
  bus,
  onRecordToggle,
  onPlayToggle,
  onSeekStart,
  onSeek,
}) {
  const gui = new GUI({ title: 'audiovis' });

  // --- Transport (playback controls + scrubber) ---
  const transport = {
    playPause: () => onPlayToggle(),
    seekStart: () => onSeekStart(),
    progress: 0,              // 0..1 normalized playhead (listened by main)
    time: '0:00 / 0:00',      // mm:ss / mm:ss display (listened by main)
    record: () => onRecordToggle(),
    _userDragging: false,     // flag read by main to skip programmatic updates
  };

  const transportFolder = gui.addFolder('transport');
  transportFolder.add(transport, 'playPause').name('▶ play / pause');
  transportFolder.add(transport, 'seekStart').name('⏮ to start');

  const scrubCtrl = transportFolder
    .add(transport, 'progress', 0, 1, 0.0001)
    .name('scrub')
    .listen();
  scrubCtrl.onChange((v) => {
    transport._userDragging = true;
    onSeek?.(v);
  });
  scrubCtrl.onFinishChange(() => {
    transport._userDragging = false;
  });

  transportFolder.add(transport, 'time').name('time').listen().disable();
  transportFolder.add(transport, 'record').name('● record / stop');
  transportFolder.open();

  // --- Geometry ---
  const geo = gui.addFolder('geometry');
  geo.add(primitiveParams, 'sides', 3, 20, 1).name('sides (N)');
  geo.add(primitiveParams, 'envelopeCoverage', 1, 20, 1).name('envelope coverage');
  geo.add(primitiveParams, 'lineCount', 8, 400, 1).name('line count');
  addModulated(geo, primitiveParams, primitiveModulation, 'polygonRadius', 'radius');
  addModulated(geo, primitiveParams, primitiveModulation, 'lineOpacity', 'line opacity');
  addModulatedColor(geo, primitiveParams, primitiveModulation, 'color', 'color');
  geo.open();

  // --- Motion ---
  const motion = gui.addFolder('motion');
  addModulated(motion, primitiveParams, primitiveModulation, 'rotationSpeedX', 'rot X');
  addModulated(motion, primitiveParams, primitiveModulation, 'rotationSpeedY', 'rot Y');
  addModulated(motion, primitiveParams, primitiveModulation, 'rotationSpeedZ', 'rot Z');
  addModulated(motion, primitiveParams, primitiveModulation, 'phaseSpeed', 'phase speed');
  addModulated(motion, primitiveParams, primitiveModulation, 'phaseAsymmetry', 'phase asym');
  addModulated(motion, primitiveParams, primitiveModulation, 'globalTilt', 'tilt');
  motion.open();

  // --- Modulators (shared oscillators + audio smoothing) ---
  const modFolder = gui.addFolder('modulators');
  modFolder.add(bus, 'randRate',  0.01, 2, 0.01).name('rand-1 rate (Hz)');
  modFolder.add(bus, 'randRate2', 0.01, 2, 0.01).name('rand-2 rate (Hz)');
  modFolder.add(bus, 'lfoRate',   0.01, 2, 0.01).name('lfo-1 rate (Hz)');
  modFolder.add(bus, 'lfoRate2',  0.01, 2, 0.01).name('lfo-2 rate (Hz)');
  modFolder.add(audio, 'attack',  0, 1, 0.01).name('audio attack');
  modFolder.add(audio, 'release', 0, 1, 0.01).name('audio release');
  modFolder.open();

  // --- Bloom ---
  const bloom = {
    strength: renderer.bloomPass.strength,
    radius: renderer.bloomPass.radius,
    threshold: renderer.bloomPass.threshold,
  };
  const bloomFolder = gui.addFolder('bloom');
  bloomFolder.add(bloom, 'strength', 0, 3, 0.01).onChange(v => renderer.setBloom({ strength: v }));
  bloomFolder.add(bloom, 'radius', 0, 2, 0.01).onChange(v => renderer.setBloom({ radius: v }));
  bloomFolder.add(bloom, 'threshold', 0, 1, 0.01).onChange(v => renderer.setBloom({ threshold: v }));
  bloomFolder.open();

  return { gui, transport };
}
