#!/usr/bin/env bash
set -o errexit

echo "Installing npm dependencies..."
npm install

# Set Puppeteer cache directory
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

echo "Installing Chrome via Puppeteer..."
npx puppeteer browsers install chrome

# Copy to persistent cache directory (Render-specific)
if [ -d "/opt/render/project/src/.cache/puppeteer/chrome" ]; then
  echo "Copying Chrome to build cache..."
  cp -R /opt/render/project/src/.cache/puppeteer/chrome/* $PUPPETEER_CACHE_DIR/chrome/ || true
fi

echo "Build completed."