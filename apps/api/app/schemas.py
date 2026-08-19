from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class PlatformRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    slug: str
    name: str


class AccountCreate(BaseModel):
    platform_id: UUID
    name: str
    handle: str | None = None
    external_id: str | None = None
    profile_url: str | None = None


class AccountRead(AccountCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    group_id: UUID | None = None
    baseline_at: datetime | None = None
    created_at: datetime


class AccountMetricCreate(BaseModel):
    followers: int = 0
    views: int = 0
    impressions: int = 0
    reach: int = 0
    engagements: int = 0
    content_count: int = 0
    extra_metrics: dict = Field(default_factory=dict)


class AccountMetricRead(AccountMetricCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    account_id: UUID
    captured_at: datetime


class ContentCreate(BaseModel):
    account_id: UUID
    title: str
    content_type: str = "video"
    external_id: str | None = None
    url: str | None = None
    published_at: datetime | None = None


class ContentRead(ContentCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    created_at: datetime


class ContentMetricCreate(BaseModel):
    views: int = 0
    likes: int = 0
    comments: int = 0
    saves: int = 0
    shares: int = 0
    impressions: int = 0
    reach: int = 0
    extra_metrics: dict = Field(default_factory=dict)


class ContentMetricRead(ContentMetricCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    content_id: UUID
    captured_at: datetime


class ConnectionStatusRead(BaseModel):
    account_id: UUID
    platform_slug: str
    configured: bool
    connected: bool
    status: str
    scopes: list[str] = Field(default_factory=list)
    expires_at: datetime | None = None
    last_synced_at: datetime | None = None
    last_error: str | None = None
    callback_url: str | None = None


class AuthorizeUrlRead(BaseModel):
    url: str
    callback_url: str


class SyncLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    provider: str
    target_type: str
    target_id: UUID
    status: str
    message: str | None
    details: dict
    created_at: datetime


class ImportResult(BaseModel):
    created: int = 0
    updated: int = 0
    skipped: int = 0


class CollectorTaskBatchCreate(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=500)
    machine_name: str | None = Field(default=None, max_length=120)


class CollectorTaskRead(BaseModel):
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


class CollectorTaskBatchResult(BaseModel):
    created: int = 0
    skipped: int = 0
    tasks: list[CollectorTaskRead] = Field(default_factory=list)
