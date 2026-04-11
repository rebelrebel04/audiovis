/**
 * Record
 *
 * MediaRecorder-based capture of the canvas + audio stream into a webm file.
 *
 * For MVP, we use canvas.captureStream() composited with the AudioContext
 * MediaStreamDestination from audio.js. The resulting webm is timestamp-
 * accurate with the audio and can be converted to a clean mp4 via ffmpeg
 * (see scripts/to-mp4.sh).
 *
 * Known MVP limitations (documented in memory/project_audiovis_mvp_plan.md):
 *   - Real-time capture means frame drops are possible under load.
 *   - Codec is webm/vp9 (best-supported on Mac Chrome). We convert to mp4
 *     with ffmpeg as a post-step.
 *
 * Upgrade path if this proves inadequate: deterministic frame-by-frame
 * capture via a small Node helper that receives PNGs over HTTP.
 */

export class Recorder {
  constructor(canvas, audioEngine) {
    this.canvas = canvas;
    this.audio = audioEngine;
    this.mediaRecorder = null;
    this.chunks = [];
    this.recording = false;
    this.onStateChange = null;
  }

  _pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return 'video/webm';
  }

  start() {
    if (this.recording) return;
    if (!this.audio.buffer) {
      console.warn('[recorder] no audio loaded, nothing to record');
      return;
    }

    // 60fps video stream from the canvas
    const videoStream = this.canvas.captureStream(60);
    // Audio stream from the AudioContext destination
    const audioStream = this.audio.destinationForRecording.stream;

    // Combine into a single MediaStream
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioStream.getAudioTracks(),
    ]);

    const mimeType = this._pickMimeType();
    this.mediaRecorder = new MediaRecorder(combined, {
      mimeType,
      videoBitsPerSecond: 12_000_000, // 12 Mbps — plenty for reels
    });

    this.chunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const trackName = (this.audio.trackName || 'render').replace(/\.[^.]+$/, '');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `${trackName}_${stamp}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Give the browser a moment to start the download before revoking
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.chunks = [];
    };

    // Rewind and start audio from the top so the recording captures from 0
    this.audio.seekToStart();
    if (!this.audio.playing) this.audio.play(0);

    this.mediaRecorder.start(100); // gather chunks every 100ms
    this.recording = true;
    this.onStateChange?.(true);

    // Auto-stop when the track ends
    const stopAtEnd = () => {
      if (!this.recording) return;
      if (this.audio.currentTime >= this.audio.duration - 0.05) {
        this.stop();
      } else {
        requestAnimationFrame(stopAtEnd);
      }
    };
    requestAnimationFrame(stopAtEnd);
  }

  stop() {
    if (!this.recording || !this.mediaRecorder) return;
    this.mediaRecorder.stop();
    this.recording = false;
    this.onStateChange?.(false);
  }

  toggle() {
    if (this.recording) this.stop();
    else this.start();
  }
}
