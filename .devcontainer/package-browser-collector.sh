#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v zip >/dev/null 2>&1; then
  echo "zip command is not installed in this Codespace." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed in this Codespace." >&2
  exit 1
fi

node --check browser-collector/service-worker.js >/dev/null
node --check browser-collector/content-script.js >/dev/null
node --check browser-collector/youtube-account-metrics.js >/dev/null
node --check browser-collector/youtube-main-world.js >/dev/null
node --check browser-collector/options.js >/dev/null

MANIFEST_VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('browser-collector/manifest.json','utf8')).version)")"
node - <<'NODE'
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('browser-collector/manifest.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error(`Invalid extension version: ${manifest.version}`);
}
const contentScript = fs.readFileSync('browser-collector/content-script.js', 'utf8');
const versionMatch = contentScript.match(/const VERSION = \"([^\"]+)\"/);
if (!versionMatch) throw new Error('content-script.js VERSION is missing');
if (versionMatch[1] !== manifest.version) {
  throw new Error(`Extension version mismatch: manifest=${manifest.version} content-script=${versionMatch[1]}`);
}
const mainWorld = (manifest.content_scripts || []).find((entry) =>
  entry.world === 'MAIN' && Array.isArray(entry.js) && entry.js.includes('youtube-main-world.js')
);
if (!mainWorld) throw new Error('youtube-main-world.js is not registered in MAIN world');
NODE

OUTPUT="media-ops-public-collector.zip"
rm -f "$OUTPUT"
zip -qr "$OUTPUT" browser-collector -x "*/.DS_Store" "*/__MACOSX/*"

echo "Collector extension checks passed. Version: $MANIFEST_VERSION"
echo "Created: $ROOT/$OUTPUT"
echo "Download this ZIP, unzip it, then load the browser-collector folder in chrome://extensions."
