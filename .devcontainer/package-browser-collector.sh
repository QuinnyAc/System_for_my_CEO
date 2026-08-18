#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v zip >/dev/null 2>&1; then
  echo "zip command is not installed in this Codespace." >&2
  exit 1
fi

OUTPUT="media-ops-public-collector.zip"
rm -f "$OUTPUT"
zip -qr "$OUTPUT" browser-collector -x "*/.DS_Store"

echo "Created: $ROOT/$OUTPUT"
echo "Download this ZIP, unzip it on each computer, then load the browser-collector folder in chrome://extensions."
