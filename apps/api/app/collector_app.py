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
    MonitoredContentSeen,
    MonitorFeedState,
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
MONITOR_INTERVAL = timedelta(hours=1)
BASELINE_RETRY_INTERVAL = timedelta(minutes=10)

app = FastAPI(title="Media Ops Browser Collector", version="0.5.0")
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
    discovered_urls: list[str] = Field(default_factory=list, max_length=160)
    previous_seen_urls: list[str] = Field(default_factory=list, max_length=240)
    discovery_complete: bool = False
    feed_empty: bool = False
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
    baseline_ready: bool = False
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


class AdminAccountCreate(BaseModel):
    platform: str
    name: str = Field(min_length=1, max_length=160)
    profile_url: str = Field(min_length=1)
    machine_name: str | None = Field(default=None, max_length=120)


class AdminAccountResult(BaseModel):
    account_id: UUID
    monitor_id: UUID
    platform: str
    profile_url: str
    account_created: bool
    monitor_created: bool


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def require_collector_token(x_collector_token: str = Header(default="")) -> None:
    if not COLLECTOR_TOKEN or not hmac.compare_digest(x_collector_token, COLLECTOR_TOKEN):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid collector token")


def require_admin_session(request: Request) -> None:
    if not session_valid(request.cookies.get(COOKIE_NAME)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")


def normalize_handle(value: str) -> str:
    raw = value.strip()
    return raw if raw.startswith("@") or not raw else f"@{raw}"


def _facebook_identity_query(parsed) -> str:
    query = parse_qs(parsed.query)
    keys: list[str] = []
    path = parsed.path.rstrip("/") or "/"
    if path in {"/watch", "/watch/"} and query.get("v", [""])[0]:
        keys = ["v"]
    elif path.endswith("/profile.php") and query.get("id", [""])[0]:
        keys = ["id"]
    elif query.get("story_fbid", [""])[0]:
        keys = ["story_fbid", "id"]
    elif query.get("fbid", [""])[0]:
        keys = ["fbid", "id"]
    values = {key: query.get(key, [""])[0] for key in keys if query.get(key, [""])[0]}
    return urlencode(values)


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
    host = parsed.netloc.lower().split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path.rstrip("/") or "/"
    query = ""
    if host in {"youtube.com", "m.youtube.com"} and path == "/watch":
        video_id = parse_qs(parsed.query).get("v", [""])[0]
        query = urlencode({"v": video_id}) if video_id else ""
    elif host.endswith("facebook.com"):
        query = _facebook_identity_query(parsed)
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


def is_content_url(platform: str, value: str) -> bool:
    raw = value.strip()
    if not raw:
        return False
    candidate = raw if "://" in raw else f"https://{raw}"
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return False
    host = parsed.netloc.lower().split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path.rstrip("/") or "/"
    parts = [part.lower() for part in path.split("/") if part]
    query = parse_qs(parsed.query)
    if platform == "youtube":
        return host == "youtu.be" or path == "/watch" or bool(parts and parts[0] in {"shorts", "live"})
    if platform == "instagram":
        return bool(parts and parts[0] in {"p", "reel", "tv"})
    if platform == "facebook":
        if host == "fb.watch" or "story_fbid" in query or "fbid" in query:
            return True
        return any(part in {"posts", "videos", "reel", "watch", "photo", "permalink"} for part in parts[1:]) or bool(parts and parts[0] in {"watch", "reel"})
    if platform == "pinterest":
        return host == "pin.it" or bool(parts and parts[0] == "pin")
    return False


def normalize_profile_url(platform: str, value: str) -> str:
    normalized = normalize_url(value)
    parsed = urlparse(normalized)
    path = parsed.path.rstrip("/")
    query = parsed.query
    if platform == "youtube":
        for suffix in ("/videos", "/shorts", "/streams", "/featured"):
            if path.endswith(suffix):
                path = path[: -len(suffix)]
                break
    elif platform == "instagram":
        parts = [part for part in path.split("/") if part]
        if parts and parts[0].lower() not in {"p", "reel", "tv", "explore", "accounts"}:
            path = f"/{parts[0]}"
            query = ""
    elif platform == "facebook":
        for suffix in ("/videos", "/reels", "/posts"):
            if path.endswith(suffix) and len([part for part in path.split("/") if part]) >= 2:
                path = path[: -len(suffix)]
                break
    elif platform == "pinterest":
        parts = [part for part in path.split("/") if part]
        if parts and parts[0].lower() != "pin":
            path = f"/{parts[0]}"
            query = ""
    return urlunparse((parsed.scheme, parsed.netloc, path or "/", "", query, ""))


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
    return {"status": "ok", "collector": "browser_public_view", "version": "0.5.0"}


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


def _monitor_for_feed(db: Session, task_url: str, platform: str | None = None) -> MonitoredAccount | None:
    target = normalize_url(task_url)
    stmt = select(MonitoredAccount).where(MonitoredAccount.enabled.is_(True))
    if platform:
        stmt = stmt.where(MonitoredAccount.platform == platform)
    for monitor in db.scalars(stmt):
        if target in {normalize_url(url) for url in monitor_task_urls(monitor)}:
            return monitor
    return None


def _monitor_for_content(db: Session, url: str, platform: str) -> tuple[MonitoredAccount | None, MonitoredContentSeen | None]:
    target = normalize_url(url)
    seen = db.scalar(
        select(MonitoredContentSeen)
        .where(MonitoredContentSeen.platform == platform, MonitoredContentSeen.url == target)
        .order_by(MonitoredContentSeen.first_seen_at.desc())
        .limit(1)
    )
    if seen is None:
        return None, None
    return db.get(MonitoredAccount, seen.monitor_id), seen


def _queue_monitor_now(db: Session, monitor: MonitoredAccount) -> None:
    for url in monitor_task_urls(monitor):
        add_task(db, url, monitor.platform, monitor.machine_name)
    monitor.next_check_at = now_utc() + MONITOR_INTERVAL


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


@app.post("/admin/accounts", response_model=AdminAccountResult, dependencies=[Depends(require_admin_session)])
def admin_create_account(payload: AdminAccountCreate, db: Session = Depends(get_db)) -> AdminAccountResult:
    detected = platform_for_url(payload.profile_url)
    platform_slug = payload.platform.strip().lower()
    if detected not in PLATFORMS or platform_slug != detected:
        raise HTTPException(status_code=422, detail="主页链接与平台不匹配")
    if is_content_url(platform_slug, payload.profile_url):
        raise HTTPException(status_code=422, detail="请填写账号主页地址，不要填写单个作品链接")
    platform = db.scalar(select(Platform).where(Platform.slug == platform_slug))
    if platform is None:
        raise HTTPException(status_code=500, detail="Platform catalog is not initialized")
    profile_url = normalize_profile_url(platform_slug, payload.profile_url)

    account = db.scalar(
        select(SocialAccount).where(
            SocialAccount.platform_id == platform.id,
            SocialAccount.profile_url == profile_url,
        )
    )
    account_created = account is None
    if account is None:
        account = SocialAccount(
            platform_id=platform.id,
            name=payload.name.strip()[:160],
            profile_url=profile_url,
        )
        db.add(account)
        db.flush()
    else:
        account.name = payload.name.strip()[:160]

    monitor = db.scalar(
        select(MonitoredAccount).where(
            MonitoredAccount.platform == platform_slug,
            MonitoredAccount.profile_url == profile_url,
        )
    )
    monitor_created = monitor is None
    if monitor is None:
        monitor = MonitoredAccount(
            platform=platform_slug,
            name=payload.name.strip()[:160],
            profile_url=profile_url,
            machine_name=(payload.machine_name or "").strip()[:120] or None,
            enabled=True,
            next_check_at=now_utc(),
        )
        db.add(monitor)
        db.flush()
    else:
        monitor.name = payload.name.strip()[:160]
        monitor.enabled = True
        monitor.last_error = None
        if payload.machine_name is not None:
            monitor.machine_name = payload.machine_name.strip()[:120] or None

    _queue_monitor_now(db, monitor)
    db.commit()
    db.refresh(account)
    db.refresh(monitor)
    return AdminAccountResult(
        account_id=account.id,
        monitor_id=monitor.id,
        platform=platform_slug,
        profile_url=profile_url,
        account_created=account_created,
        monitor_created=monitor_created,
    )


@app.delete("/admin/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_admin_session)])
def admin_delete_account(account_id: UUID, db: Session = Depends(get_db)):
    account = db.get(SocialAccount, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="Account not found")
    platform = db.get(Platform, account.platform_id)
    urls: set[str] = set()
    if account.profile_url and platform:
        profile_url = normalize_profile_url(platform.slug, account.profile_url)
        monitors = list(
            db.scalars(
                select(MonitoredAccount).where(
                    MonitoredAccount.platform == platform.slug,
                    MonitoredAccount.profile_url == profile_url,
                )
            )
        )
        for monitor in monitors:
            urls.update(normalize_url(value) for value in monitor_task_urls(monitor))
            urls.update(
                db.scalars(
                    select(MonitoredContentSeen.url).where(MonitoredContentSeen.monitor_id == monitor.id)
                ).all()
            )
            db.delete(monitor)
    urls.update(
        normalize_url(value)
        for value in db.scalars(
            select(PublishedContent.url).where(
                PublishedContent.account_id == account.id,
                PublishedContent.url.is_not(None),
            )
        ).all()
        if value
    )
    if urls:
        for task in db.scalars(select(CollectorTask).where(CollectorTask.url.in_(list(urls)))):
            db.delete(task)
    db.delete(account)
    db.commit()
    return None


@app.get("/admin/monitors", response_model=list[MonitorRead], dependencies=[Depends(require_admin_session)])
def admin_list_monitors(db: Session = Depends(get_db)):
    return list(db.scalars(select(MonitoredAccount).order_by(MonitoredAccount.created_at.desc())))


@app.post("/admin/monitors", response_model=MonitorRead, status_code=status.HTTP_201_CREATED, dependencies=[Depends(require_admin_session)])
def admin_create_monitor(payload: MonitorCreate, db: Session = Depends(get_db)):
    platform = payload.platform.strip().lower()
    if platform not in PLATFORMS:
        raise HTTPException(status_code=422, detail="不支持的平台")
    if is_content_url(platform, payload.profile_url):
        raise HTTPException(status_code=422, detail="请填写账号主页地址，不要填写单个作品链接")
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
        next_check_at=now_utc(),
    )
    db.add(item)
    db.flush()
    _queue_monitor_now(db, item)
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
        item.last_error = None
        if payload.enabled:
            _queue_monitor_now(db, item)
        else:
            item.next_check_at = None
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
            .limit(30)
        )
    )
    if not due:
        return
    for monitor in due:
        for url in monitor_task_urls(monitor):
            add_task(db, url, monitor.platform, monitor.machine_name)
        monitor.next_check_at = now + MONITOR_INTERVAL
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
        if queued >= 50:
            break
        if not item.url:
            continue
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


