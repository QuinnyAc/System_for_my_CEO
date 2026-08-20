#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v zip >/dev/null 2>&1; then
  echo "zip command is not installed in this Codespace." >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  NODE=(node)
  echo "Collector validation runtime: host Node"
elif command -v docker >/dev/null 2>&1; then
  NODE=(docker run --rm -v "$ROOT:/workspace" -w /workspace node:22-alpine node)
  echo "Collector validation runtime: Docker Node 22"
else
  echo "Neither node nor docker is available in this Codespace." >&2
  exit 1
fi

"${NODE[@]}" --check browser-collector/service-worker.js >/dev/null
"${NODE[@]}" --check browser-collector/service-worker-entry.js >/dev/null
"${NODE[@]}" --check browser-collector/content-script.js >/dev/null
"${NODE[@]}" --check browser-collector/youtube-account-metrics.js >/dev/null
"${NODE[@]}" --check browser-collector/youtube-main-world.js >/dev/null
"${NODE[@]}" --check browser-collector/youtube-followers-fallback.js >/dev/null
"${NODE[@]}" --check browser-collector/options.js >/dev/null
"${NODE[@]}" browser-collector/tests/youtube-followers-completion-guard.test.js

MANIFEST_VERSION="$("${NODE[@]}" -e "process.stdout.write(JSON.parse(require('fs').readFileSync('browser-collector/manifest.json','utf8')).version)")"
"${NODE[@]}" - <<'NODE'
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('browser-collector/manifest.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error(`Invalid extension version: ${manifest.version}`);
}
const contentScript = fs.readFileSync('browser-collector/content-script.js', 'utf8');
const versionMatch = contentScript.match(/const VERSION = \"([^\"]+)\"/);
if (!versionMatch) throw new Error('content-script.js VERSION is missing');
if (!/^\d+\.\d+\.\d+$/.test(versionMatch[1])) {
  throw new Error(`Invalid collector payload version: ${versionMatch[1]}`);
}
const mainWorld = (manifest.content_scripts || []).find((entry) =>
  entry.world === 'MAIN' && Array.isArray(entry.js) && entry.js.includes('youtube-main-world.js')
);
if (!mainWorld) throw new Error('youtube-main-world.js is not registered in MAIN world');
const youtubeIsolated = (manifest.content_scripts || []).find((entry) =>
  !entry.world && Array.isArray(entry.js) && entry.js.includes('youtube-account-metrics.js')
);
if (!youtubeIsolated || !youtubeIsolated.js.includes('youtube-followers-fallback.js')) {
  throw new Error('youtube-followers-fallback.js is not registered with the YouTube account collector');
}
if (manifest.background?.service_worker !== 'service-worker-entry.js') {
  throw new Error(`Unexpected background service worker: ${manifest.background?.service_worker || 'missing'}`);
}
NODE

OUTPUT="media-ops-public-collector.zip"
rm -f "$OUTPUT"
zip -qr "$OUTPUT" browser-collector -x "*/.DS_Store" "*/__MACOSX/*"

echo "Collector extension checks passed. Version: $MANIFEST_VERSION"
echo "Created: $ROOT/$OUTPUT"
echo "Download this ZIP, unzip it, then load the browser-collector folder in chrome://extensions."
