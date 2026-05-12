#!/usr/bin/env bash
set -o errexit

echo "Installing npm dependencies..."
npm install

echo "Installing Chrome for Puppeteer..."
npx puppeteer browsers install chrome

echo "Build complete!"