def _assignment(machine: str):
    assignment = or_(CollectorTask.machine_name.is_(None), CollectorTask.machine_name == "")
    if machine:
        assignment = or_(assignment, CollectorTask.machine_name == machine)
    return assignment


def _lease_task(db: Session, machine: str) -> CollectorTask | None:
    assignment = _assignment(machine)
    feed_urls: list[str] = []
    for monitor in db.scalars(select(MonitoredAccount).where(MonitoredAccount.enabled.is_(True))):
        feed_urls.extend(normalize_url(url) for url in monitor_task_urls(monitor))
    if feed_urls:
        task = db.scalar(
            select(CollectorTask)
            .where(
                CollectorTask.status == "pending",
                assignment,
                CollectorTask.url.in_(feed_urls),
            )
            .order_by(CollectorTask.created_at.asc())
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if task:
            return task
    return db.scalar(
        select(CollectorTask)
        .where(CollectorTask.status == "pending", assignment)
        .order_by(CollectorTask.created_at.asc())
        .with_for_update(skip_locked=True)
        .limit(1)
    )


@app.get("/tasks/next", response_model=QueueLease, dependencies=[Depends(require_collector_token)])
def next_task(machine_name: str = Query(default="", max_length=120), db: Session = Depends(get_db)) -> QueueLease:
    now = now_utc()
    release_stale_tasks(db, now)
    ensure_due_monitor_tasks(db, now)
    ensure_due_content_refresh_tasks(db, now)
    machine = machine_name.strip()
    task = _lease_task(db, machine)
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
        return {"ok": True, "status": "gone"}
    if task.status == "completed":
        return {"ok": True, "status": task.status}
    task.last_error = (payload.error or "页面没有读取到公开数据")[:1000]
    task.started_at = None
    task.status = "error" if task.attempts >= 3 else "pending"
    monitor = _monitor_for_feed(db, task.url, task.platform)
    if monitor:
        monitor.last_error = task.last_error
        monitor.next_check_at = now_utc() + timedelta(minutes=30)
    db.commit()
    return {"ok": True, "status": task.status, "attempts": task.attempts}


def _find_account_by_profile(db: Session, platform: Platform, profile_url: str) -> SocialAccount | None:
    if not profile_url:
        return None
    normalized = normalize_profile_url(platform.slug, profile_url)
    return db.scalar(
        select(SocialAccount).where(
            SocialAccount.platform_id == platform.id,
            SocialAccount.profile_url == normalized,
        )
    )


def find_or_create_account(db: Session, payload: CollectorPayload, platform: Platform) -> SocialAccount:
    handle = normalize_handle(payload.handle)
    account: SocialAccount | None = None
    if payload.page_type == "content":
        existing_content = db.scalar(
            select(PublishedContent).where(PublishedContent.url == normalize_url(payload.url)).limit(1)
        )
        if existing_content is not None:
            existing_account = db.get(SocialAccount, existing_content.account_id)
            if existing_account is not None and existing_account.platform_id == platform.id:
                account = existing_account
    if account is None and payload.external_id:
        account = db.scalar(
            select(SocialAccount).where(
                SocialAccount.platform_id == platform.id,
                SocialAccount.external_id == payload.external_id,
            )
        )
    if account is None and payload.profile_url:
        account = _find_account_by_profile(db, platform, payload.profile_url)
    if account is None and handle:
        account = db.scalar(
            select(SocialAccount).where(
                SocialAccount.platform_id == platform.id,
                func.lower(SocialAccount.handle) == handle.lower(),
            )
        )
    profile_url = normalize_profile_url(platform.slug, payload.profile_url) if payload.profile_url else ""
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
        if handle:
            account.handle = handle[:160]
        if payload.external_id:
            account.external_id = payload.external_id[:255]
        if profile_url:
            account.profile_url = profile_url
        generic_names = {"", f"{platform.name} Account"}
        if account.name in generic_names and payload.account_name.strip():
            account.name = payload.account_name.strip()[:160]
    return account


def _legacy_known(latest, key: str) -> bool:
    if latest is None:
        return False
    extra = latest.extra_metrics or {}
    known = extra.get("known") if isinstance(extra, dict) else None
    if isinstance(known, dict) and isinstance(known.get(key), bool):
        return bool(known[key])
    available = extra.get("available") if isinstance(extra, dict) else None
    if isinstance(available, dict) and isinstance(available.get(key), bool):
        return bool(available[key])
    value = getattr(latest, key, 0)
    return bool(value)


def _merged_value(latest, key: str, current: int | None) -> tuple[int, bool]:
    if current is not None:
        return current, True
    if latest is not None and _legacy_known(latest, key):
        return int(getattr(latest, key, 0)), True
    return 0, False


def _metric_meta(payload: CollectorPayload, available: dict[str, bool], known: dict[str, bool]) -> dict:
    return {
        "source": "browser_public_view",
        "page_url": normalize_url(payload.url),
        "machine_name": payload.machine_name,
        "collector_version": payload.collector_version,
        "public_view_only": True,
        "collector_task_id": str(payload.task_id) if payload.task_id else "",
        "available": available,
        "known": known,
    }


def maybe_add_account_snapshot(db: Session, account: SocialAccount, payload: CollectorPayload) -> bool:
    metrics = payload.metrics
    if metrics.followers is None and metrics.account_views is None and metrics.content_count is None:
        return False
    latest = db.scalar(
        select(AccountMetricSnapshot)
        .where(AccountMetricSnapshot.account_id == account.id)
        .order_by(AccountMetricSnapshot.captured_at.desc())
        .limit(1)
    )
    followers, followers_known = _merged_value(latest, "followers", metrics.followers)
    views, views_known = _merged_value(latest, "views", metrics.account_views)
    content_count, content_known = _merged_value(latest, "content_count", metrics.content_count)
    available = {
        "followers": metrics.followers is not None,
        "views": metrics.account_views is not None,
        "content_count": metrics.content_count is not None,
    }
    known = {"followers": followers_known, "views": views_known, "content_count": content_known}
    values = (followers, views, content_count)
    if latest and latest.captured_at and latest.captured_at >= now_utc() - timedelta(minutes=30):
        latest_values = (latest.followers, latest.views, latest.content_count)
        latest_known = {key: _legacy_known(latest, key) for key in ("followers", "views", "content_count")}
        if values == latest_values and known == latest_known:
            return False
    db.add(
        AccountMetricSnapshot(
            account_id=account.id,
            captured_at=now_utc(),
            followers=followers,
            views=views,
            content_count=content_count,
            impressions=0,
            reach=0,
            engagements=0,
            extra_metrics=_metric_meta(payload, available, known),
        )
    )
    return True


def find_or_create_content(db: Session, account: SocialAccount, payload: CollectorPayload) -> PublishedContent:
    normalized = normalize_url(payload.url)
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
            published_at=now_utc(),
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
    keys = ("views", "likes", "comments", "saves", "shares")
    if not any(getattr(metrics, key) is not None for key in keys):
        return False
    latest = db.scalar(
        select(ContentMetricSnapshot)
        .where(ContentMetricSnapshot.content_id == item.id)
        .order_by(ContentMetricSnapshot.captured_at.desc())
        .limit(1)
    )
    values: dict[str, int] = {}
    known: dict[str, bool] = {}
    available: dict[str, bool] = {}
    for key in keys:
        current = getattr(metrics, key)
        value, is_known = _merged_value(latest, key, current)
        values[key] = value
        known[key] = is_known
        available[key] = current is not None
    if latest and latest.captured_at and latest.captured_at >= now_utc() - timedelta(minutes=30):
        latest_values = {key: int(getattr(latest, key, 0)) for key in keys}
        latest_known = {key: _legacy_known(latest, key) for key in keys}
        if values == latest_values and known == latest_known:
            return False
    db.add(
        ContentMetricSnapshot(
            content_id=item.id,
            captured_at=now_utc(),
            views=values["views"],
            likes=values["likes"],
            comments=values["comments"],
            saves=values["saves"],
            shares=values["shares"],
            impressions=0,
            reach=0,
            extra_metrics=_metric_meta(payload, available, known),
        )
    )
    return True


def _seen_for_monitor(db: Session, monitor_id: UUID, url: str) -> MonitoredContentSeen | None:
    return db.scalar(
        select(MonitoredContentSeen).where(
            MonitoredContentSeen.monitor_id == monitor_id,
            MonitoredContentSeen.url == normalize_url(url),
        )
    )


def _remember_seen(db: Session, monitor: MonitoredAccount, url: str, *, baseline: bool) -> MonitoredContentSeen:
    normalized = normalize_url(url)
    existing = _seen_for_monitor(db, monitor.id, normalized)
    if existing:
        return existing
    item = MonitoredContentSeen(
        monitor_id=monitor.id,
        url=normalized,
        platform=monitor.platform,
        is_baseline=baseline,
        first_seen_at=now_utc(),
    )
    db.add(item)
    db.flush()
    return item


def process_discovery(
    db: Session,
    payload: CollectorPayload,
    monitor: MonitoredAccount,
    feed_url: str,
) -> tuple[int, bool]:
    feed = normalize_url(feed_url)
    discovered: list[str] = []
    unique: set[str] = set()
    for raw in payload.discovered_urls[:160]:
        normalized = normalize_url(raw)
        if not normalized or normalized in unique or platform_for_url(normalized) != monitor.platform:
            continue
        unique.add(normalized)
        discovered.append(normalized)
    previous_seen = {
        normalize_url(raw)
        for raw in payload.previous_seen_urls[:240]
        if raw and platform_for_url(raw) == monitor.platform
    }
    state = db.scalar(
        select(MonitorFeedState).where(
            MonitorFeedState.monitor_id == monitor.id,
            MonitorFeedState.feed_url == feed,
        )
    )
    baseline_ready = state is not None
    created_tasks = 0
    new_seen = 0

    if state is None:
        can_initialize = bool(previous_seen or discovered or payload.feed_empty or payload.metrics.content_count == 0)
        if not can_initialize:
            monitor.last_checked_at = now_utc()
            monitor.next_check_at = now_utc() + BASELINE_RETRY_INTERVAL
            monitor.last_error = "作品列表尚未确认，未建立基线；系统会自动重试。"
            return 0, False
        state = MonitorFeedState(monitor_id=monitor.id, feed_url=feed, initialized_at=now_utc())
        db.add(state)
        db.flush()
        baseline_ready = True
        if previous_seen:
            for url in previous_seen:
                _remember_seen(db, monitor, url, baseline=True)
            for url in discovered:
                if url in previous_seen or _seen_for_monitor(db, monitor.id, url):
                    continue
                _remember_seen(db, monitor, url, baseline=False)
                new_seen += 1
                if db.scalar(select(PublishedContent.id).where(PublishedContent.url == url).limit(1)) is None:
                    if add_task(db, url, monitor.platform, monitor.machine_name):
                        created_tasks += 1
        else:
            for url in discovered:
                _remember_seen(db, monitor, url, baseline=True)
    else:
        for url in discovered:
            if _seen_for_monitor(db, monitor.id, url):
                continue
            _remember_seen(db, monitor, url, baseline=False)
            new_seen += 1
            if db.scalar(select(PublishedContent.id).where(PublishedContent.url == url).limit(1)) is None:
                if add_task(db, url, monitor.platform, monitor.machine_name):
                    created_tasks += 1

    monitor.discovered_count += new_seen
    monitor.last_checked_at = now_utc()
    monitor.next_check_at = now_utc() + MONITOR_INTERVAL
    monitor.last_error = None
    return created_tasks, baseline_ready


def _complete_task(task: CollectorTask | None, machine_name: str) -> bool:
    if task is None or task.status != "processing":
        return False
    task.status = "completed"
    task.completed_at = now_utc()
    task.started_at = None
    task.last_error = None
    if machine_name.strip():
        task.machine_name = machine_name.strip()[:120]
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

    task: CollectorTask | None = None
    if payload.task_id:
        task = db.get(CollectorTask, payload.task_id)
        if task is None:
            raise HTTPException(status_code=410, detail="Collector task no longer exists")
        if task.platform != slug:
            raise HTTPException(status_code=422, detail="Task platform mismatch")

    monitor: MonitoredAccount | None = None
    seen: MonitoredContentSeen | None = None
    if payload.page_type == "account" and task:
        monitor = _monitor_for_feed(db, task.url, slug)
        if monitor:
            payload = payload.model_copy(update={"profile_url": monitor.profile_url, "account_name": monitor.name})
    elif payload.page_type == "content":
        monitor, seen = _monitor_for_content(db, payload.url, slug)
        if monitor:
            payload = payload.model_copy(update={"profile_url": monitor.profile_url, "account_name": monitor.name})

    account = find_or_create_account(db, payload, platform)
    account_snapshot_created = False
    content_snapshot_created = False
    content_id: str | None = None
    baseline_ready = False
    discovered_tasks_created = 0

    if payload.page_type == "account":
        account_snapshot_created = maybe_add_account_snapshot(db, account, payload)
        if monitor and task:
            discovered_tasks_created, baseline_ready = process_discovery(db, payload, monitor, task.url)
    else:
        if seen and seen.is_baseline:
            task_completed = _complete_task(task, payload.machine_name)
            db.commit()
            return CollectorResult(
                account_id=str(account.id),
                content_id=None,
                baseline_ready=True,
                task_completed=task_completed,
            )
        item = find_or_create_content(db, account, payload)
        content_snapshot_created = maybe_add_content_snapshot(db, item, payload)
        content_id = str(item.id)

    task_completed = _complete_task(task, payload.machine_name)
    db.commit()
    return CollectorResult(
        account_id=str(account.id),
        content_id=content_id,
        account_snapshot_created=account_snapshot_created,
        content_snapshot_created=content_snapshot_created,
        discovered_tasks_created=discovered_tasks_created,
        baseline_ready=baseline_ready,
        task_completed=task_completed,
    )
