#!/usr/bin/env bash
set -euo pipefail

if [[ "${CODESPACES:-false}" == "true" ]]; then
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

for port in 3100 8100; do
  for _ in $(seq 1 90); do
    if curl -fsS "http://localhost:${port}" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
done

if [[ "${CODESPACES:-false}" == "true" ]] && command -v gh >/dev/null 2>&1; then
  gh codespace ports visibility 3100:public -c "${CODESPACE_NAME}" >/dev/null 2>&1 || true
  WEB_URL="https://${CODESPACE_NAME}-3100.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
else
  WEB_URL="http://localhost:3100"
fi

cat <<EOF

Media Ops is ready.
Web: ${WEB_URL}
API: proxied through ${WEB_URL}/api/v1
Login username: admin
Login password: read APP_PASSWORD from this repository's local .env file

EOF
