#!/usr/bin/env bash
# One-time setup for the motion-video renderer: installs Playwright next to
# these scripts and makes sure a Chromium build and ffmpeg are available.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ ! -d node_modules/playwright ]; then
  echo "◆ Installing Playwright into $DIR"
  npm install --silent --no-audit --no-fund
fi

if ! node -e "require('playwright').chromium.executablePath()" >/dev/null 2>&1 \
   || [ ! -e "$(node -e "process.stdout.write(require('playwright').chromium.executablePath())")" ]; then
  echo "◆ Installing Chromium for Playwright (one-time, ~150 MB)"
  npx --yes playwright install chromium
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "✖ ffmpeg is missing. Install it, then re-run:"
  echo "    macOS:   brew install ffmpeg"
  echo "    Ubuntu:  sudo apt-get install -y ffmpeg"
  echo "    Windows: winget install Gyan.FFmpeg"
  exit 1
fi
echo "✓ motion-video renderer ready"
