#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${CODESPACE_NAME:-}" ]]; then
  bash .devcontainer/post-create.sh >/dev/null
fi

echo "Waiting for Docker daemon..."
for _ in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon did not become ready in time." >&2
  exit 1
fi

echo "Starting Media Ops..."
docker compose up -d --build

wait_for_url() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 90); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "$label is ready."
      return 0
    fi
    sleep 2
  done
  echo "$label did not become ready in time: $url" >&2
  return 1
}

wait_for_url "http://localhost:3100/" "Web"
wait_for_url "http://localhost:8100/health" "API"

if [[ -n "${CODESPACE_NAME:-}" ]]; then
  PORT_DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  if command -v gh >/dev/null 2>&1; then
    gh codespace ports visibility 3100:public -c "${CODESPACE_NAME}" >/dev/null 2>&1 || true
  fi
  WEB_URL="https://${CODESPACE_NAME}-3100.${PORT_DOMAIN}"
else
  WEB_URL="http://localhost:3100"
fi

APP_USERNAME_VALUE="$(sed -n 's/^APP_USERNAME=//p' .env | head -n1)"
APP_USERNAME_VALUE="${APP_USERNAME_VALUE:-Quinny/WR}"

cat <<EOF

Media Ops is ready.
Web: ${WEB_URL}
API: proxied through ${WEB_URL}/api/v1
Login username: ${APP_USERNAME_VALUE}
Login password: read APP_PASSWORD from this repository's local .env file

EOF
