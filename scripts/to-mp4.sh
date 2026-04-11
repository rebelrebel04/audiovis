#!/usr/bin/env bash
# to-mp4.sh — convert a recorded .webm from audiovis into an Instagram-ready mp4.
#
# Usage: ./scripts/to-mp4.sh <input.webm> [output.mp4]
#
# Requires: ffmpeg (install with `brew install ffmpeg`)
#
# What it does:
#   - Re-encodes video to H.264 (yuv420p) for max compatibility with IG
#   - Copies audio as AAC 192k
#   - Preserves the 1080x1920 resolution and 60fps
#   - Ensures the output has a moov atom at the front so it streams cleanly

set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg not found. install with: brew install ffmpeg" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <input.webm> [output.mp4]" >&2
  exit 1
fi

IN="$1"
OUT="${2:-${IN%.webm}.mp4}"

if [[ ! -f "$IN" ]]; then
  echo "error: input file not found: $IN" >&2
  exit 1
fi

echo "→ converting $IN → $OUT"

ffmpeg -y -i "$IN" \
  -c:v libx264 -preset slow -crf 18 \
  -pix_fmt yuv420p \
  -movflags +faststart \
  -c:a aac -b:a 192k \
  "$OUT"

echo "✓ done: $OUT"
