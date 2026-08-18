from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import COOKIE_NAME, create_session_token, credentials_valid, session_valid
from app.config import settings
from app.connections import ConnectionError, active_access_token, get_connection, mark_sync_result, store_connection
from app.credential_crypto import CredentialCryptoError
from app.db import Base, SessionLocal, engine, get_db
from app.models import (
    AccountMetricSnapshot,
    ContentMetricSnapshot,
    Platform,
    PlatformConnection,
    PublishedContent,
    SocialAccount,
    SyncLog,
)
from app.oauth_state import OAuthStateError, create_oauth_state, decode_oauth_state
from app.providers import meta, pinterest, youtube
from app.schemas import (
    AccountCreate,
    AccountMetricCreate,
    AccountMetricRead,
    AccountRead,
    AuthorizeUrlRead,
    ConnectionStatusRead,
    ContentCreate,
    ContentMetricCreate,
    ContentMetricRead,
    ContentRead,
    ImportResult,
    PlatformRead,
    SyncLogRead,
)

PLATFORMS = {
    "youtube": "YouTube",
    "instagram": "Instagram",
    "facebook": "Facebook",
    "pinterest": "Pinterest",
}

app = FastAPI(title="ZenoMinerals Social Ops API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoginRequest(BaseModel):
    username: str
    password: str


def seed_platforms() -> None:
    with SessionLocal() as db:
        existing = {p.slug for p in db.scalars(select(Platform)).all()}
        for slug, name in PLATFORMS.items():
            if slug not in existing:
                db.add(Platform(slug=slug, name=name))
        db.commit()


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    seed_platforms()


@app.middleware("http")
async def require_app_session(request: Request, call_next):
    path = request.url.path
    public_api_paths = {"/api/v1/auth/login", "/api/v1/auth/status"}
    oauth_callback = path.startswith("/api/v1/oauth/")
    if path.startswith("/api/v1/") and path not in public_api_paths and not oauth_callback:
        if not session_valid(request.cookies.get(COOKIE_NAME)):
            return Response(
                content='{"detail":"Authentication required"}',
                status_code=401,
                media_type="application/json",
            )
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "system": "zeno_social_ops"}


@app.post("/api/v1/auth/login")
def login(payload: LoginRequest, response: Response):
    if not credentials_valid(payload.username, payload.password):
        raise HTTPException(status_code=401, detail="用户名或密码不正确")
    response.set_cookie(
        COOKIE_NAME,
        create_session_token(),
        httponly=True,
        secure=settings.public_web_url.startswith("https://"),
        samesite="lax",
        max_age=60 * 60 * 12,
        path="/",
    )
    return {"authenticated": True, "username": settings.app_username}


