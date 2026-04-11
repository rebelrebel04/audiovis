# audiovis

Audio-reactive visual generator for Quine tracks → IG Reels.

MVP: a single **polygon envelope** primitive (N-gon string-art with configurable envelope coverage), rendered in three.js with bloom, modulated subtly by a smoothed FFT of the loaded audio.

## Quick start

```sh
# 1. Install deps (one-time; already done if you ran the setup)
npm install

# 2. Start the dev server — opens http://localhost:5173 automatically
npm run dev
```

Then in the browser:

1. **Drag an audio file** (wav / mp3 / flac / m4a) onto the window. Playback starts automatically.
2. **Tweak params** in the lil-gui sidebar on the right.
3. Press **space** to pause/resume, **R** to start/stop recording.
4. When recording stops (automatically at track end, or when you hit stop), a `.webm` file downloads to your default download folder.
5. Convert the webm to IG-ready mp4 with the helper script:
   ```sh
   ./scripts/to-mp4.sh ~/Downloads/your_track_2026-04-10T22-30-00.webm
   # or with an explicit output path:
   ./scripts/to-mp4.sh ~/Downloads/in.webm ~/Desktop/out.mp4
   ```
   This requires ffmpeg. Install with `brew install ffmpeg` if you don't have it.

## Keyboard shortcuts

| key | action |
|---|---|
| space | play / pause |
| R | start / stop recording |

## Param sidebar

Four groups of knobs:

- **geometry** — `sides` (3–20), `envelopeCoverage` (how many of the N edge-pairs to draw envelopes on), line count, radius, opacity, color.
  - `sides=3, envelopeCoverage=1` → classic asymmetric single-envelope triangle
  - `sides=3, envelopeCoverage=3` → symmetric triangular rosette
  - `sides=12, envelopeCoverage=12` → mandala
- **motion** — rotation speeds on X/Y/Z, phase drift between the two edge-walkers, phase asymmetry, static tilt.
- **audio mapping** — how much each band (low / mid / high / overall loudness) modulates its target. Defaults are deliberately subtle (captivation over raw reactivity). `attack` / `release` control feature smoothing.
- **bloom** — strength / radius / threshold for the post-processing glow.

## Architecture

```
src/
  main.js                   # entry: wires renderer + primitive + audio + UI + recorder
  renderer.js               # three.js scene, ortho camera, bloom pass chain
  audio.js                  # Web Audio loading + smoothed FFT features (envelope followers)
  params.js                 # lil-gui sidebar construction
  record.js                 # MediaRecorder wrapper (canvas + audio → webm)
  primitives/
    polygonEnvelope.js      # the first (and only, for MVP) visual primitive
scripts/
  to-mp4.sh                 # ffmpeg: webm → IG-ready mp4
```

**Primitive contract** (for future extensibility):

```js
export const params = { /* tweakable knobs */ };
export function init(scene) { /* build three.js objects */ }
export function update(time, audioFeatures, params) { /* per-frame update */ }
```

Adding a new visual style (e.g. a particle field à la Infinite Mantra) is a matter of creating a new file in `src/primitives/` that conforms to this contract, then swapping the import in `main.js` (or adding a primitive selector to the UI).

## Known MVP limitations

- **Recording uses MediaRecorder real-time capture.** Possible frame drops under heavy visual load. If this becomes a problem we'll upgrade to deterministic frame-by-frame capture (requires a small Node helper).
- **No preset save/load.** Exploratory workflow by design — add if that changes.
- **Single primitive.** Library grows post-MVP once the spine is proven.
- **WebGL line width is capped to 1px** on most platforms (Windows/Mac). If you want thicker glowing lines, the right tool is MeshLine or a custom shader — planned upgrade.

## Next steps (post-MVP, rough order)

1. Use it on a real track and report back what feels missing.
2. Add a second primitive in the "Infinite Mantra" particle-bloom family.
3. Beat / onset detection for punchier (but still tasteful) hits.
4. Preset save/load if exploration-from-scratch starts feeling tedious.
5. Deterministic frame-by-frame render if MediaRecorder quality isn't holding up.
