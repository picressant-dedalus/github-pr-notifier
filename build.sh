#!/bin/bash
# Packages the extension into dist/chrome.zip (upload to the Chrome Web Store or share it).
# Only runtime files are shipped: no tests, scripts or node_modules.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist/chrome
cp -r css img js manifest.json popup.html options.html dist/chrome
(cd dist/chrome && zip -qr ../chrome.zip .)
echo "Built dist/chrome.zip"
