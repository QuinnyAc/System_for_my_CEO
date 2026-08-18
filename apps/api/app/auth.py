from datetime import datetime, timedelta, timezone
import hmac

import jwt
from jwt import InvalidTokenError

from app.config import settings

COOKIE_NAME = "media_ops_hub_session"


def credentials_valid(username: str, password: str) -> bool:
    return hmac.compare_digest(username, settings.app_username) and hmac.compare_digest(password, settings.app_password)


def create_session_token() -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": settings.app_username, "iat": now, "exp": now + timedelta(hours=12), "system": "media_ops_hub"}, settings.session_secret, algorithm="HS256")


def session_valid(token: str | None) -> bool:
    if not token:
        return False
    try:
        payload = jwt.decode(token, settings.session_secret, algorithms=["HS256"])
        return payload.get("sub") == settings.app_username and payload.get("system") == "media_ops_hub"
    except InvalidTokenError:
        return False