@app.post("/api/v1/auth/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"authenticated": False}


@app.get("/api/v1/auth/status")
def auth_status(request: Request):
    return {"authenticated": session_valid(request.cookies.get(COOKIE_NAME))}


def _account_platform(db: Session, account_id: UUID) -> tuple[SocialAccount, Platform]:
    account = db.get(SocialAccount, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="账号不存在")
    platform = db.get(Platform, account.platform_id)
    if platform is None:
        raise HTTPException(status_code=404, detail="平台不存在")
    return account, platform


def _content_context(db: Session, content_id: UUID) -> tuple[PublishedContent, SocialAccount, Platform]:
    item = db.get(PublishedContent, content_id)
    if item is None:
        raise HTTPException(status_code=404, detail="内容不存在")
    account, platform = _account_platform(db, item.account_id)
    return item, account, platform


def _provider_configured(slug: str) -> bool:
    if slug == "youtube":
        return settings.google_oauth_configured or bool(settings.youtube_api_key)
    if slug in {"facebook", "instagram"}:
        return settings.meta_oauth_configured
    if slug == "pinterest":
        return settings.pinterest_oauth_configured
    return False


def _callback_url(slug: str) -> str | None:
    if slug == "youtube":
        return settings.google_callback_url
    if slug in {"facebook", "instagram"}:
        return settings.meta_callback_url
    if slug == "pinterest":
        return settings.pinterest_callback_url
    return None


def _log(db: Session, provider: str, target_type: str, target_id: UUID, result: str, message: str = "", details: dict | None = None) -> None:
    db.add(
        SyncLog(
            provider=provider,
            target_type=target_type,
            target_id=target_id,
            status=result,
            message=message or None,
            details=details or {},
        )
    )
    db.commit()


def _connection_status(db: Session, account: SocialAccount, platform: Platform) -> ConnectionStatusRead:
    connection = get_connection(db, account.id)
    return ConnectionStatusRead(
        account_id=account.id,
        platform_slug=platform.slug,
        configured=_provider_configured(platform.slug),
        connected=connection is not None and connection.status in {"connected", "error"},
        status=connection.status if connection else "not_connected",
        scopes=connection.scopes if connection else [],
        expires_at=connection.token_expires_at if connection else None,
        last_synced_at=connection.last_synced_at if connection else None,
        last_error=connection.last_error if connection else None,
        callback_url=_callback_url(platform.slug),
    )


@app.get("/api/v1/platforms", response_model=list[PlatformRead])
def list_platforms(db: Session = Depends(get_db)):
    return list(db.scalars(select(Platform).order_by(Platform.name)))


@app.get("/api/v1/providers/status")
def provider_status():
    return {
        "youtube": {
            "api_key": bool(settings.youtube_api_key),
            "oauth": settings.google_oauth_configured,
            "callback_url": settings.google_callback_url,
        },
        "instagram": {"oauth": settings.meta_oauth_configured, "callback_url": settings.meta_callback_url},
        "facebook": {"oauth": settings.meta_oauth_configured, "callback_url": settings.meta_callback_url},
        "pinterest": {"oauth": settings.pinterest_oauth_configured, "callback_url": settings.pinterest_callback_url},
    }


@app.get("/api/v1/accounts", response_model=list[AccountRead])
def list_accounts(db: Session = Depends(get_db)):
    return list(db.scalars(select(SocialAccount).order_by(SocialAccount.created_at.desc())))


@app.post("/api/v1/accounts", response_model=AccountRead, status_code=status.HTTP_201_CREATED)
def create_account(payload: AccountCreate, db: Session = Depends(get_db)):
    if db.get(Platform, payload.platform_id) is None:
        raise HTTPException(status_code=400, detail="Platform not found")
    account = SocialAccount(**payload.model_dump())
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


@app.delete("/api/v1/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(account_id: UUID, db: Session = Depends(get_db)):
    account = db.get(SocialAccount, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="Account not found")
    db.delete(account)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/api/v1/accounts/{account_id}/connection", response_model=ConnectionStatusRead)
def connection_status(account_id: UUID, db: Session = Depends(get_db)):
    account, platform = _account_platform(db, account_id)
    return _connection_status(db, account, platform)


@app.get("/api/v1/accounts/connections", response_model=list[ConnectionStatusRead])
def all_connection_statuses(db: Session = Depends(get_db)):
    result: list[ConnectionStatusRead] = []
    for account in db.scalars(select(SocialAccount).order_by(SocialAccount.created_at.desc())):
        platform = db.get(Platform, account.platform_id)
        if platform:
            result.append(_connection_status(db, account, platform))
    return result


@app.get("/api/v1/accounts/{account_id}/authorize-url", response_model=AuthorizeUrlRead)
def authorize_url(account_id: UUID, db: Session = Depends(get_db)):
    account, platform = _account_platform(db, account_id)
    if platform.slug == "youtube":
        if not settings.google_oauth_configured:
            raise HTTPException(status_code=422, detail="请先配置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET。")
        state_token = create_oauth_state(account.id, "google")
        return AuthorizeUrlRead(
            url=youtube.build_authorize_url(settings.google_client_id, settings.google_callback_url, state_token),
            callback_url=settings.google_callback_url,
        )
    if platform.slug in {"facebook", "instagram"}:
        if not settings.meta_oauth_configured:
            raise HTTPException(status_code=422, detail="请先配置 META_APP_ID 和 META_APP_SECRET。")
        state_token = create_oauth_state(account.id, "meta")
        return AuthorizeUrlRead(
            url=meta.build_authorize_url(settings.meta_app_id, settings.meta_graph_version, settings.meta_callback_url, state_token),
            callback_url=settings.meta_callback_url,
        )
    if platform.slug == "pinterest":
        if not settings.pinterest_oauth_configured:
            raise HTTPException(status_code=422, detail="请先配置 PINTEREST_APP_ID 和 PINTEREST_APP_SECRET。")
        state_token = create_oauth_state(account.id, "pinterest")
        return AuthorizeUrlRead(
            url=pinterest.build_authorize_url(settings.pinterest_app_id, settings.pinterest_callback_url, state_token),
            callback_url=settings.pinterest_callback_url,
        )
    raise HTTPException(status_code=422, detail="该平台暂不支持授权。")


@app.delete("/api/v1/accounts/{account_id}/connection", status_code=status.HTTP_204_NO_CONTENT)
def disconnect_account(account_id: UUID, db: Session = Depends(get_db)):
    account, _ = _account_platform(db, account_id)
    connection = get_connection(db, account.id)
    if connection:
        db.delete(connection)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _redirect(status_value: str, platform: str) -> RedirectResponse:
    return RedirectResponse(
        url=f"{settings.normalized_public_web_url}/accounts?connection={platform}&status={status_value}",
        status_code=status.HTTP_302_FOUND,
    )


@app.get("/api/v1/oauth/google/callback", include_in_schema=False)
def google_callback(code: str, state: str, db: Session = Depends(get_db)):
    try:
        account_id = decode_oauth_state(state, "google")
        account, platform = _account_platform(db, account_id)
        if platform.slug != "youtube":
            raise OAuthStateError("平台不匹配")
        tokens = youtube.exchange_code(code, settings.google_client_id, settings.google_client_secret, settings.google_callback_url)
        channel = youtube.fetch_authenticated_channel(tokens.access_token)
        snippet = channel.get("snippet") or {}
        channel_id = str(channel.get("id") or "")
        account.external_id = channel_id
        account.name = str(snippet.get("title") or account.name)
        custom_url = str(snippet.get("customUrl") or "")
        if custom_url:
            account.handle = custom_url
        account.profile_url = f"https://www.youtube.com/channel/{channel_id}" if channel_id else account.profile_url
        store_connection(
            db,
            account.id,
            provider="google",
            access_token=tokens.access_token,
            refresh_token=tokens.refresh_token,
            expires_at=tokens.expires_at,
            scopes=tokens.scopes,
            provider_metadata={"channel_id": channel_id},
        )
        db.commit()
        return _redirect("connected", "youtube")
    except (OAuthStateError, youtube.YouTubeApiError, HTTPException, CredentialCryptoError):
        return _redirect("error", "youtube")


@app.get("/api/v1/oauth/meta/callback", include_in_schema=False)
def meta_callback(code: str, state: str, db: Session = Depends(get_db)):
    platform_slug = "meta"
    try:
        account_id = decode_oauth_state(state, "meta")
        account, platform = _account_platform(db, account_id)
        platform_slug = platform.slug
        if platform.slug not in {"facebook", "instagram"}:
            raise OAuthStateError("平台不匹配")
        short = meta.exchange_code(code, settings.meta_app_id, settings.meta_app_secret, settings.meta_graph_version, settings.meta_callback_url)
        token = meta.extend_user_token(short.access_token, settings.meta_app_id, settings.meta_app_secret, settings.meta_graph_version)
        pages = meta.fetch_managed_pages(token.access_token, settings.meta_graph_version)
        asset = meta.resolve_managed_asset(
            platform_slug=platform.slug,
            account_external_id=account.external_id,
            handle=account.handle,
            account_name=account.name,
            pages=pages,
        )
        page_access_token = str(asset.get("access_token") or "")
        if not page_access_token:
            raise meta.MetaApiError("Meta 没有返回 Page Access Token。")
        account.external_id = str(asset.get("id") or account.external_id or "")
        if platform.slug == "instagram":
            username = str(asset.get("username") or "")
            if username:
                account.handle = f"@{username}"
                account.profile_url = f"https://www.instagram.com/{username}/"
        store_connection(
            db,
            account.id,
            provider="meta",
            access_token=page_access_token,
            expires_at=token.expires_at,
            scopes=token.scopes,
            provider_metadata={
                "page_id": str(asset.get("page_id") or asset.get("id") or ""),
                "asset_id": str(asset.get("id") or ""),
            },
        )
        db.commit()
        return _redirect("connected", platform.slug)
    except (OAuthStateError, meta.MetaApiError, HTTPException, CredentialCryptoError):
        return _redirect("error", platform_slug)


@app.get("/api/v1/oauth/pinterest/callback", include_in_schema=False)
def pinterest_callback(code: str, state: str, db: Session = Depends(get_db)):
    try:
        account_id = decode_oauth_state(state, "pinterest")
        account, platform = _account_platform(db, account_id)
        if platform.slug != "pinterest":
            raise OAuthStateError("平台不匹配")
        tokens = pinterest.exchange_code(code, settings.pinterest_app_id, settings.pinterest_app_secret, settings.pinterest_callback_url)
        profile = pinterest.fetch_user_account(tokens.access_token)
        username = str(profile.get("username") or "")
        external_id = str(profile.get("id") or username or account.external_id or "")
        if external_id:
            account.external_id = external_id
        if username:
            account.handle = f"@{username}"
            account.profile_url = f"https://www.pinterest.com/{username}/"
        store_connection(
            db,
            account.id,
            provider="pinterest",
            access_token=tokens.access_token,
            refresh_token=tokens.refresh_token,
            expires_at=tokens.expires_at,
            scopes=tokens.scopes,
            provider_metadata={"username": username},
        )
        db.commit()
        return _redirect("connected", "pinterest")
    except (OAuthStateError, pinterest.PinterestApiError, HTTPException, CredentialCryptoError):
        return _redirect("error", "pinterest")


@app.post("/api/v1/accounts/{account_id}/metrics", response_model=AccountMetricRead, status_code=status.HTTP_201_CREATED)
def add_account_metrics(account_id: UUID, payload: AccountMetricCreate, db: Session = Depends(get_db)):
    if db.get(SocialAccount, account_id) is None:
        raise HTTPException(status_code=404, detail="Account not found")
    snapshot = AccountMetricSnapshot(account_id=account_id, captured_at=datetime.now(timezone.utc), **payload.model_dump())
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return snapshot


@app.get("/api/v1/accounts/metrics/latest", response_model=list[AccountMetricRead])
def latest_account_metrics(db: Session = Depends(get_db)):
    latest = (
        select(AccountMetricSnapshot.account_id, func.max(AccountMetricSnapshot.captured_at).label("captured_at"))
        .group_by(AccountMetricSnapshot.account_id)
        .subquery()
    )
    return list(
        db.scalars(
            select(AccountMetricSnapshot).join(
                latest,
                (AccountMetricSnapshot.account_id == latest.c.account_id)
                & (AccountMetricSnapshot.captured_at == latest.c.captured_at),
            )
        )
    )


def _sync_account(db: Session, account: SocialAccount, platform: Platform) -> AccountMetricSnapshot:
    connection = get_connection(db, account.id)
    try:
        if platform.slug == "youtube":
            if connection:
                token = active_access_token(db, connection)
                channel = youtube.fetch_channel(account.external_id, access_token=token) if account.external_id else youtube.fetch_authenticated_channel(token)
            elif settings.youtube_api_key and account.external_id:
                channel = youtube.fetch_channel(account.external_id, api_key=settings.youtube_api_key)
            else:
                raise ConnectionError("YouTube 需要 API Key + Channel ID，或完成 Google OAuth 授权。")
            result = youtube.channel_metrics(channel)
            values = {
                "followers": result.followers,
                "views": result.views,
                "impressions": 0,
                "reach": 0,
                "engagements": 0,
                "content_count": result.content_count,
                "extra_metrics": result.extra_metrics,
            }
        elif platform.slug == "facebook":
            if not connection:
                raise ConnectionError("请先连接 Facebook 官方 API。")
            token = active_access_token(db, connection)
            if not account.external_id:
                raise ConnectionError("Facebook Page ID 缺失，请重新授权。")
            profile = meta.fetch_facebook_page(account.external_id, token, settings.meta_graph_version)
            values = meta.facebook_account_snapshot(profile, token, settings.meta_graph_version)
        elif platform.slug == "instagram":
            if not connection:
                raise ConnectionError("请先连接 Instagram 官方 API。")
            token = active_access_token(db, connection)
            if not account.external_id:
                raise ConnectionError("Instagram Account ID 缺失，请重新授权。")
            profile = meta.fetch_instagram_profile(account.external_id, token, settings.meta_graph_version)
            values = meta.instagram_account_snapshot(profile, token, settings.meta_graph_version)
        elif platform.slug == "pinterest":
            if not connection:
                raise ConnectionError("请先连接 Pinterest 官方 API。")
            token = active_access_token(db, connection)
            profile = pinterest.fetch_user_account(token)
            pins = pinterest.list_pins(token, page_size=25)
            values = pinterest.account_snapshot(profile, pins)
        else:
            raise ConnectionError("不支持的平台。")

        snapshot = AccountMetricSnapshot(account_id=account.id, captured_at=datetime.now(timezone.utc), **values)
        db.add(snapshot)
        db.commit()
        db.refresh(snapshot)
        if connection:
            mark_sync_result(db, connection)
        _log(db, platform.slug, "account", account.id, "success", "账号数据同步成功")
        return snapshot
    except (ConnectionError, CredentialCryptoError, youtube.YouTubeApiError, meta.MetaApiError, pinterest.PinterestApiError) as exc:
        if connection:
            mark_sync_result(db, connection, error=str(exc))
        _log(db, platform.slug, "account", account.id, "error", str(exc))
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/v1/accounts/{account_id}/sync", response_model=AccountMetricRead, status_code=status.HTTP_201_CREATED)
def sync_account(account_id: UUID, db: Session = Depends(get_db)):
    account, platform = _account_platform(db, account_id)
    return _sync_account(db, account, platform)


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _upsert_content(db: Session, account: SocialAccount, *, external_id: str, title: str, content_type: str, url: str | None, published_at: datetime | None) -> str:
    existing = db.scalar(
        select(PublishedContent).where(
            PublishedContent.account_id == account.id,
            PublishedContent.external_id == external_id,
        )
    )
    if existing:
        existing.title = title or existing.title
        existing.content_type = content_type or existing.content_type
        existing.url = url or existing.url
        existing.published_at = published_at or existing.published_at
        return "updated"
    db.add(
        PublishedContent(
            account_id=account.id,
            external_id=external_id,
            title=title or external_id,
            content_type=content_type,
            url=url,
            published_at=published_at,
        )
    )
    return "created"


@app.post("/api/v1/accounts/{account_id}/import-content", response_model=ImportResult)
def import_content(account_id: UUID, limit: int = Query(default=25, ge=1, le=50), db: Session = Depends(get_db)):
    account, platform = _account_platform(db, account_id)
    connection = get_connection(db, account.id)
    created = updated = skipped = 0
    try:
        if platform.slug == "youtube":
            if connection:
                token = active_access_token(db, connection)
                channel = youtube.fetch_channel(account.external_id, access_token=token) if account.external_id else youtube.fetch_authenticated_channel(token)
                items = youtube.list_recent_uploads(channel, access_token=token, limit=limit)
            elif settings.youtube_api_key and account.external_id:
                channel = youtube.fetch_channel(account.external_id, api_key=settings.youtube_api_key)
                items = youtube.list_recent_uploads(channel, api_key=settings.youtube_api_key, limit=limit)
            else:
                raise ConnectionError("YouTube 导入需要 API Key + Channel ID，或 Google OAuth。")
            for item in items:
                video_id = str(item.get("id") or "")
                snippet = item.get("snippet") or {}
                if not video_id:
                    skipped += 1
                    continue
                outcome = _upsert_content(
                    db,
                    account,
                    external_id=video_id,
                    title=str(snippet.get("title") or video_id),
                    content_type="video",
                    url=f"https://www.youtube.com/watch?v={video_id}",
                    published_at=_parse_datetime(str(snippet.get("publishedAt") or "")),
                )
                created += outcome == "created"
                updated += outcome == "updated"
        elif platform.slug == "facebook":
            if not connection or not account.external_id:
                raise ConnectionError("请先授权 Facebook Page。")
            token = active_access_token(db, connection)
            items = meta.list_facebook_content(account.external_id, token, settings.meta_graph_version, limit=limit)
            for item in items:
                content_id = str(item.get("id") or "")
                if not content_id:
                    skipped += 1
                    continue
                outcome = _upsert_content(
                    db,
                    account,
                    external_id=content_id,
                    title=(str(item.get("message") or "").strip()[:180] or f"Facebook Post {content_id}"),
                    content_type="post",
                    url=item.get("permalink_url"),
                    published_at=_parse_datetime(item.get("created_time")),
                )
                created += outcome == "created"
                updated += outcome == "updated"
        elif platform.slug == "instagram":
            if not connection or not account.external_id:
                raise ConnectionError("请先授权 Instagram Professional 账号。")
            token = active_access_token(db, connection)
            items = meta.list_instagram_content(account.external_id, token, settings.meta_graph_version, limit=limit)
            for item in items:
                content_id = str(item.get("id") or "")
                if not content_id:
                    skipped += 1
                    continue
                product_type = str(item.get("media_product_type") or "").upper()
                media_type = str(item.get("media_type") or "").upper()
                content_type = "short" if product_type == "REELS" else "video" if media_type == "VIDEO" else "post"
                outcome = _upsert_content(
                    db,
                    account,
                    external_id=content_id,
                    title=(str(item.get("caption") or "").strip()[:180] or f"Instagram {product_type or media_type} {content_id}"),
                    content_type=content_type,
                    url=item.get("permalink"),
                    published_at=_parse_datetime(item.get("timestamp")),
                )
                created += outcome == "created"
                updated += outcome == "updated"
        elif platform.slug == "pinterest":
            if not connection:
                raise ConnectionError("请先授权 Pinterest 账号。")
            token = active_access_token(db, connection)
            items = pinterest.list_pins(token, page_size=limit)
            for item in items:
                content_id = str(item.get("id") or "")
                if not content_id:
                    skipped += 1
                    continue
                outcome = _upsert_content(
                    db,
                    account,
                    external_id=content_id,
                    title=str(item.get("title") or item.get("description") or f"Pinterest Pin {content_id}")[:180],
                    content_type="pin",
                    url=f"https://www.pinterest.com/pin/{content_id}/",
                    published_at=_parse_datetime(item.get("created_at")),
                )
                created += outcome == "created"
                updated += outcome == "updated"
        db.commit()
        _log(db, platform.slug, "account", account.id, "success", "近期内容导入完成", {"created": created, "updated": updated, "skipped": skipped})
        return ImportResult(created=created, updated=updated, skipped=skipped)
    except (ConnectionError, CredentialCryptoError, youtube.YouTubeApiError, meta.MetaApiError, pinterest.PinterestApiError) as exc:
        _log(db, platform.slug, "account", account.id, "error", str(exc), {"operation": "import_content"})
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/content", response_model=list[ContentRead])
def list_content(db: Session = Depends(get_db)):
    return list(db.scalars(select(PublishedContent).order_by(PublishedContent.created_at.desc())))


@app.post("/api/v1/content", response_model=ContentRead, status_code=status.HTTP_201_CREATED)
def create_content(payload: ContentCreate, db: Session = Depends(get_db)):
    if db.get(SocialAccount, payload.account_id) is None:
        raise HTTPException(status_code=400, detail="Account not found")
    item = PublishedContent(**payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.delete("/api/v1/content/{content_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_content(content_id: UUID, db: Session = Depends(get_db)):
    item = db.get(PublishedContent, content_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Content not found")
    db.delete(item)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/v1/content/{content_id}/metrics", response_model=ContentMetricRead, status_code=status.HTTP_201_CREATED)
def add_content_metrics(content_id: UUID, payload: ContentMetricCreate, db: Session = Depends(get_db)):
    if db.get(PublishedContent, content_id) is None:
        raise HTTPException(status_code=404, detail="Content not found")
    snapshot = ContentMetricSnapshot(content_id=content_id, captured_at=datetime.now(timezone.utc), **payload.model_dump())
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return snapshot


@app.get("/api/v1/content/metrics/latest", response_model=list[ContentMetricRead])
def latest_content_metrics(db: Session = Depends(get_db)):
    latest = (
        select(ContentMetricSnapshot.content_id, func.max(ContentMetricSnapshot.captured_at).label("captured_at"))
        .group_by(ContentMetricSnapshot.content_id)
        .subquery()
    )
    return list(
        db.scalars(
            select(ContentMetricSnapshot).join(
                latest,
                (ContentMetricSnapshot.content_id == latest.c.content_id)
                & (ContentMetricSnapshot.captured_at == latest.c.captured_at),
            )
        )
    )


@app.post("/api/v1/content/{content_id}/sync", response_model=ContentMetricRead, status_code=status.HTTP_201_CREATED)
def sync_content(content_id: UUID, db: Session = Depends(get_db)):
    item, account, platform = _content_context(db, content_id)
    connection = get_connection(db, account.id)
    try:
        if platform.slug == "youtube":
            video_id = item.external_id or youtube.video_id_from_reference(item.url or "")
            if not video_id:
                raise ConnectionError("无法识别 YouTube Video ID，请填写作品链接或平台内容 ID。")
            if connection:
                token = active_access_token(db, connection)
                video = youtube.fetch_video(video_id, access_token=token)
            elif settings.youtube_api_key:
                video = youtube.fetch_video(video_id, api_key=settings.youtube_api_key)
            else:
                raise ConnectionError("请配置 YouTube API Key 或连接 Google OAuth。")
            result = youtube.video_metrics(video)
            values = {
                "views": result.views,
                "likes": result.likes,
                "comments": result.comments,
                "saves": result.saves,
                "shares": result.shares,
                "impressions": 0,
                "reach": 0,
                "extra_metrics": result.extra_metrics,
            }
            if not item.external_id:
                item.external_id = video_id
        elif platform.slug == "facebook":
            if not connection or not item.external_id:
                raise ConnectionError("Facebook 内容同步需要官方授权和 Post ID。")
            token = active_access_token(db, connection)
            values = meta.facebook_content_snapshot(item.external_id, token, settings.meta_graph_version)
        elif platform.slug == "instagram":
            if not connection or not item.external_id:
                raise ConnectionError("Instagram 内容同步需要官方授权和 Media ID。")
            token = active_access_token(db, connection)
            values = meta.instagram_content_snapshot(item.external_id, token, settings.meta_graph_version)
        elif platform.slug == "pinterest":
            if not connection or not item.external_id:
                raise ConnectionError("Pinterest 内容同步需要官方授权和 Pin ID。")
            token = active_access_token(db, connection)
            pin = pinterest.fetch_pin(item.external_id, token)
            values = pinterest.pin_snapshot(pin)
        else:
            raise ConnectionError("不支持的平台。")

        snapshot = ContentMetricSnapshot(content_id=item.id, captured_at=datetime.now(timezone.utc), **values)
        db.add(snapshot)
        db.commit()
        db.refresh(snapshot)
        _log(db, platform.slug, "content", item.id, "success", "内容数据同步成功")
        return snapshot
    except (ConnectionError, CredentialCryptoError, youtube.YouTubeApiError, meta.MetaApiError, pinterest.PinterestApiError) as exc:
        _log(db, platform.slug, "content", item.id, "error", str(exc))
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/v1/sync-all")
def sync_all(db: Session = Depends(get_db)):
    results = {"accounts_ok": 0, "accounts_error": 0, "content_ok": 0, "content_error": 0}
    accounts = list(db.scalars(select(SocialAccount)))
    for account in accounts:
        platform = db.get(Platform, account.platform_id)
        if platform is None:
            continue
        try:
            _sync_account(db, account, platform)
            results["accounts_ok"] += 1
        except HTTPException:
            results["accounts_error"] += 1
    contents = list(db.scalars(select(PublishedContent)))
    for item in contents:
        try:
            sync_content(item.id, db)
            results["content_ok"] += 1
        except HTTPException:
            results["content_error"] += 1
    return results


@app.get("/api/v1/sync-logs", response_model=list[SyncLogRead])
def sync_logs(limit: int = Query(default=50, ge=1, le=200), db: Session = Depends(get_db)):
    return list(db.scalars(select(SyncLog).order_by(SyncLog.created_at.desc()).limit(limit)))
