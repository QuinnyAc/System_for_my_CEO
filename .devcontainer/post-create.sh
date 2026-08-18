#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

random_hex() {
  local bytes="$1"
  od -An -N"${bytes}" -tx1 /dev/urandom | tr -d ' \n'
}

APP_PASSWORD="$(random_hex 12)"
SESSION_SECRET="$(random_hex 32)"
CREDENTIALS_SECRET="$(random_hex 32)"
COLLECTOR_TOKEN="$(random_hex 24)"
GENERATED_LOGIN=false

replace_placeholder() {
  local key="$1"
  local placeholder="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"
  local replaced=false

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${key}=${placeholder}" ]]; then
      printf '%s=%s\n' "$key" "$value" >> "$tmp"
      replaced=true
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < .env

  mv "$tmp" .env
  [[ "$replaced" == "true" ]]
}

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  local found=false

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${key}="* ]]; then
      printf '%s=%s\n' "$key" "$value" >> "$tmp"
      found=true
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < .env

  if [[ "$found" != "true" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi

  mv "$tmp" .env
}

# Keep the requested application username in every Codespace without storing the password in Git.
set_env_value "APP_USERNAME" "WR"

if replace_placeholder "APP_PASSWORD" "GENERATE_ON_SETUP" "$APP_PASSWORD"; then
  GENERATED_LOGIN=true
fi
replace_placeholder "SESSION_SECRET" "GENERATE_ON_SETUP" "$SESSION_SECRET" || true
replace_placeholder "CREDENTIALS_SECRET" "GENERATE_ON_SETUP" "$CREDENTIALS_SECRET" || true
replace_placeholder "COLLECTOR_TOKEN" "GENERATE_ON_SETUP" "$COLLECTOR_TOKEN" || true

# Existing Codespaces may have an older .env created before the browser collector
# was added. Initialize the token if the key is missing or empty.
CURRENT_COLLECTOR_TOKEN="$(sed -n 's/^COLLECTOR_TOKEN=//p' .env | head -n1)"
if [[ -z "$CURRENT_COLLECTOR_TOKEN" || "$CURRENT_COLLECTOR_TOKEN" == "GENERATE_ON_SETUP" ]]; then
  set_env_value "COLLECTOR_TOKEN" "$COLLECTOR_TOKEN"
fi

if [[ -n "${CODESPACE_NAME:-}" ]]; then
  PORT_DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  WEB_URL="https://${CODESPACE_NAME}-3100.${PORT_DOMAIN}"
  set_env_value "PUBLIC_WEB_URL" "$WEB_URL"
  set_env_value "CORS_ORIGINS" "$WEB_URL"
fi

APP_USERNAME_VALUE="$(sed -n 's/^APP_USERNAME=//p' .env | head -n1)"
APP_USERNAME_VALUE="${APP_USERNAME_VALUE:-WR}"

if [[ "$GENERATED_LOGIN" == "true" ]]; then
  echo "Media Ops initial login created."
  echo "Username: ${APP_USERNAME_VALUE}"
  echo "Password: ${APP_PASSWORD}"
  echo "You can read it later from APP_PASSWORD in this repository's local .env file."
fi
