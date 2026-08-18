#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

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

read_visible() {
  local prompt="$1"
  local var_name="$2"
  local value
  read -r -p "$prompt" value
  printf -v "$var_name" '%s' "$value"
}

read_secret() {
  local prompt="$1"
  local var_name="$2"
  local value
  read -r -s -p "$prompt" value
  printf '\n'
  printf -v "$var_name" '%s' "$value"
}

cat <<'EOF'

Media Ops API credential setup
Secrets entered here are written only to this Codespace's local .env file.
Do not paste secrets into chat or commit .env to Git.
Leave a value blank to keep the current value unchanged.

EOF

read_visible "YouTube API Key (optional): " YOUTUBE_API_KEY_VALUE
read_visible "Google OAuth Client ID: " GOOGLE_CLIENT_ID_VALUE
read_secret  "Google OAuth Client Secret: " GOOGLE_CLIENT_SECRET_VALUE

read_visible "Meta App ID: " META_APP_ID_VALUE
read_secret  "Meta App Secret: " META_APP_SECRET_VALUE
read_visible "Meta Graph API version (blank keeps current, e.g. v23.0): " META_GRAPH_VERSION_VALUE

read_visible "Pinterest App ID: " PINTEREST_APP_ID_VALUE
read_secret  "Pinterest App Secret: " PINTEREST_APP_SECRET_VALUE

[[ -n "$YOUTUBE_API_KEY_VALUE" ]] && set_env_value "YOUTUBE_API_KEY" "$YOUTUBE_API_KEY_VALUE"
[[ -n "$GOOGLE_CLIENT_ID_VALUE" ]] && set_env_value "GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_ID_VALUE"
[[ -n "$GOOGLE_CLIENT_SECRET_VALUE" ]] && set_env_value "GOOGLE_CLIENT_SECRET" "$GOOGLE_CLIENT_SECRET_VALUE"
[[ -n "$META_APP_ID_VALUE" ]] && set_env_value "META_APP_ID" "$META_APP_ID_VALUE"
[[ -n "$META_APP_SECRET_VALUE" ]] && set_env_value "META_APP_SECRET" "$META_APP_SECRET_VALUE"
[[ -n "$META_GRAPH_VERSION_VALUE" ]] && set_env_value "META_GRAPH_VERSION" "$META_GRAPH_VERSION_VALUE"
[[ -n "$PINTEREST_APP_ID_VALUE" ]] && set_env_value "PINTEREST_APP_ID" "$PINTEREST_APP_ID_VALUE"
[[ -n "$PINTEREST_APP_SECRET_VALUE" ]] && set_env_value "PINTEREST_APP_SECRET" "$PINTEREST_APP_SECRET_VALUE"

if [[ -n "${CODESPACE_NAME:-}" ]]; then
  PORT_DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  PUBLIC_URL="https://${CODESPACE_NAME}-3100.${PORT_DOMAIN}"
  set_env_value "PUBLIC_WEB_URL" "$PUBLIC_URL"
  set_env_value "CORS_ORIGINS" "$PUBLIC_URL"
fi

echo
printf 'Saved API configuration to local .env.\n'
printf 'Recreating API and Web containers so the new configuration is loaded...\n'
docker compose up -d --force-recreate api web
printf 'Done. Open API 设置 in the website to confirm provider status.\n'
