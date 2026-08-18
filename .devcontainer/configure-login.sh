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

USERNAME_VALUE="WR"
read -r -s -p "New Media Ops password: " PASSWORD_VALUE
printf '\n'
if [[ -z "$PASSWORD_VALUE" ]]; then
  echo "Password cannot be empty." >&2
  exit 1
fi

set_env_value "APP_USERNAME" "$USERNAME_VALUE"
set_env_value "APP_PASSWORD" "$PASSWORD_VALUE"
unset PASSWORD_VALUE

docker compose up -d --force-recreate api web
printf 'Login updated. Username: %s\n' "$USERNAME_VALUE"
