#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  echo "Local .env not found. Run bash .devcontainer/start.sh first." >&2
  exit 1
fi

TOKEN="$(sed -n 's/^COLLECTOR_TOKEN=//p' .env | head -n1)"
if [[ -z "$TOKEN" || "$TOKEN" == "GENERATE_ON_SETUP" ]]; then
  echo "Collector token is not initialized. Run bash .devcontainer/start.sh first." >&2
  exit 1
fi

if [[ -n "${CODESPACE_NAME:-}" ]]; then
  DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  URL="https://${CODESPACE_NAME}-3100.${DOMAIN}/collector"
else
  URL="http://localhost:3100/collector"
fi

cat <<EOF
Browser Collector setup
Collector URL: ${URL}
Collector Token: ${TOKEN}

Keep this token private. Enter it only in the Media Ops browser collector extension on company computers.
EOF
