import { Renderer } from './renderer.js';
import * as polygonEnvelope from './primitives/polygonEnvelope.js';
import { AudioEngine } from './audio.js';
import { ModulationBus } from './modulation.js';
import { buildGui } from './params.js';
import { Recorder } from './record.js';

/**
 * Entry point: wires together renderer, primitive, audio, modulation bus,
 * UI, and recorder.
 *
 * The "primitive contract" is:
 *   { params, modulation, init(scene), update({ time, dt, audio, bus }) }
 *
 * main.js is deliberately agnostic to which primitive is active so that
 * adding new primitives later (particle fields, glitch shaders, etc.)
 * requires only swapping the import and re-binding the UI.
 */

const canvas = document.getElementById('canvas');
const hudTrack = document.getElementById('hud-track');
const hud = document.getElementById('hud');
const app = document.getElementById('app');

// --- Renderer ---
const renderer = new Renderer(canvas, { width: 1080, height: 1920 });

// --- Primitive ---
const primitive = polygonEnvelope;
primitive.init(renderer.scene);

// --- Audio ---
const audio = new AudioEngine();

// --- Modulation bus (shared rand + lfo oscillators) ---
const bus = new ModulationBus();

// --- Recorder ---
const recorder = new Recorder(canvas, audio);
recorder.onStateChange = (recording) => {
  hud.classList.toggle('recording', recording);
};

// --- UI ---
const { transport } = buildGui({
  primitiveParams: primitive.params,
  primitiveModulation: primitive.modulation,
  renderer,
  audio,
  bus,
  onPlayToggle: () => audio.toggle(),
  onSeekStart: () => audio.seekToStart(),
  onSeek: (normalized) => audio.seek(normalized * audio.duration),
  onRecordToggle: () => recorder.toggle(),
});

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
  // 2. Tick oscillators (rand / lfo)
  bus.tick(dt, time);
  // 3. Update primitive with resolved modulation
  primitive.update({ time, dt, audio: features, bus });
  // 4. Render the frame
  renderer.render();

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
