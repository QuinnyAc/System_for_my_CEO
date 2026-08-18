from datetime import datetime, timezone
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import COOKIE_NAME, create_session_token, credentials_valid, session_valid
from app.config import settings
from app.db import Base, SessionLocal, engine, get_db
from app.models import AccountMetricSnapshot, ContentMetricSnapshot, Platform, PublishedContent, SocialAccount
from app.schemas import AccountCreate, AccountMetricCreate, AccountMetricRead, AccountRead, ContentCreate, ContentMetricCreate, ContentMetricRead, ContentRead, PlatformRead

PLATFORMS = {"youtube": "YouTube", "instagram": "Instagram", "facebook": "Facebook", "pinterest": "Pinterest"}
app = FastAPI(title="ZenoMinerals Social Ops API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origin_list, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


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
    if path.startswith("/api/v1/") and path not in {"/api/v1/auth/login", "/api/v1/auth/status"}:
        if not session_valid(request.cookies.get(COOKIE_NAME)):
            return Response(content='{"detail":"Authentication required"}', status_code=401, media_type="application/json")
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "system": "zeno_social_ops"}


@app.post("/api/v1/auth/login")
def login(payload: LoginRequest, response: Response):
    if not credentials_valid(payload.username, payload.password):
        raise HTTPException(status_code=401, detail="用户名或密码不正确")
    response.set_cookie(COOKIE_NAME, create_session_token(), httponly=True, secure=settings.public_web_url.startswith("https://"), samesite="lax", max_age=60 * 60 * 12, path="/")
    return {"authenticated": True, "username": settings.app_username}


