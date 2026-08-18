from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


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
    created_at: datetime


class AccountMetricCreate(BaseModel):
    followers: int = 0
    views: int = 0
    impressions: int = 0
    reach: int = 0
    engagements: int = 0
    content_count: int = 0
    extra_metrics: dict = {}


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
    extra_metrics: dict = {}


class ContentMetricRead(ContentMetricCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    content_id: UUID
    captured_at: datetime
