import GUI from 'lil-gui';
import { SOURCES, BEAT_BANDS } from './modulation.js';

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

/**
 * Add a modulatable scalar param.
 *
 * Layout: the base value slider is always visible; src + amount live in a
 * closed-by-default sub-folder immediately below so they can be tucked away
 * when you're not actively tweaking modulation. Click `↳ mod` to expand.
 */
function addModulated(folder, params, modulation, key, label) {
  const m = modulation[key];
  folder.add(params, key, m.min, m.max, m.step).name(label);

  const modSub = folder.addFolder(`  ↳ mod`);
  modSub.add(m, 'source', SOURCES).name('src');
  // Amount's max is the full param range. For symmetric sources (rand,
  // lfo, audio bands) values past half-range just saturate at the clamp
  // (harmless). For unipolar sources like `beat` the extra headroom lets
  // you swing the whole param range on a single pulse.
  const maxAmount = m.max - m.min;
  const amtStep = maxAmount / 400;
  modSub.add(m, 'amount', 0, maxAmount, amtStep).name('amt');
  modSub.close();
}

/**
 * Add a modulatable color param.
 *
 * Same collapse behavior as addModulated: color picker stays visible, the
 * source dropdown and hue-shift amount hide inside a closed sub-folder.
 * Hue-shift amount is a fraction of the full color wheel (0 = no shift,
 * 0.5 = ±180° swing = full wheel sweep).
 */
function addModulatedColor(folder, params, modulation, key, label) {
  const m = modulation[key];
  folder.addColor(params, key).name(label);

  const modSub = folder.addFolder(`  ↳ mod`);
  modSub.add(m, 'source', SOURCES).name('src');
  modSub.add(m, 'amount', 0, 0.5, 0.005).name('hue shift');
  modSub.close();
}

