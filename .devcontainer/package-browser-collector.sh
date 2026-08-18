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
node --check browser-collector/options.js >/dev/null

MANIFEST_VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('browser-collector/manifest.json','utf8')).version)")"
SCRIPT_VERSION="$(node -e "const s=require('fs').readFileSync('browser-collector/content-script.js','utf8'); const m=s.match(/const VERSION = \\\"([^\\\"]+)\\\"/); if(!m) process.exit(2); process.stdout.write(m[1])")"
if [[ "$MANIFEST_VERSION" != "$SCRIPT_VERSION" ]]; then
  echo "Extension version mismatch: manifest=$MANIFEST_VERSION content-script=$SCRIPT_VERSION" >&2
  exit 1
fi

OUTPUT="media-ops-public-collector.zip"
rm -f "$OUTPUT"
zip -qr "$OUTPUT" browser-collector -x "*/.DS_Store" "*/__MACOSX/*"

echo "Collector extension checks passed. Version: $MANIFEST_VERSION"
echo "Created: $ROOT/$OUTPUT"
echo "Download this ZIP, unzip it, then load the browser-collector folder in chrome://extensions."
