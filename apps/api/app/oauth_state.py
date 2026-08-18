from datetime import datetime, timedelta, timezone
from uuid import UUID

import jwt
from jwt import InvalidTokenError

from app.config import settings


class OAuthStateError(RuntimeError):
    pass


def create_oauth_state(account_id: UUID, provider: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "system": "zeno_social_ops",
            "type": "provider_oauth",
            "account_id": str(account_id),
            "provider": provider,
            "iat": now,
            "exp": now + timedelta(minutes=15),
        },
        settings.session_secret,
        algorithm="HS256",
    )


def decode_oauth_state(token: str, expected_provider: str) -> UUID:
    try:
        payload = jwt.decode(token, settings.session_secret, algorithms=["HS256"])
        if payload.get("system") != "zeno_social_ops" or payload.get("type") != "provider_oauth":
            raise InvalidTokenError("unexpected state")
        if payload.get("provider") != expected_provider:
            raise InvalidTokenError("provider mismatch")
        return UUID(str(payload["account_id"]))
    except (InvalidTokenError, KeyError, TypeError, ValueError) as exc:
        raise OAuthStateError("授权状态无效或已过期，请重新连接账号。") from exc