export function buildGui({
  primitiveNames,
  initialPrimitive,
  posteffects,
  renderer,
  audio,
  bus,
  presetStore,
  onPrimitiveChange,
  onRecordToggle,
  onPlayToggle,
  onSeekStart,
  onSeek,
  onPresetSave,
  onPresetLoad,
  onPresetDelete,
  onPresetExport,
  onPresetImport,
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

  // --- Presets ---
  // Located here (directly below transport, above primitive selector) so
  // the "load a preset first, then tweak" workflow reads top-to-bottom.
  // Loading a preset may switch the active primitive, so it has to sit
  // above the primitive selector logically — and visually doing so keeps
  // the full state-restoration controls together.
  //
  // On any mutation (save / delete / import) we rebuild the entire
  // folder contents rather than trying to in-place-update the saved
  // dropdown. lil-gui doesn't support stable in-place option updates, so
  // destroy+re-add is the clean approach. Rebuilding the whole folder in
  // a deterministic order keeps the layout perfectly stable.
  const presetState = {
    name: '',
    selected: '',
  };
  const presetFolder = gui.addFolder('presets');
  function buildPresetUI() {
    // Tear down any existing children (controllers + sub-folders).
    [...presetFolder.folders].forEach((f) => f.destroy());
    [...presetFolder.controllers].forEach((c) => c.destroy());

    presetFolder.add(presetState, 'name').name('name');
    presetFolder
      .add({
        save: () => {
          const name = presetState.name.trim();
          if (!name) return;
          onPresetSave?.(name);
          presetState.selected = name;
          buildPresetUI();
        },
      }, 'save')
      .name('💾 save current');

    const list = presetStore?.list() ?? [];
    if (list.length > 0) {
      if (!list.includes(presetState.selected)) presetState.selected = list[0];
      presetFolder.add(presetState, 'selected', list).name('preset');
      presetFolder
        .add({
          load: () => {
            if (presetState.selected) onPresetLoad?.(presetState.selected);
          },
        }, 'load')
        .name('⤴ load selected');
      presetFolder
        .add({
          del: () => {
            if (!presetState.selected) return;
            if (!confirm(`Delete preset "${presetState.selected}"?`)) return;
            onPresetDelete?.(presetState.selected);
            buildPresetUI();
          },
        }, 'del')
        .name('✕ delete selected');
    } else {
      // Placeholder row when nothing's saved yet — disables cleanly so
      // it's obvious there's nothing to load.
      const placeholder = { '(no saved presets)': '' };
      presetFolder.add(placeholder, '(no saved presets)').disable();
    }

    presetFolder
      .add({ exp: () => onPresetExport?.(presetState.selected) }, 'exp')
      .name('⬇ export JSON');
    presetFolder
      .add({
        imp: async () => {
          const importedName = await onPresetImport?.();
          if (importedName) {
            presetState.selected = importedName;
            buildPresetUI();
          }
        },
      }, 'imp')
      .name('⬆ import JSON');
  }
  buildPresetUI();
  presetFolder.open();

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

  // --- Modulators (shared oscillators + audio smoothing + beat) ---
  const modFolder = gui.addFolder('modulators');
  modFolder.add(bus, 'randRate',  0.01, 2, 0.01).name('rand-1 rate (Hz)');
  modFolder.add(bus, 'randRate2', 0.01, 2, 0.01).name('rand-2 rate (Hz)');
  modFolder.add(bus, 'lfoRate',   0.01, 2, 0.01).name('lfo-1 rate (Hz)');
  modFolder.add(bus, 'lfoRate2',  0.01, 2, 0.01).name('lfo-2 rate (Hz)');
  modFolder.add(audio, 'attack',  0, 1, 0.01).name('audio attack');
  modFolder.add(audio, 'release', 0, 1, 0.01).name('audio release');
  // Beat/onset detector — threshold on a selected band; pulses the `beat`
  // source to 1.0 on rising edge and decays exponentially between fires.
  modFolder.add(bus, 'beatSource',    BEAT_BANDS).name('beat source');
  modFolder.add(bus, 'beatThreshold', 0, 1, 0.01).name('beat threshold');
  modFolder.add(bus, 'beatDecay',     0.5, 15, 0.1).name('beat decay (1/s)');

  // Beat detector indicator: a small dot that pulses whenever the beat
  // source fires. Handy for diagnosing whether beats are being detected at
  // all and for dialing in threshold / decay without having to map beat to
  // something visual first. Styled to match lil-gui's dark row layout.
  const beatIndicatorRow = document.createElement('div');
  beatIndicatorRow.style.cssText = [
    'display: flex',
    'align-items: center',
    'gap: 8px',
    'padding: 4px 8px 4px 12px',
    'font-size: 11px',
    'color: #aaa',
    'font-family: inherit',
  ].join(';');
  const beatIndicatorLabel = document.createElement('span');
  beatIndicatorLabel.textContent = 'beat detector';
  beatIndicatorLabel.style.cssText = 'flex: 1; opacity: 0.7';
  const beatIndicator = document.createElement('div');
  beatIndicator.style.cssText = [
    'width: 10px',
    'height: 10px',
    'border-radius: 50%',
    'background: #ff4747',
    'opacity: 0.15',
    'box-shadow: 0 0 0px #ff4747',
    'transition: none',
    'margin-right: 4px',
  ].join(';');
  beatIndicatorRow.appendChild(beatIndicatorLabel);
  beatIndicatorRow.appendChild(beatIndicator);
  modFolder.$children.appendChild(beatIndicatorRow);

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
  // Progressive-stride bloom can productively go higher than UnrealBloom's
  // typical 0–3 range (Manifold uses 3.2 with HDR core). Slider tops at 5
  // so users can dial in the full Manifold-style glow.
  bloomFolder.add(bloom, 'strength', 0, 5, 0.01).onChange(v => renderer.setBloom({ strength: v }));
  bloomFolder.add(bloom, 'radius', 0, 2, 0.01).onChange(v => renderer.setBloom({ radius: v }));
  bloomFolder.add(bloom, 'threshold', 0, 1, 0.01).onChange(v => renderer.setBloom({ threshold: v }));
  bloomFolder.open();

  /**
   * Pull every controller's display value from its underlying model.
   *
   * Called after a preset load so that non-`.listen()`'d controllers
   * (the vast majority, for perf) pick up the mutated state. Also
   * re-syncs the local `bloom` mirror from renderer.bloomPass — since
   * those sliders are bound to the local `bloom` object (not the pass
   * directly), they'd otherwise still show the old values after a load.
   *
   * Primitive-specific controllers are rebuilt from scratch on
   * mountPrimitive(), so they don't need updateDisplay — but calling
   * it on them is harmless, and controllersRecursive() includes them.
   */
  function refreshAll() {
    bloom.strength = renderer.bloomPass.strength;
    bloom.radius = renderer.bloomPass.radius;
    bloom.threshold = renderer.bloomPass.threshold;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  return { gui, transport, mountPrimitive, unmountPrimitive, beatIndicator, refreshAll };
}
