#!/usr/bin/env bash
set -euo pipefail

NEW_ENV=false
if [[ ! -f .env ]]; then
  cp .env.example .env
  NEW_ENV=true
fi

APP_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-18)"
SESSION_SECRET="$(openssl rand -hex 32)"
CREDENTIALS_SECRET="$(openssl rand -hex 32)"

python3 - "$APP_PASSWORD" "$SESSION_SECRET" "$CREDENTIALS_SECRET" <<'PY'
from pathlib import Path
import sys

password, session_secret, credentials_secret = sys.argv[1:4]
path = Path('.env')
lines = path.read_text().splitlines()
updates = {}
if any(line == 'APP_PASSWORD=GENERATE_ON_SETUP' for line in lines):
    updates['APP_PASSWORD'] = password
if any(line == 'SESSION_SECRET=GENERATE_ON_SETUP' for line in lines):
    updates['SESSION_SECRET'] = session_secret
if any(line == 'CREDENTIALS_SECRET=GENERATE_ON_SETUP' for line in lines):
    updates['CREDENTIALS_SECRET'] = credentials_secret
out=[]
for line in lines:
    key=line.split('=',1)[0] if '=' in line else ''
    out.append(f'{key}={updates[key]}' if key in updates else line)
path.write_text('\n'.join(out)+'\n')
PY

if [[ "${CODESPACES:-false}" == "true" ]]; then
  WEB_URL="https://${CODESPACE_NAME}-3100.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  python3 - "$WEB_URL" <<'PY'
from pathlib import Path
import sys
web_url=sys.argv[1]
path=Path('.env')
lines=path.read_text().splitlines()
updates={'PUBLIC_WEB_URL':web_url,'CORS_ORIGINS':web_url}
out=[]
for line in lines:
    key=line.split('=',1)[0] if '=' in line else ''
    out.append(f'{key}={updates[key]}' if key in updates else line)
path.write_text('\n'.join(out)+'\n')
PY
fi

if [[ "$NEW_ENV" == "true" ]]; then
  echo "Media Ops initial login created."
  echo "Username: admin"
  echo "Password: ${APP_PASSWORD}"
  echo "You can read it later from APP_PASSWORD in this repository's local .env file."
fi
