#!/usr/bin/env bash
set -o errexit

npm install

# Install Chromium using Puppeteer's browser installer
npx puppeteer browsers install chrome

# Create a config file to point to the cache directory
mkdir -p .cache/puppeteer
echo "const { join } = require('path'); module.exports = { cacheDirectory: join(process.cwd(), '.cache', 'puppeteer') };" > .puppeteerrc.cjs