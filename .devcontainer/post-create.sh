#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

if [[ "${CODESPACES:-false}" == "true" ]]; then
  WEB_URL="https://${CODESPACE_NAME}-3100.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  python3 - "$WEB_URL" <<'PY'
from pathlib import Path
import sys

web_url = sys.argv[1]
path = Path('.env')
lines = path.read_text().splitlines()
updates = {
    'PUBLIC_WEB_URL': web_url,
    'CORS_ORIGINS': web_url,
}
seen = set()
out = []
for line in lines:
    key = line.split('=', 1)[0] if '=' in line else ''
    if key in updates:
        out.append(f'{key}={updates[key]}')
        seen.add(key)
    else:
        out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f'{key}={value}')
path.write_text('\n'.join(out) + '\n')
PY
fi