@app.post("/api/v1/auth/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"authenticated": False}


@app.get("/api/v1/auth/status")
def auth_status(request: Request):
    return {"authenticated": session_valid(request.cookies.get(COOKIE_NAME))}


@app.get("/api/v1/platforms", response_model=list[PlatformRead])
def list_platforms(db: Session = Depends(get_db)):
    return list(db.scalars(select(Platform).order_by(Platform.name)))


@app.get("/api/v1/providers/status")
def provider_status():
    return {
        "youtube_public": bool(settings.youtube_api_key),
        "google_oauth": bool(settings.google_client_id and settings.google_client_secret),
        "meta": bool(settings.meta_app_id and settings.meta_app_secret),
        "pinterest": bool(settings.pinterest_app_id and settings.pinterest_app_secret),
    }


@app.get("/api/v1/accounts", response_model=list[AccountRead])
def list_accounts(db: Session = Depends(get_db)):
    return list(db.scalars(select(SocialAccount).order_by(SocialAccount.created_at.desc())))


@app.post("/api/v1/accounts", response_model=AccountRead, status_code=status.HTTP_201_CREATED)
def create_account(payload: AccountCreate, db: Session = Depends(get_db)):
    if db.get(Platform, payload.platform_id) is None:
        raise HTTPException(status_code=400, detail="Platform not found")
    account = SocialAccount(**payload.model_dump()); db.add(account); db.commit(); db.refresh(account); return account


@app.delete("/api/v1/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(account_id: UUID, db: Session = Depends(get_db)):
    account = db.get(SocialAccount, account_id)
    if account is None: raise HTTPException(status_code=404, detail="Account not found")
    db.delete(account); db.commit(); return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/v1/accounts/{account_id}/metrics", response_model=AccountMetricRead, status_code=status.HTTP_201_CREATED)
def add_account_metrics(account_id: UUID, payload: AccountMetricCreate, db: Session = Depends(get_db)):
    if db.get(SocialAccount, account_id) is None: raise HTTPException(status_code=404, detail="Account not found")
    snapshot = AccountMetricSnapshot(account_id=account_id, captured_at=datetime.now(timezone.utc), **payload.model_dump()); db.add(snapshot); db.commit(); db.refresh(snapshot); return snapshot


@app.get("/api/v1/accounts/metrics/latest", response_model=list[AccountMetricRead])
def latest_account_metrics(db: Session = Depends(get_db)):
    latest=(select(AccountMetricSnapshot.account_id,func.max(AccountMetricSnapshot.captured_at).label("captured_at")).group_by(AccountMetricSnapshot.account_id).subquery())
    return list(db.scalars(select(AccountMetricSnapshot).join(latest,(AccountMetricSnapshot.account_id==latest.c.account_id)&(AccountMetricSnapshot.captured_at==latest.c.captured_at))))


@app.post("/api/v1/accounts/{account_id}/sync", response_model=AccountMetricRead, status_code=status.HTTP_201_CREATED)
def sync_account(account_id: UUID, db: Session = Depends(get_db)):
    account=db.get(SocialAccount,account_id)
    if account is None: raise HTTPException(status_code=404,detail="Account not found")
    platform=db.get(Platform,account.platform_id)
    if platform is None: raise HTTPException(status_code=400,detail="Platform not found")
    if platform.slug!="youtube": raise HTTPException(status_code=422,detail=f"{platform.name} official API authorization is not configured yet.")
    if not settings.youtube_api_key: raise HTTPException(status_code=422,detail="YOUTUBE_API_KEY is not configured.")
    if not account.external_id: raise HTTPException(status_code=422,detail="YouTube account requires a channel ID in external_id.")
    try:
        response=httpx.get("https://www.googleapis.com/youtube/v3/channels",params={"part":"statistics","id":account.external_id,"key":settings.youtube_api_key},timeout=10); response.raise_for_status()
    except httpx.HTTPError as exc: raise HTTPException(status_code=502,detail="YouTube API request failed.") from exc
    items=response.json().get("items") or []
    if not items: raise HTTPException(status_code=404,detail="YouTube channel was not found.")
    stats=items[0].get("statistics") or {}
    snapshot=AccountMetricSnapshot(account_id=account.id,captured_at=datetime.now(timezone.utc),followers=int(stats.get("subscriberCount",0)),views=int(stats.get("viewCount",0)),content_count=int(stats.get("videoCount",0)),impressions=0,reach=0,engagements=0,extra_metrics={"source":"youtube_data_api","hiddenSubscriberCount":stats.get("hiddenSubscriberCount",False)})
    db.add(snapshot);db.commit();db.refresh(snapshot);return snapshot


@app.get("/api/v1/content", response_model=list[ContentRead])
def list_content(db: Session = Depends(get_db)):
    return list(db.scalars(select(PublishedContent).order_by(PublishedContent.created_at.desc())))


@app.post("/api/v1/content", response_model=ContentRead, status_code=status.HTTP_201_CREATED)
def create_content(payload: ContentCreate, db: Session = Depends(get_db)):
    if db.get(SocialAccount,payload.account_id) is None: raise HTTPException(status_code=400,detail="Account not found")
    item=PublishedContent(**payload.model_dump());db.add(item);db.commit();db.refresh(item);return item


@app.delete("/api/v1/content/{content_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_content(content_id: UUID, db: Session = Depends(get_db)):
    item=db.get(PublishedContent,content_id)
    if item is None: raise HTTPException(status_code=404,detail="Content not found")
    db.delete(item);db.commit();return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/v1/content/{content_id}/metrics", response_model=ContentMetricRead, status_code=status.HTTP_201_CREATED)
def add_content_metrics(content_id: UUID, payload: ContentMetricCreate, db: Session = Depends(get_db)):
    if db.get(PublishedContent,content_id) is None: raise HTTPException(status_code=404,detail="Content not found")
    snapshot=ContentMetricSnapshot(content_id=content_id,captured_at=datetime.now(timezone.utc),**payload.model_dump());db.add(snapshot);db.commit();db.refresh(snapshot);return snapshot


@app.get("/api/v1/content/metrics/latest", response_model=list[ContentMetricRead])
def latest_content_metrics(db: Session = Depends(get_db)):
    latest=(select(ContentMetricSnapshot.content_id,func.max(ContentMetricSnapshot.captured_at).label("captured_at")).group_by(ContentMetricSnapshot.content_id).subquery())
    return list(db.scalars(select(ContentMetricSnapshot).join(latest,(ContentMetricSnapshot.content_id==latest.c.content_id)&(ContentMetricSnapshot.captured_at==latest.c.captured_at))))
