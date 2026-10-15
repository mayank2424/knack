#!/usr/bin/env bash
# One-time check for the token-drift scanner. It has zero npm dependencies,
# so all we need is Node.js 18 or newer.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "✖ Node.js is missing. Install Node 18+ and re-run:"
  echo "    macOS:   brew install node"
  echo "    Ubuntu:  https://github.com/nodesource/distributions"
  echo "    Windows: winget install OpenJS.NodeJS.LTS"
  exit 1
fi

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "✖ Node $(node -v) is too old; token-drift needs Node 18+. Upgrade (e.g. nvm install --lts) and re-run."
  exit 1
fi

node "$DIR/scan.mjs" --help >/dev/null
echo "✓ token-drift ready (Node $(node -v), no dependencies to install)"
