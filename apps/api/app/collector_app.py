from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hmac
import os
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.auth import COOKIE_NAME, session_valid
from app.db import Base, SessionLocal, engine, get_db
from app.models import AccountMetricSnapshot, CollectorTask, ContentMetricSnapshot, Platform, PublishedContent, SocialAccount


PLATFORMS = {
    "youtube": "YouTube",
    "instagram": "Instagram",
    "facebook": "Facebook",
    "pinterest": "Pinterest",
}

COLLECTOR_TOKEN = os.getenv("COLLECTOR_TOKEN", "")

app = FastAPI(title="Media Ops Browser Collector", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


class PublicMetrics(BaseModel):
    followers: int | None = Field(default=None, ge=0)
    account_views: int | None = Field(default=None, ge=0)
    content_count: int | None = Field(default=None, ge=0)
    views: int | None = Field(default=None, ge=0)
    likes: int | None = Field(default=None, ge=0)
    comments: int | None = Field(default=None, ge=0)
    saves: int | None = Field(default=None, ge=0)
    shares: int | None = Field(default=None, ge=0)


class CollectorPayload(BaseModel):
    platform: str
    page_type: str = "content"
    url: str
    title: str = ""
    account_name: str = ""
    handle: str = ""
    external_id: str = ""
    profile_url: str = ""
    content_external_id: str = ""
    content_type: str = "video"
    metrics: PublicMetrics = Field(default_factory=PublicMetrics)
    machine_name: str = ""
    collector_version: str = ""
    task_id: UUID | None = None


class CollectorResult(BaseModel):
    ok: bool = True
    account_id: str
    content_id: str | None = None
    account_snapshot_created: bool = False
    content_snapshot_created: bool = False
    task_completed: bool = False


class QueueTaskRead(BaseModel):
    id: UUID
    url: str
    platform: str
    attempts: int


class QueueLease(BaseModel):
    task: QueueTaskRead | None = None


class QueueFailure(BaseModel):
    error: str = ""


class AdminTaskBatchCreate(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=500)
    machine_name: str | None = Field(default=None, max_length=120)


class AdminTaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    url: str
    platform: str
    machine_name: str | None
    status: str
    attempts: int
    last_error: str | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class AdminTaskBatchResult(BaseModel):
    created: int = 0
    skipped: int = 0
    tasks: list[AdminTaskRead] = Field(default_factory=list)


def require_collector_token(x_collector_token: str = Header(default="")) -> None:
    if not COLLECTOR_TOKEN or not hmac.compare_digest(x_collector_token, COLLECTOR_TOKEN):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid collector token")


def require_admin_session(request: Request) -> None:
    if not session_valid(request.cookies.get(COOKIE_NAME)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")


def normalize_handle(value: str) -> str:
    raw = value.strip()
    return raw if raw.startswith("@") or not raw else f"@{raw}"


def normalize_url(value: str) -> str:
    raw = value.strip()
    try:
        parsed = urlparse(raw)
    except ValueError:
        return raw
    scheme = parsed.scheme or "https"
    host = parsed.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path.rstrip("/") or "/"
    query = ""
    if host in {"youtube.com", "m.youtube.com"} and path == "/watch":
        video_id = parse_qs(parsed.query).get("v", [""])[0]
        query = urlencode({"v": video_id}) if video_id else ""
    return urlunparse((scheme, host, path, "", query, ""))


def platform_for_url(value: str) -> str | None:
    raw = value.strip()
    if not raw:
        return None
    candidate = raw if "://" in raw else f"https://{raw}"
    try:
        host = urlparse(candidate).netloc.lower().split(":")[0]
    except ValueError:
        return None
    if host.startswith("www."):
        host = host[4:]
    if host == "youtu.be" or host.endswith("youtube.com"):
        return "youtube"
    if host.endswith("instagram.com"):
        return "instagram"
    if host == "fb.watch" or host.endswith("facebook.com"):
        return "facebook"
    if host == "pin.it" or host.endswith("pinterest.com"):
        return "pinterest"
    return None


def seed_platforms() -> None:
    with SessionLocal() as db:
        existing = {item.slug for item in db.scalars(select(Platform)).all()}
        for slug, name in PLATFORMS.items():
            if slug not in existing:
                db.add(Platform(slug=slug, name=name))
        db.commit()


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    seed_platforms()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "collector": "browser_public_view"}


@app.get("/admin/tasks", response_model=list[AdminTaskRead], dependencies=[Depends(require_admin_session)])
def admin_list_tasks(db: Session = Depends(get_db)):
    return list(db.scalars(select(CollectorTask).order_by(CollectorTask.created_at.desc()).limit(300)))


@app.post("/admin/tasks/batch", response_model=AdminTaskBatchResult, dependencies=[Depends(require_admin_session)])
def admin_create_tasks(payload: AdminTaskBatchCreate, db: Session = Depends(get_db)) -> AdminTaskBatchResult:
    machine = (payload.machine_name or "").strip()[:120] or None
    created: list[CollectorTask] = []
    skipped = 0
    seen: set[str] = set()

    for raw_value in payload.urls:
        raw = raw_value.strip()
        if not raw:
            skipped += 1
            continue
        candidate = raw if "://" in raw else f"https://{raw}"
        platform = platform_for_url(candidate)
        if platform is None:
            skipped += 1
            continue
        normalized = normalize_url(candidate)
        dedupe_key = f"{machine or ''}|{normalized}"
        if dedupe_key in seen:
            skipped += 1
            continue
        seen.add(dedupe_key)
        exists = db.scalar(
            select(CollectorTask.id).where(
                CollectorTask.url == normalized,
                CollectorTask.status.in_(["pending", "processing"]),
                or_(
                    CollectorTask.machine_name == machine,
                    (CollectorTask.machine_name.is_(None) if machine is None else CollectorTask.machine_name == machine),
                ),
            ).limit(1)
        )
        if exists:
            skipped += 1
            continue
        task = CollectorTask(url=normalized, platform=platform, machine_name=machine, status="pending")
        db.add(task)
        created.append(task)

    db.commit()
    for task in created:
        db.refresh(task)
    return AdminTaskBatchResult(created=len(created), skipped=skipped, tasks=created)


@app.delete("/admin/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_admin_session)])
def admin_delete_task(task_id: UUID, db: Session = Depends(get_db)):
    task = db.get(CollectorTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    db.delete(task)
    db.commit()
    return None


@app.post("/admin/tasks/{task_id}/retry", response_model=AdminTaskRead, dependencies=[Depends(require_admin_session)])
def admin_retry_task(task_id: UUID, db: Session = Depends(get_db)):
    task = db.get(CollectorTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task.status = "pending"
    task.attempts = 0
    task.started_at = None
    task.completed_at = None
    task.last_error = None
    db.commit()
    db.refresh(task)
    return task


@app.get("/tasks/next", response_model=QueueLease, dependencies=[Depends(require_collector_token)])
def next_task(machine_name: str = Query(default="", max_length=120), db: Session = Depends(get_db)) -> QueueLease:
    now = datetime.now(timezone.utc)
    stale_before = now - timedelta(minutes=3)

    stale = list(
        db.scalars(
            select(CollectorTask).where(
                CollectorTask.status == "processing",
                CollectorTask.started_at.is_not(None),
                CollectorTask.started_at < stale_before,
            )
        )
    )
    for item in stale:
        item.status = "pending" if item.attempts < 3 else "error"
        item.last_error = "采集助手超时，任务已自动释放。"
        item.started_at = None
    if stale:
        db.commit()

    machine = machine_name.strip()
    assignment = or_(CollectorTask.machine_name.is_(None), CollectorTask.machine_name == "")
    if machine:
        assignment = or_(assignment, CollectorTask.machine_name == machine)

    task = db.scalar(
        select(CollectorTask)
        .where(CollectorTask.status == "pending", assignment)
        .order_by(CollectorTask.created_at.asc())
        .with_for_update(skip_locked=True)
        .limit(1)
    )
    if task is None:
        return QueueLease(task=None)

    task.status = "processing"
    task.started_at = now
    task.attempts += 1
    task.last_error = None
    if machine and not task.machine_name:
        task.machine_name = machine
    db.commit()
    return QueueLease(task=QueueTaskRead(id=task.id, url=task.url, platform=task.platform, attempts=task.attempts))


@app.post("/tasks/{task_id}/fail", dependencies=[Depends(require_collector_token)])
def fail_task(task_id: UUID, payload: QueueFailure, db: Session = Depends(get_db)):
    task = db.get(CollectorTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status == "completed":
        return {"ok": True, "status": task.status}
    task.last_error = (payload.error or "页面没有读取到公开数据")[:1000]
    task.started_at = None
    task.status = "error" if task.attempts >= 3 else "pending"
    db.commit()
    return {"ok": True, "status": task.status, "attempts": task.attempts}


def find_or_create_account(db: Session, payload: CollectorPayload, platform: Platform) -> SocialAccount:
    handle = normalize_handle(payload.handle)
    account: SocialAccount | None = None

    if payload.external_id:
        account = db.scalar(
            select(SocialAccount).where(
                SocialAccount.platform_id == platform.id,
                SocialAccount.external_id == payload.external_id,
            )
        )

    if account is None and handle:
        account = db.scalar(
            select(SocialAccount).where(
                SocialAccount.platform_id == platform.id,
                func.lower(SocialAccount.handle) == handle.lower(),
            )
        )

    profile_url = normalize_url(payload.profile_url) if payload.profile_url else ""
    if account is None and profile_url:
        account = db.scalar(
            select(SocialAccount).where(
                SocialAccount.platform_id == platform.id,
                SocialAccount.profile_url == profile_url,
            )
        )

    if account is None:
        fallback_name = payload.account_name.strip() or handle.lstrip("@") or f"{platform.name} Account"
        account = SocialAccount(
            platform_id=platform.id,
            name=fallback_name[:160],
            handle=handle or None,
            external_id=payload.external_id or None,
            profile_url=profile_url or None,
        )
        db.add(account)
        db.flush()
    else:
        if payload.account_name.strip():
            account.name = payload.account_name.strip()[:160]
        if handle:
            account.handle = handle[:160]
        if payload.external_id:
            account.external_id = payload.external_id[:255]
        if profile_url:
            account.profile_url = profile_url

    return account


def same_account_snapshot(latest: AccountMetricSnapshot | None, metrics: PublicMetrics) -> bool:
    if latest is None:
        return False
    return (
        (metrics.followers is None or latest.followers == metrics.followers)
        and (metrics.account_views is None or latest.views == metrics.account_views)
        and (metrics.content_count is None or latest.content_count == metrics.content_count)
    )


def same_content_snapshot(latest: ContentMetricSnapshot | None, metrics: PublicMetrics) -> bool:
    if latest is None:
        return False
    return (
        (metrics.views is None or latest.views == metrics.views)
        and (metrics.likes is None or latest.likes == metrics.likes)
        and (metrics.comments is None or latest.comments == metrics.comments)
        and (metrics.saves is None or latest.saves == metrics.saves)
        and (metrics.shares is None or latest.shares == metrics.shares)
    )


def source_meta(payload: CollectorPayload) -> dict:
    return {
        "source": "browser_public_view",
        "page_url": normalize_url(payload.url),
        "machine_name": payload.machine_name,
        "collector_version": payload.collector_version,
        "public_view_only": True,
        "collector_task_id": str(payload.task_id) if payload.task_id else "",
    }


def maybe_add_account_snapshot(db: Session, account: SocialAccount, payload: CollectorPayload) -> bool:
    metrics = payload.metrics
    has_account_metric = metrics.followers is not None or metrics.account_views is not None or metrics.content_count is not None
    if not has_account_metric:
        return False

    latest = db.scalar(
        select(AccountMetricSnapshot)
        .where(AccountMetricSnapshot.account_id == account.id)
        .order_by(AccountMetricSnapshot.captured_at.desc())
        .limit(1)
    )
    now = datetime.now(timezone.utc)
    if latest and latest.captured_at and latest.captured_at >= now - timedelta(minutes=30) and same_account_snapshot(latest, metrics):
        return False

    db.add(
        AccountMetricSnapshot(
            account_id=account.id,
            captured_at=now,
            followers=metrics.followers or 0,
            views=metrics.account_views or 0,
            content_count=metrics.content_count or 0,
            impressions=0,
            reach=0,
            engagements=0,
            extra_metrics=source_meta(payload),
        )
    )
    return True


def find_or_create_content(db: Session, account: SocialAccount, payload: CollectorPayload) -> PublishedContent:
    normalized = normalize_url(payload.url)
    item: PublishedContent | None = None

    if payload.content_external_id:
        item = db.scalar(
            select(PublishedContent).where(
                PublishedContent.account_id == account.id,
                PublishedContent.external_id == payload.content_external_id,
            )
        )

    if item is None:
        item = db.scalar(
            select(PublishedContent).where(
                PublishedContent.account_id == account.id,
                PublishedContent.url == normalized,
            )
        )

    title = payload.title.strip() or normalized
    if item is None:
        item = PublishedContent(
            account_id=account.id,
            title=title[:300],
            content_type=(payload.content_type or "video")[:48],
            external_id=payload.content_external_id or None,
            url=normalized,
        )
        db.add(item)
        db.flush()
    else:
        if payload.title.strip():
            item.title = payload.title.strip()[:300]
        if payload.content_external_id:
            item.external_id = payload.content_external_id[:255]
        item.url = normalized
    return item


def maybe_add_content_snapshot(db: Session, item: PublishedContent, payload: CollectorPayload) -> bool:
    metrics = payload.metrics
    has_content_metric = any(value is not None for value in (metrics.views, metrics.likes, metrics.comments, metrics.saves, metrics.shares))
    if not has_content_metric:
        return False

    latest = db.scalar(
        select(ContentMetricSnapshot)
        .where(ContentMetricSnapshot.content_id == item.id)
        .order_by(ContentMetricSnapshot.captured_at.desc())
        .limit(1)
    )
    now = datetime.now(timezone.utc)
    if latest and latest.captured_at and latest.captured_at >= now - timedelta(minutes=30) and same_content_snapshot(latest, metrics):
        return False

    db.add(
        ContentMetricSnapshot(
            content_id=item.id,
            captured_at=now,
            views=metrics.views or 0,
            likes=metrics.likes or 0,
            comments=metrics.comments or 0,
            saves=metrics.saves or 0,
            shares=metrics.shares or 0,
            impressions=0,
            reach=0,
            extra_metrics=source_meta(payload),
        )
    )
    return True


@app.post("/ingest", response_model=CollectorResult, dependencies=[Depends(require_collector_token)])
def ingest(payload: CollectorPayload, db: Session = Depends(get_db)) -> CollectorResult:
    slug = payload.platform.strip().lower()
    if slug not in PLATFORMS:
        raise HTTPException(status_code=422, detail="Unsupported platform")
    if payload.page_type not in {"account", "content"}:
        raise HTTPException(status_code=422, detail="page_type must be account or content")

    platform = db.scalar(select(Platform).where(Platform.slug == slug))
    if platform is None:
        raise HTTPException(status_code=500, detail="Platform catalog is not initialized")

    account = find_or_create_account(db, payload, platform)
    account_snapshot_created = maybe_add_account_snapshot(db, account, payload)

    content_id: str | None = None
    content_snapshot_created = False
    if payload.page_type == "content":
        item = find_or_create_content(db, account, payload)
        content_snapshot_created = maybe_add_content_snapshot(db, item, payload)
        content_id = str(item.id)

    task_completed = False
    if payload.task_id:
        task = db.get(CollectorTask, payload.task_id)
        if task and task.status == "processing":
            task.status = "completed"
            task.completed_at = datetime.now(timezone.utc)
            task.started_at = None
            task.last_error = None
            if payload.machine_name.strip():
                task.machine_name = payload.machine_name.strip()[:120]
            task_completed = True

    db.commit()
    return CollectorResult(
        account_id=str(account.id),
        content_id=content_id,
        account_snapshot_created=account_snapshot_created,
        content_snapshot_created=content_snapshot_created,
        task_completed=task_completed,
    )
