#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

APP_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-18)"
SESSION_SECRET="$(openssl rand -hex 32)"
CREDENTIALS_SECRET="$(openssl rand -hex 32)"
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

if replace_placeholder "APP_PASSWORD" "GENERATE_ON_SETUP" "$APP_PASSWORD"; then
  GENERATED_LOGIN=true
fi
replace_placeholder "SESSION_SECRET" "GENERATE_ON_SETUP" "$SESSION_SECRET" || true
replace_placeholder "CREDENTIALS_SECRET" "GENERATE_ON_SETUP" "$CREDENTIALS_SECRET" || true

if [[ "${CODESPACES:-false}" == "true" ]]; then
  WEB_URL="https://${CODESPACE_NAME}-3100.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  set_env_value "PUBLIC_WEB_URL" "$WEB_URL"
  set_env_value "CORS_ORIGINS" "$WEB_URL"
fi

if [[ "$GENERATED_LOGIN" == "true" ]]; then
  echo "Media Ops initial login created."
  echo "Username: admin"
  echo "Password: ${APP_PASSWORD}"
  echo "You can read it later from APP_PASSWORD in this repository's local .env file."
fi
