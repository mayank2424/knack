#!/usr/bin/env bash
# One-time setup for pr-visual-diff: installs Playwright, pixelmatch and pngjs
# next to these scripts and makes sure a Chromium build is available.
# Idempotent: safe to run before every session.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "✖ Node.js 18+ is required. Install it from https://nodejs.org (or: brew install node), then re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✖ Node.js 18+ is required (found $(node -v)). Upgrade Node, then re-run."
  exit 1
fi

if [ ! -d node_modules/playwright ] || [ ! -d node_modules/pixelmatch ] || [ ! -d node_modules/pngjs ]; then
  echo "◆ Installing Playwright, pixelmatch and pngjs into $DIR"
  npm install --silent --no-audit --no-fund
fi

if ! node -e "require('playwright').chromium.executablePath()" >/dev/null 2>&1 \
   || [ ! -e "$(node -e "process.stdout.write(require('playwright').chromium.executablePath())")" ]; then
  if command -v google-chrome >/dev/null 2>&1 || [ -d "/Applications/Google Chrome.app" ]; then
    echo "◆ Playwright Chromium not found; scripts will fall back to your installed Chrome."
    echo "  (For pixel-identical results across machines, run: npx playwright install chromium)"
  else
    echo "◆ Installing Chromium for Playwright (one-time, ~150 MB)"
    npx --yes playwright install chromium
  fi
fi

if ! command -v git >/dev/null 2>&1; then
  echo "⚠ git not found: capture.mjs works, but worktree-serve.mjs and affected-pages.mjs need git."
fi
echo "✓ pr-visual-diff ready"
