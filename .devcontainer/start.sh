#!/usr/bin/env bash
set -euo pipefail

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not ready yet."
  exit 0
fi

docker compose up -d --build

if [[ "${CODESPACES:-false}" == "true" ]] && command -v gh >/dev/null 2>&1; then
  gh codespace ports visibility 3100:public -c "${CODESPACE_NAME}" >/dev/null 2>&1 || true
fi

echo "ZenoMinerals Social Ops starting on web port 3100."
