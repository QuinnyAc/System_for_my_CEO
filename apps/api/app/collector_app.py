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
from app.models import (
    AccountMetricSnapshot,
    CollectorTask,
    ContentMetricSnapshot,
    MonitoredAccount,
    Platform,
    PublishedContent,
    SocialAccount,
)


PLATFORMS = {
    "youtube": "YouTube",
    "instagram": "Instagram",
    "facebook": "Facebook",
    "pinterest": "Pinterest",
}

COLLECTOR_TOKEN = os.getenv("COLLECTOR_TOKEN", "")

app = FastAPI(title="Media Ops Browser Collector", version="0.4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
    discovered_urls: list[str] = Field(default_factory=list, max_length=120)
    machine_name: str = ""
    collector_version: str = ""
    task_id: UUID | None = None


class CollectorResult(BaseModel):
    ok: bool = True
    account_id: str
    content_id: str | None = None
    account_snapshot_created: bool = False
    content_snapshot_created: bool = False
    discovered_tasks_created: int = 0
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


class MonitorCreate(BaseModel):
    platform: str
    name: str = Field(min_length=1, max_length=160)
    profile_url: str = Field(min_length=1)
    machine_name: str | None = Field(default=None, max_length=120)


class MonitorUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    machine_name: str | None = Field(default=None, max_length=120)
    enabled: bool | None = None


class MonitorRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    platform: str
    name: str
    profile_url: str
    machine_name: str | None
    enabled: bool
    discovered_count: int
    last_checked_at: datetime | None
    next_check_at: datetime | None
    last_error: str | None
    created_at: datetime


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
    if not raw:
        return raw
    candidate = raw if "://" in raw else f"https://{raw}"
    try:
        parsed = urlparse(candidate)
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


def normalize_profile_url(platform: str, value: str) -> str:
    normalized = normalize_url(value)
    parsed = urlparse(normalized)
    path = parsed.path.rstrip("/")
    if platform == "youtube":
        for suffix in ("/videos", "/shorts", "/streams", "/featured"):
            if path.endswith(suffix):
                path = path[: -len(suffix)]
                break
    return urlunparse((parsed.scheme, parsed.netloc, path or "/", "", "", ""))


def monitor_task_urls(monitor: MonitoredAccount) -> list[str]:
    base = normalize_profile_url(monitor.platform, monitor.profile_url).rstrip("/")
    if monitor.platform == "youtube":
        return [f"{base}/videos", f"{base}/shorts"]
    return [base]


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


def task_exists(db: Session, url: str, active_only: bool = True) -> bool:
    stmt = select(CollectorTask.id).where(CollectorTask.url == normalize_url(url))
    if active_only:
        stmt = stmt.where(CollectorTask.status.in_(["pending", "processing"]))
    return db.scalar(stmt.limit(1)) is not None


def add_task(db: Session, url: str, platform: str, machine_name: str | None = None) -> CollectorTask | None:
    normalized = normalize_url(url)
    if not normalized or task_exists(db, normalized):
        return None
    task = CollectorTask(
        url=normalized,
        platform=platform,
        machine_name=(machine_name or "").strip()[:120] or None,
        status="pending",
    )
    db.add(task)
    return task


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
        key = f"{machine or ''}|{normalized}"
        if key in seen:
            skipped += 1
            continue
        seen.add(key)
        task = add_task(db, normalized, platform, machine)
        if task is None:
            skipped += 1
        else:
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


@app.get("/admin/monitors", response_model=list[MonitorRead], dependencies=[Depends(require_admin_session)])
def admin_list_monitors(db: Session = Depends(get_db)):
    return list(db.scalars(select(MonitoredAccount).order_by(MonitoredAccount.created_at.desc())))


@app.post("/admin/monitors", response_model=MonitorRead, status_code=status.HTTP_201_CREATED, dependencies=[Depends(require_admin_session)])
def admin_create_monitor(payload: MonitorCreate, db: Session = Depends(get_db)):
    platform = payload.platform.strip().lower()
    if platform not in PLATFORMS:
        raise HTTPException(status_code=422, detail="不支持的平台")
    profile_url = normalize_profile_url(platform, payload.profile_url)
    if platform_for_url(profile_url) != platform:
        raise HTTPException(status_code=422, detail="主页链接与平台不匹配")
    existing = db.scalar(
        select(MonitoredAccount).where(
            MonitoredAccount.platform == platform,
            MonitoredAccount.profile_url == profile_url,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="这个账号已经在监控列表中")
    item = MonitoredAccount(
        platform=platform,
        name=payload.name.strip()[:160],
        profile_url=profile_url,
        machine_name=(payload.machine_name or "").strip()[:120] or None,
        enabled=True,
        next_check_at=datetime.now(timezone.utc),
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.patch("/admin/monitors/{monitor_id}", response_model=MonitorRead, dependencies=[Depends(require_admin_session)])
def admin_update_monitor(monitor_id: UUID, payload: MonitorUpdate, db: Session = Depends(get_db)):
    item = db.get(MonitoredAccount, monitor_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Monitor not found")
    if payload.name is not None:
        item.name = payload.name.strip()[:160]
    if payload.machine_name is not None:
        item.machine_name = payload.machine_name.strip()[:120] or None
    if payload.enabled is not None:
        item.enabled = payload.enabled
        if payload.enabled:
            item.next_check_at = datetime.now(timezone.utc)
            item.last_error = None
    db.commit()
    db.refresh(item)
    return item


@app.delete("/admin/monitors/{monitor_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_admin_session)])
def admin_delete_monitor(monitor_id: UUID, db: Session = Depends(get_db)):
    item = db.get(MonitoredAccount, monitor_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Monitor not found")
    db.delete(item)
    db.commit()
    return None


def ensure_due_monitor_tasks(db: Session, now: datetime) -> None:
    due = list(
        db.scalars(
            select(MonitoredAccount)
            .where(
                MonitoredAccount.enabled.is_(True),
                or_(MonitoredAccount.next_check_at.is_(None), MonitoredAccount.next_check_at <= now),
            )
            .order_by(MonitoredAccount.next_check_at.asc().nullsfirst())
            .limit(20)
        )
    )
    changed = False
    for monitor in due:
        for url in monitor_task_urls(monitor):
            if add_task(db, url, monitor.platform, monitor.machine_name):
                changed = True
        monitor.next_check_at = now + timedelta(hours=1)
        changed = True
    if changed:
        db.commit()


def refresh_interval(item: PublishedContent, now: datetime) -> timedelta:
    started = item.published_at or item.created_at or now
    age = now - started
    if age <= timedelta(days=1):
        return timedelta(hours=1)
    if age <= timedelta(days=3):
        return timedelta(hours=6)
    if age <= timedelta(days=7):
        return timedelta(days=1)
    if age <= timedelta(days=30):
        return timedelta(days=3)
    return timedelta(days=7)


def ensure_due_content_refresh_tasks(db: Session, now: datetime) -> None:
    items = list(
        db.scalars(
            select(PublishedContent)
            .where(PublishedContent.url.is_not(None))
            .order_by(PublishedContent.created_at.desc())
            .limit(500)
        )
    )
    queued = 0
    for item in items:
        if queued >= 50 or not item.url:
            break
        platform = platform_for_url(item.url)
        if not platform:
            continue
        interval = refresh_interval(item, now)
        latest = db.scalar(
            select(ContentMetricSnapshot)
            .where(ContentMetricSnapshot.content_id == item.id)
            .order_by(ContentMetricSnapshot.captured_at.desc())
            .limit(1)
        )
        if latest and latest.captured_at and latest.captured_at > now - interval:
            continue
        recent_task = db.scalar(
            select(CollectorTask.id)
            .where(
                CollectorTask.url == normalize_url(item.url),
                CollectorTask.created_at > now - min(interval, timedelta(hours=1)),
            )
            .limit(1)
        )
        if recent_task:
            continue
        if add_task(db, item.url, platform, None):
            queued += 1
    if queued:
        db.commit()


def release_stale_tasks(db: Session, now: datetime) -> None:
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


@app.get("/tasks/next", response_model=QueueLease, dependencies=[Depends(require_collector_token)])
def next_task(machine_name: str = Query(default="", max_length=120), db: Session = Depends(get_db)) -> QueueLease:
    now = datetime.now(timezone.utc)
    release_stale_tasks(db, now)
    ensure_due_monitor_tasks(db, now)
    ensure_due_content_refresh_tasks(db, now)

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
    for monitor in db.scalars(select(MonitoredAccount).where(MonitoredAccount.enabled.is_(True))):
        if normalize_url(task.url) in {normalize_url(url) for url in monitor_task_urls(monitor)}:
            monitor.last_error = task.last_error
            monitor.next_check_at = datetime.now(timezone.utc) + timedelta(minutes=30)
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
    profile_url = normalize_profile_url(platform.slug, payload.profile_url) if payload.profile_url else ""
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
    # Link is the canonical identity in browser-collector mode. This keeps manual/old records from splitting.
    item = db.scalar(select(PublishedContent).where(PublishedContent.url == normalized).limit(1))
    if item is None and payload.content_external_id:
        item = db.scalar(
            select(PublishedContent).where(
                PublishedContent.account_id == account.id,
                PublishedContent.external_id == payload.content_external_id,
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
            published_at=datetime.now(timezone.utc),
        )
        db.add(item)
        db.flush()
    else:
        if payload.title.strip():
            item.title = payload.title.strip()[:300]
        if payload.content_external_id:
            item.external_id = payload.content_external_id[:255]
        if payload.content_type:
            item.content_type = payload.content_type[:48]
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


def matching_monitor(db: Session, task_url: str, platform: str) -> MonitoredAccount | None:
    target = normalize_url(task_url)
    for monitor in db.scalars(
        select(MonitoredAccount).where(
            MonitoredAccount.platform == platform,
            MonitoredAccount.enabled.is_(True),
        )
    ):
        if target in {normalize_url(url) for url in monitor_task_urls(monitor)}:
            return monitor
    return None


def add_discovered_tasks(db: Session, payload: CollectorPayload, monitor: MonitoredAccount | None) -> int:
    created = 0
    machine = monitor.machine_name if monitor else ((payload.machine_name or "").strip() or None)
    seen: set[str] = set()
    for raw in payload.discovered_urls[:120]:
        normalized = normalize_url(raw)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        platform = platform_for_url(normalized)
        if platform != payload.platform:
            continue
        already_content = db.scalar(select(PublishedContent.id).where(PublishedContent.url == normalized).limit(1))
        if already_content:
            continue
        if add_task(db, normalized, platform, machine):
            created += 1
    if monitor:
        monitor.discovered_count += created
        monitor.last_checked_at = datetime.now(timezone.utc)
        monitor.next_check_at = datetime.now(timezone.utc) + timedelta(hours=1)
        monitor.last_error = None
    return created


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
    discovered_tasks_created = 0
    task: CollectorTask | None = None
    if payload.task_id:
        task = db.get(CollectorTask, payload.task_id)
    monitor = matching_monitor(db, task.url, slug) if task and payload.page_type == "account" else None
    if payload.page_type == "account" and payload.discovered_urls:
        discovered_tasks_created = add_discovered_tasks(db, payload, monitor)
    elif monitor:
        monitor.last_checked_at = datetime.now(timezone.utc)
        monitor.next_check_at = datetime.now(timezone.utc) + timedelta(hours=1)
        monitor.last_error = None

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
        discovered_tasks_created=discovered_tasks_created,
        task_completed=task_completed,
    )
