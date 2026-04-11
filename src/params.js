import GUI from 'lil-gui';
import { SOURCES } from './modulation.js';

/**
 * Params / UI
 *
 * Wires lil-gui sliders to:
 *   - the transport controls (play, seek, scrub, record)
 *   - a primitive selector dropdown
 *   - the active primitive's own params + modulation metadata (via the
 *     primitive's mountGui(parent, helpers) method)
 *   - the shared ModulationBus (rand/lfo rates) and audio smoothing
 *   - bloom post-processing
 *
 * Every *modulatable* primitive param produces three UI rows:
 *   - the base value slider
 *   - a source dropdown (—, low, mid, high, loud, rand-*, lfo-*)
 *   - an amount slider (swing magnitude when source is active)
 *
 * Kurt likes to see all the knobs at once (exploratory workflow), so folders
 * are opened by default and nothing is hidden behind accordions.
 *
 * Primitive switching: the "primitive" folder is a persistent parent that
 * each primitive populates via its mountGui() method. On switch we destroy
 * the folder's children and call the new primitive's mountGui() — the
 * parent folder keeps its position in the layout.
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
  primitiveNames,
  initialPrimitive,
  posteffects,
  renderer,
  audio,
  bus,
  onPrimitiveChange,
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

  // --- Primitive selector + mount point ---
  const selectorState = { primitive: initialPrimitive };
  gui
    .add(selectorState, 'primitive', primitiveNames)
    .name('primitive')
    .onChange((name) => onPrimitiveChange?.(name));

  // Persistent parent folder for primitive-specific controls.
  // mountPrimitive/unmountPrimitive manipulate its children; the folder
  // itself keeps its position between modulators and bloom.
  const primitiveFolder = gui.addFolder('primitive settings');
  primitiveFolder.open();

  /** Populate primitiveFolder with the given primitive's GUI. */
  function mountPrimitive(primitive) {
    primitive.mountGui(primitiveFolder, { addModulated, addModulatedColor });
  }

  /** Destroy every child controller/folder inside primitiveFolder. */
  function unmountPrimitive() {
    // Copy arrays before iterating — destroy() mutates the parent's lists.
    [...primitiveFolder.folders].forEach((f) => f.destroy());
    [...primitiveFolder.controllers].forEach((c) => c.destroy());
  }

  // --- Modulators (shared oscillators + audio smoothing) ---
  const modFolder = gui.addFolder('modulators');
  modFolder.add(bus, 'randRate',  0.01, 2, 0.01).name('rand-1 rate (Hz)');
  modFolder.add(bus, 'randRate2', 0.01, 2, 0.01).name('rand-2 rate (Hz)');
  modFolder.add(bus, 'lfoRate',   0.01, 2, 0.01).name('lfo-1 rate (Hz)');
  modFolder.add(bus, 'lfoRate2',  0.01, 2, 0.01).name('lfo-2 rate (Hz)');
  modFolder.add(audio, 'attack',  0, 1, 0.01).name('audio attack');
  modFolder.add(audio, 'release', 0, 1, 0.01).name('audio release');
  modFolder.open();

  // --- Trails (feedback post-effect, global) ---
  const trailsFolder = gui.addFolder('trails');
  addModulated(trailsFolder, posteffects.params, posteffects.modulation, 'trailPersistence', 'persistence');
  addModulated(trailsFolder, posteffects.params, posteffects.modulation, 'trailRadialPush', 'radial push');
  trailsFolder.open();

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

  return { gui, transport, mountPrimitive, unmountPrimitive };
}
