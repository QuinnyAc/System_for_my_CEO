from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Platform(Base):
    __tablename__ = "platforms"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    slug: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64))


class SocialAccount(Base):
    __tablename__ = "social_accounts"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    platform_id: Mapped[UUID] = mapped_column(ForeignKey("platforms.id", ondelete="RESTRICT"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    handle: Mapped[str | None] = mapped_column(String(160), nullable=True)
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    profile_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    platform: Mapped[Platform] = relationship()
    metrics: Mapped[list["AccountMetricSnapshot"]] = relationship(cascade="all, delete-orphan")
    content: Mapped[list["PublishedContent"]] = relationship(cascade="all, delete-orphan")


class AccountMetricSnapshot(Base):
    __tablename__ = "account_metric_snapshots"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    account_id: Mapped[UUID] = mapped_column(ForeignKey("social_accounts.id", ondelete="CASCADE"), index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    followers: Mapped[int] = mapped_column(Integer, default=0)
    views: Mapped[int] = mapped_column(Integer, default=0)
    impressions: Mapped[int] = mapped_column(Integer, default=0)
    reach: Mapped[int] = mapped_column(Integer, default=0)
    engagements: Mapped[int] = mapped_column(Integer, default=0)
    content_count: Mapped[int] = mapped_column(Integer, default=0)
    extra_metrics: Mapped[dict] = mapped_column(JSONB, default=dict)


class PublishedContent(Base):
    __tablename__ = "published_content"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    account_id: Mapped[UUID] = mapped_column(ForeignKey("social_accounts.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    content_type: Mapped[str] = mapped_column(String(48), default="video")
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    metrics: Mapped[list["ContentMetricSnapshot"]] = relationship(cascade="all, delete-orphan")


class ContentMetricSnapshot(Base):
    __tablename__ = "content_metric_snapshots"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    content_id: Mapped[UUID] = mapped_column(ForeignKey("published_content.id", ondelete="CASCADE"), index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    views: Mapped[int] = mapped_column(Integer, default=0)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    comments: Mapped[int] = mapped_column(Integer, default=0)
    saves: Mapped[int] = mapped_column(Integer, default=0)
    shares: Mapped[int] = mapped_column(Integer, default=0)
    impressions: Mapped[int] = mapped_column(Integer, default=0)
    reach: Mapped[int] = mapped_column(Integer, default=0)
    extra_metrics: Mapped[dict] = mapped_column(JSONB, default=dict)
