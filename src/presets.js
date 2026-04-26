/**
 * Presets
 *
 * Save & restore snapshots of the whole visualization state: current
 * primitive, every primitive's params/modulation (so switching between
 * presets preserves per-primitive tweaks independently of which primitive
 * is active), the modulation bus (rand/lfo rates + beat config), audio
 * smoothing, trails post-effect, and bloom.
 *
 * Design goals — these are the reason the module exists as its own file:
 *
 *   1. **Auto-scales with new primitives & params.** snapshot() walks
 *      the PRIMITIVES registry and iterates each primitive's own `params`
 *      and `modulation` maps. Adding a new primitive or a new modulatable
 *      param requires zero preset-code changes.
 *
 *   2. **Forward-compatible loads.** apply() merges key-by-key: old
 *      presets that lack a newly-added param silently keep the current
 *      default; new presets that contain fields a primitive no longer
 *      supports are ignored. A `version` field is stored to enable
 *      explicit migrations later if we break the schema.
 *
 *   3. **Only persists what the user can tune.** We store base `params`
 *      values + modulation `source`/`amount` — not structural metadata
 *      like min/max/step, which belong in code. This means loading an
 *      old preset after retuning a slider range clamps naturally to
 *      the new range on next UI interaction (and never strands a value
 *      out-of-range in the snapshot itself).
 *
 *   4. **Storage-agnostic format.** snapshot() returns a plain JSON
 *      object. PresetStore wraps localStorage for the UI workflow, but
 *      the same blobs can be downloaded to disk via downloadPreset() /
 *      picked back up via pickPresetFile() for sharing.
 */

export const PRESET_VERSION = 1;
const STORAGE_KEY = 'audiovis.presets.v1';

/**
 * Capture a full snapshot of the current state.
 *
 * @param {object} ctx
 * @param {object} ctx.primitives            - PRIMITIVES registry, name → module
 * @param {string} ctx.currentPrimitiveName  - key of the currently active primitive
 * @param {object} ctx.bus                   - ModulationBus instance
 * @param {object} ctx.audio                 - AudioEngine instance
 * @param {object} ctx.posteffects           - { params, modulation } module
 * @param {object} ctx.renderer              - Renderer instance (reads bloomPass)
 */
export function snapshot({ primitives, currentPrimitiveName, bus, audio, posteffects, renderer }) {
  const out = {
    version: PRESET_VERSION,
    createdAt: new Date().toISOString(),
    primitive: currentPrimitiveName,
    primitives: {},
    bus: {
      randRate: bus.randRate,
      randRate2: bus.randRate2,
      lfoRate: bus.lfoRate,
      lfoRate2: bus.lfoRate2,
      beatSource: bus.beatSource,
      beatThreshold: bus.beatThreshold,
      beatDecay: bus.beatDecay,
    },
    audio: {
      attack: audio.attack,
      release: audio.release,
    },
    posteffects: {
      params: { ...posteffects.params },
      modulation: snapshotModulation(posteffects.modulation),
    },
    bloom: {
      strength: renderer.bloomPass.strength,
      radius: renderer.bloomPass.radius,
      threshold: renderer.bloomPass.threshold,
    },
  };
  // Snapshot EVERY primitive, not just the active one. This lets a preset
  // encode the full "scene state" so switching presets preserves the
  // per-primitive tweaks of the target preset even if the user was
  // previously on a different primitive.
  for (const [name, p] of Object.entries(primitives)) {
    out.primitives[name] = {
      params: { ...p.params },
      modulation: snapshotModulation(p.modulation),
    };
  }
  return out;
}

/**
 * Extract only the user-tunable fields of a modulation map (source + amount).
 * We deliberately skip min/max/step/kind — those are structural code, not
 * user state, and baking them into presets would make range tweaks in code
 * silently invalidate old presets.
 */
function snapshotModulation(mod) {
  const out = {};
  for (const [k, v] of Object.entries(mod)) {
    if (!v || typeof v !== 'object') continue;
    out[k] = {};
    if ('source' in v) out[k].source = v.source;
    if ('amount' in v) out[k].amount = v.amount;
  }
  return out;
}

