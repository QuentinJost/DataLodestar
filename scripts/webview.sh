#!/usr/bin/env bash
# Runs the webview checks (scripts/webview/*.test.js) in headless Chromium, inside the Playwright
# image whose browsers match the playwright-core devDependency.
# HOST_DIR: path of this folder as seen by the Docker daemon (defaults to $PWD).
set -euo pipefail
cd "$(dirname "$0")/.."
HOST_DIR="${HOST_DIR:-$PWD}"
VERSION=$(node -p "require('./node_modules/playwright-core/package.json').version")
docker run --rm --init -v "$HOST_DIR":/ext -w /ext "mcr.microsoft.com/playwright:v$VERSION-jammy" \
  sh -c 'node --test scripts/webview/*.test.js'
