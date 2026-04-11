import { Renderer } from './renderer.js';
import { PRIMITIVES, DEFAULT_PRIMITIVE } from './primitives/index.js';
import { AudioEngine } from './audio.js';
import { ModulationBus, resolve } from './modulation.js';
import { buildGui } from './params.js';
import { Recorder } from './record.js';
import * as posteffects from './posteffects.js';

/**
 * Entry point: wires together renderer, primitive, audio, modulation bus,
 * UI, and recorder.
 *
 * The "primitive contract" is:
 *   { params, modulation, init(scene), dispose(scene),
 *     mountGui(parent, helpers), update({ time, dt, audio, bus }) }
 *
 * Primitives are registered in src/primitives/index.js and swappable at
 * runtime via the GUI dropdown. switchPrimitive() handles disposing the
 * current primitive's scene objects + GUI and bringing up the new one.
 * Transport, modulation bus, and bloom are shared across primitives.
 */

const canvas = document.getElementById('canvas');
const hudTrack = document.getElementById('hud-track');
const hud = document.getElementById('hud');
const app = document.getElementById('app');

// --- Renderer ---
const renderer = new Renderer(canvas, { width: 1080, height: 1920 });

// --- Audio ---
const audio = new AudioEngine();

// --- Modulation bus (shared rand + lfo oscillators) ---
const bus = new ModulationBus();

// --- Recorder ---
const recorder = new Recorder(canvas, audio);
recorder.onStateChange = (recording) => {
  hud.classList.toggle('recording', recording);
};

// --- Primitive (mutable — swappable at runtime) ---
let currentPrimitive = PRIMITIVES[DEFAULT_PRIMITIVE];
currentPrimitive.init(renderer.scene);

// --- UI ---
const { transport, mountPrimitive, unmountPrimitive, beatIndicator } = buildGui({
  primitiveNames: Object.keys(PRIMITIVES),
  initialPrimitive: DEFAULT_PRIMITIVE,
  posteffects,
  renderer,
  audio,
  bus,
  onPrimitiveChange: (name) => switchPrimitive(name),
  onPlayToggle: () => audio.toggle(),
  onSeekStart: () => audio.seekToStart(),
  onSeek: (normalized) => audio.seek(normalized * audio.duration),
  onRecordToggle: () => recorder.toggle(),
});

// Mount the default primitive's GUI after buildGui is done
mountPrimitive(currentPrimitive);

/**
 * Swap the active primitive.
 *
 * Order matters: unmount GUI → dispose scene objects → init new → mount new.
 * Doing dispose before init guarantees we never have two primitives' scene
 * objects live at once, which would double-render and confuse bloom.
 */
function switchPrimitive(name) {
  const next = PRIMITIVES[name];
  if (!next || next === currentPrimitive) return;
  unmountPrimitive();
  currentPrimitive.dispose(renderer.scene);
  currentPrimitive = next;
  currentPrimitive.init(renderer.scene);
  mountPrimitive(currentPrimitive);
}

// --- File loading (drag-and-drop) ---
async function loadAudioFile(file) {
  try {
    await audio.loadFile(file);
    hudTrack.textContent = file.name;
    app.classList.add('has-audio');
    audio.play(0);
  } catch (err) {
    console.error('[audio] load failed:', err);
    hudTrack.textContent = `load failed: ${err.message}`;
  }
}

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  app.classList.add('drag-over');
});
window.addEventListener('dragleave', (e) => {
  if (e.target === document.documentElement) app.classList.remove('drag-over');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  app.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) loadAudioFile(file);
});

// Keyboard shortcuts: space = play/pause, R = record
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    audio.toggle();
  } else if (e.key === 'r' || e.key === 'R') {
    recorder.toggle();
  }
});

// --- Render loop ---
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${ss}`;
}

let lastPerf = performance.now();
const clockStart = lastPerf;

function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastPerf) / 1000);
  const time = (now - clockStart) / 1000;
  lastPerf = now;

  // 1. Sample audio features
  const features = audio.sample();
  // 2. Tick oscillators (rand / lfo) + beat detector (needs live audio)
  bus.tick(dt, time, features);
  // 3. Update the current primitive with resolved modulation
  currentPrimitive.update({ time, dt, audio: features, bus });
  // 4. Resolve global post-effect params and push to renderer before render
  const persistence = resolve(
    posteffects.params.trailPersistence,
    posteffects.modulation.trailPersistence,
    features,
    bus,
  );
  const radialPush = resolve(
    posteffects.params.trailRadialPush,
    posteffects.modulation.trailRadialPush,
    features,
    bus,
  );
  renderer.setTrails({ persistence, radialPush });
  // 5. Render the frame
  renderer.render();

  // Beat indicator: map bus._beat (1.0 on fire, decays exponentially) to
  // opacity + glow so the dot snaps bright on each onset and fades between
  // hits. Read directly from the bus so we track the actual decay shape.
  if (beatIndicator) {
    const b = bus._beat;
    const opacity = 0.15 + 0.85 * b;
    const glow = 12 * b;
    beatIndicator.style.opacity = opacity.toFixed(3);
    beatIndicator.style.boxShadow = `0 0 ${glow.toFixed(1)}px #ff4747`;
  }

  // 5. Sync scrubber + time display (skip scrubber while user is dragging)
  if (audio.buffer) {
    if (!transport._userDragging) {
      transport.progress = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
    }
    transport.time = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
