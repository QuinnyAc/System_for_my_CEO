from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.credential_crypto import decrypt_secret, encrypt_secret
from app.models import PlatformConnection
from app.providers import pinterest, youtube


class ConnectionError(RuntimeError):
    pass


REFRESH_MARGIN = timedelta(minutes=5)


def get_connection(db: Session, account_id: UUID) -> PlatformConnection | None:
    return db.scalar(select(PlatformConnection).where(PlatformConnection.account_id == account_id))


def store_connection(
    db: Session,
    account_id: UUID,
    *,
    provider: str,
    access_token: str,
    refresh_token: str = "",
    expires_at: datetime | None = None,
    scopes: list[str] | None = None,
    provider_metadata: dict | None = None,
) -> PlatformConnection:
    connection = get_connection(db, account_id)
    if connection is None:
        connection = PlatformConnection(
            account_id=account_id,
            provider=provider,
            access_token_encrypted=encrypt_secret(access_token),
            refresh_token_encrypted=encrypt_secret(refresh_token) if refresh_token else None,
            token_expires_at=expires_at,
            scopes=scopes or [],
            provider_metadata=provider_metadata or {},
            status="connected",
            last_error=None,
        )
        db.add(connection)
    else:
        connection.provider = provider
        connection.access_token_encrypted = encrypt_secret(access_token)
        if refresh_token:
            connection.refresh_token_encrypted = encrypt_secret(refresh_token)
        connection.token_expires_at = expires_at
        connection.scopes = scopes or connection.scopes
        connection.provider_metadata = provider_metadata or connection.provider_metadata
        connection.status = "connected"
        connection.last_error = None
    db.commit()
    db.refresh(connection)
    return connection


def mark_sync_result(db: Session, connection: PlatformConnection, *, error: str | None = None) -> None:
    connection.last_synced_at = datetime.now(timezone.utc)
    connection.last_error = error
    connection.status = "error" if error else "connected"
    db.commit()


def _expires_soon(expires_at: datetime | None) -> bool:
    if expires_at is None:
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= datetime.now(timezone.utc) + REFRESH_MARGIN


def active_access_token(db: Session, connection: PlatformConnection) -> str:
    token = decrypt_secret(connection.access_token_encrypted)
    if not _expires_soon(connection.token_expires_at):
        return token

    refresh_token = decrypt_secret(connection.refresh_token_encrypted)
    if connection.provider == "google":
        if not refresh_token or not settings.google_oauth_configured:
            raise ConnectionError("Google 授权已过期，请重新连接 YouTube 账号。")
        refreshed = youtube.refresh_access_token(refresh_token, settings.google_client_id, settings.google_client_secret)
        store_connection(
            db,
            connection.account_id,
            provider="google",
            access_token=refreshed.access_token,
            refresh_token=refresh_token,
            expires_at=refreshed.expires_at,
            scopes=refreshed.scopes,
            provider_metadata=connection.provider_metadata,
        )
        return refreshed.access_token

    if connection.provider == "pinterest":
        if not refresh_token or not settings.pinterest_oauth_configured:
            raise ConnectionError("Pinterest 授权已过期，请重新连接账号。")
        refreshed = pinterest.refresh_access_token(
            refresh_token,
            settings.pinterest_app_id,
            settings.pinterest_app_secret,
        )
        store_connection(
            db,
            connection.account_id,
            provider="pinterest",
            access_token=refreshed.access_token,
            refresh_token=refreshed.refresh_token or refresh_token,
            expires_at=refreshed.expires_at,
            scopes=refreshed.scopes,
            provider_metadata=connection.provider_metadata,
        )
        return refreshed.access_token

    if connection.provider == "meta":
        raise ConnectionError("Meta 授权已过期，请重新连接 Facebook / Instagram 账号。")

    raise ConnectionError("未知的平台授权类型，请重新连接账号。")