/**
 * Apply a saved snapshot to live state. Uses forgiving key-by-key merges
 * so missing or extra fields don't break the load. If the preset targets a
 * different primitive, setPrimitive() fires the remount path (which
 * rebuilds its GUI from scratch with fresh values). refreshGui() is always
 * called at the end so non-listen controllers on persistent folders (bus,
 * audio, trails, bloom) pick up the new values immediately.
 *
 * @param {object} snap  - previously captured snapshot
 * @param {object} ctx   - same shape as snapshot() ctx plus setPrimitive + refreshGui
 */
export function apply(snap, ctx) {
  if (!snap || typeof snap !== 'object') return;
  const { primitives, bus, audio, posteffects, renderer, setPrimitive, refreshGui } = ctx;

  if (snap.bus) mergePlain(bus, snap.bus);
  if (snap.audio) mergePlain(audio, snap.audio);

  if (snap.posteffects) {
    mergePlain(posteffects.params, snap.posteffects.params);
    mergeModulation(posteffects.modulation, snap.posteffects.modulation);
  }

  if (snap.bloom && renderer.setBloom) {
    renderer.setBloom(snap.bloom);
  }

  if (snap.primitives) {
    for (const [name, state] of Object.entries(snap.primitives)) {
      const p = primitives[name];
      if (!p) continue; // preset references a primitive we no longer have — skip
      mergePlain(p.params, state.params);
      mergeModulation(p.modulation, state.modulation);
    }
  }

  // Switch primitive AFTER merging so the remount reads fresh values.
  const targetPrim = snap.primitive && primitives[snap.primitive] ? snap.primitive : null;
  if (targetPrim) {
    setPrimitive(targetPrim);
  }
  // Always refresh — even on primitive-switch, persistent folders need it.
  refreshGui?.();
}

/**
 * Copy scalar keys from src into target, preserving target's existing keys.
 * Skips nested objects (handled separately by mergeModulation) and keys
 * whose types don't match — so a corrupted preset can't poison state.
 */
function mergePlain(target, src) {
  if (!src || typeof src !== 'object') return;
  for (const k of Object.keys(target)) {
    if (!(k in src)) continue;
    const sv = src[k];
    const tv = target[k];
    if (sv === null || typeof sv === 'object') continue;
    if (typeof sv !== typeof tv) continue;
    target[k] = sv;
  }
}

/**
 * Merge only source + amount for each known modulation key.
 * Intentionally iterates target keys — unknown saved entries are dropped.
 */
function mergeModulation(target, src) {
  if (!src || typeof src !== 'object') return;
  for (const k of Object.keys(target)) {
    const s = src[k];
    if (!s || typeof s !== 'object') continue;
    if (typeof s.source === 'string') target[k].source = s.source;
    if (typeof s.amount === 'number') target[k].amount = s.amount;
  }
}

/**
 * localStorage-backed dictionary of named presets. One namespace per
 * schema version — a future v2 can coexist with v1 during migration.
 */
export class PresetStore {
  constructor() {
    this.presets = this._read();
  }
  _read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  _write() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.presets));
    } catch (err) {
      console.warn('[presets] localStorage write failed:', err);
    }
  }
  list() {
    return Object.keys(this.presets).sort();
  }
  save(name, snap) {
    this.presets[name] = snap;
    this._write();
  }
  load(name) {
    return this.presets[name] ?? null;
  }
  delete(name) {
    delete this.presets[name];
    this._write();
  }
}

/** Trigger a browser download for a preset JSON blob. */
export function downloadPreset(filename, snap) {
  const text = JSON.stringify(snap, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Prompt the user to pick a JSON file. Resolves to a parsed snapshot or
 * null on cancel/error. Creates a transient <input type=file> since the
 * file picker can only be triggered from a user gesture.
 */
export function pickPresetFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const text = await file.text();
        resolve(JSON.parse(text));
      } catch (err) {
        console.error('[presets] parse failed:', err);
        resolve(null);
      }
    };
    input.click();
  });
}
