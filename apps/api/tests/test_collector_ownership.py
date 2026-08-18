from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import COOKIE_NAME, create_session_token
from app.collector_app import app, seed_platforms
from app.db import Base, SessionLocal, engine
from app.models import CollectorTask, ContentMetricSnapshot, Platform, PublishedContent, SocialAccount


TOKEN = "media-ops-ci-collector-token"
HEADERS = {"X-Collector-Token": TOKEN}


def _prepare() -> Platform:
    Base.metadata.create_all(bind=engine)
    seed_platforms()
    with SessionLocal() as db:
        platform = db.scalar(select(Platform).where(Platform.slug == "youtube"))
        assert platform is not None
        db.expunge(platform)
        return platform


def test_admin_account_endpoint_rejects_single_content_url() -> None:
    _prepare()
    with TestClient(app) as client:
        client.cookies.set(COOKIE_NAME, create_session_token())
        response = client.post(
            "/admin/accounts",
            json={
                "platform": "youtube",
                "name": "Should Not Exist",
                "profile_url": "https://youtube.com/watch?v=not_a_profile",
                "machine_name": None,
            },
        )
        assert response.status_code == 422
        with SessionLocal() as db:
            assert db.scalar(select(SocialAccount).where(SocialAccount.name == "Should Not Exist")) is None


def test_existing_content_refresh_never_changes_original_account() -> None:
    platform = _prepare()
    profile = "https://youtube.com/@ci-existing-owner"
    content_url = "https://youtube.com/watch?v=ci_existing_owner_video"

    with SessionLocal() as db:
        for existing in db.scalars(
            select(SocialAccount).where(
                SocialAccount.platform_id == platform.id,
                SocialAccount.profile_url == profile,
            )
        ):
            db.delete(existing)
        for task in db.scalars(select(CollectorTask).where(CollectorTask.url == content_url)):
            db.delete(task)
        db.commit()

        account = SocialAccount(
            platform_id=platform.id,
            name="Original Internal Account",
            profile_url=profile,
        )
        db.add(account)
        db.flush()
        item = PublishedContent(
            account_id=account.id,
            title="Existing video",
            content_type="video",
            external_id="ci_existing_owner_video",
            url=content_url,
        )
        task = CollectorTask(
            url=content_url,
            platform="youtube",
            status="processing",
            attempts=1,
        )
        db.add_all([item, task])
        db.commit()
        account_id = account.id
        content_id = item.id
        task_id = task.id

    with TestClient(app) as client:
        response = client.post(
            "/ingest",
            headers=HEADERS,
            json={
                "platform": "youtube",
                "page_type": "content",
                "url": content_url,
                "title": "Existing video refreshed",
                "account_name": "Wrong Page Guess",
                "profile_url": "",
                "content_external_id": "ci_existing_owner_video",
                "content_type": "video",
                "metrics": {"views": 999, "likes": 12},
                "task_id": str(task_id),
            },
        )
        assert response.status_code == 200, response.text

    with SessionLocal() as db:
        item = db.get(PublishedContent, content_id)
        assert item is not None
        assert item.account_id == account_id
        account = db.get(SocialAccount, account_id)
        assert account is not None
        assert account.name == "Original Internal Account"
        assert db.scalar(select(SocialAccount).where(SocialAccount.name == "Wrong Page Guess")) is None
        snapshot = db.scalar(
            select(ContentMetricSnapshot)
            .where(ContentMetricSnapshot.content_id == content_id)
            .order_by(ContentMetricSnapshot.captured_at.desc())
            .limit(1)
        )
        assert snapshot is not None
        assert snapshot.views == 999
        assert snapshot.likes == 12
        db.delete(account)
        for task in db.scalars(select(CollectorTask).where(CollectorTask.url == content_url)):
            db.delete(task)
        db.commit()
