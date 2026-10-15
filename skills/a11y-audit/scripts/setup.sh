#!/usr/bin/env bash
# One-time setup for a11y-audit: installs Playwright + axe-core next to these
# scripts and makes sure a Chromium build is available. Safe to re-run.
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

if [ ! -d node_modules/playwright ] || [ ! -f node_modules/axe-core/axe.min.js ]; then
  echo "◆ Installing Playwright + axe-core into $DIR"
  npm install --silent --no-audit --no-fund
fi

if ! node -e "require('playwright').chromium.executablePath()" >/dev/null 2>&1 \
   || [ ! -e "$(node -e "process.stdout.write(require('playwright').chromium.executablePath())")" ]; then
  echo "◆ Installing Chromium for Playwright (one-time, ~150 MB)"
  npx --yes playwright install chromium || {
    echo "⚠ Chromium download failed. audit.mjs will fall back to an installed Chrome or Edge if present."
  }
fi
echo "✓ a11y-audit ready ($(node -p "'axe-core ' + require('axe-core/package.json').version"))"
