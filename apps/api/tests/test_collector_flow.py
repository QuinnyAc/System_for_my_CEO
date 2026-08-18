from sqlalchemy import select
from fastapi.testclient import TestClient

from app.auth import COOKIE_NAME, create_session_token
from app.collector_app import app, normalize_url
from app.db import SessionLocal
from app.models import (
    CollectorTask,
    ContentMetricSnapshot,
    MonitoredAccount,
    MonitoredContentSeen,
    MonitorFeedState,
    Platform,
    PublishedContent,
    SocialAccount,
)


TOKEN = "media-ops-ci-collector-token"
COLLECTOR_HEADERS = {"X-Collector-Token": TOKEN}


def _remove_profile(profile_url: str) -> None:
    with SessionLocal() as db:
        platform = db.scalar(select(Platform).where(Platform.slug == "youtube"))
        if platform:
            for account in db.scalars(
                select(SocialAccount).where(
                    SocialAccount.platform_id == platform.id,
                    SocialAccount.profile_url == profile_url,
                )
            ):
                db.delete(account)
        for monitor in db.scalars(
            select(MonitoredAccount).where(
                MonitoredAccount.platform == "youtube",
                MonitoredAccount.profile_url == profile_url,
            )
        ):
            db.delete(monitor)
        for task in db.scalars(
            select(CollectorTask).where(CollectorTask.url.like(f"{profile_url}%"))
        ):
            db.delete(task)
        db.commit()


def test_atomic_account_create_is_idempotent_and_delete_cleans_monitor() -> None:
    profile = "https://youtube.com/@ci-atomic-account"
    _remove_profile(profile)
    with TestClient(app) as client:
        client.cookies.set(COOKIE_NAME, create_session_token())
        payload = {
            "platform": "youtube",
            "name": "Internal CI Account",
            "profile_url": "https://www.youtube.com/@ci-atomic-account",
            "machine_name": None,
        }
        created = client.post("/admin/accounts", json=payload)
        assert created.status_code == 200, created.text
        data = created.json()
        assert data["account_created"] is True
        assert data["monitor_created"] is True
        assert data["profile_url"] == profile

        repeated = client.post("/admin/accounts", json=payload)
        assert repeated.status_code == 200, repeated.text
        repeated_data = repeated.json()
        assert repeated_data["account_id"] == data["account_id"]
        assert repeated_data["monitor_id"] == data["monitor_id"]
        assert repeated_data["account_created"] is False
        assert repeated_data["monitor_created"] is False

        with SessionLocal() as db:
            tasks = list(
                db.scalars(
                    select(CollectorTask).where(
                        CollectorTask.platform == "youtube",
                        CollectorTask.url.in_([f"{profile}/videos", f"{profile}/shorts"]),
                    )
                )
            )
            assert len(tasks) == 2

        deleted = client.delete(f"/admin/accounts/{data['account_id']}")
        assert deleted.status_code == 204, deleted.text

        with SessionLocal() as db:
            assert db.get(SocialAccount, data["account_id"]) is None
            assert db.get(MonitoredAccount, data["monitor_id"]) is None
            remaining = list(
                db.scalars(
                    select(CollectorTask).where(
                        CollectorTask.url.in_([f"{profile}/videos", f"{profile}/shorts"])
                    )
                )
            )
            assert remaining == []
    _remove_profile(profile)


def test_first_scan_is_baseline_and_later_content_belongs_to_existing_account() -> None:
    profile = "https://youtube.com/@ci-baseline-account"
    feed = f"{profile}/videos"
    old_url = "https://youtube.com/watch?v=ci_old_video"
    new_url = "https://youtube.com/watch?v=ci_new_video"
    _remove_profile(profile)

    with TestClient(app) as client:
        with SessionLocal() as db:
            platform = db.scalar(select(Platform).where(Platform.slug == "youtube"))
            assert platform is not None
            account = SocialAccount(
                platform_id=platform.id,
                name="Keep This Internal Name",
                profile_url=profile,
            )
            monitor = MonitoredAccount(
                platform="youtube",
                name="Keep This Internal Name",
                profile_url=profile,
                enabled=True,
            )
            first_task = CollectorTask(
                url=feed,
                platform="youtube",
                status="processing",
                attempts=1,
            )
            db.add_all([account, monitor, first_task])
            db.commit()
            account_id = account.id
            monitor_id = monitor.id
            first_task_id = first_task.id

        first = client.post(
            "/ingest",
            headers=COLLECTOR_HEADERS,
            json={
                "platform": "youtube",
                "page_type": "account",
                "url": feed,
                "account_name": "Platform Display Name",
                "profile_url": profile,
                "metrics": {"followers": 123, "content_count": 10},
                "discovered_urls": [old_url],
                "discovery_complete": True,
                "task_id": str(first_task_id),
            },
        )
        assert first.status_code == 200, first.text
        assert first.json()["baseline_ready"] is True
        assert first.json()["discovered_tasks_created"] == 0

        with SessionLocal() as db:
            state = db.scalar(
                select(MonitorFeedState).where(
                    MonitorFeedState.monitor_id == monitor_id,
                    MonitorFeedState.feed_url == feed,
                )
            )
            assert state is not None
            old_seen = db.scalar(
                select(MonitoredContentSeen).where(
                    MonitoredContentSeen.monitor_id == monitor_id,
                    MonitoredContentSeen.url == old_url,
                )
            )
            assert old_seen is not None and old_seen.is_baseline is True
            assert db.scalar(select(PublishedContent).where(PublishedContent.url == old_url)) is None
            account = db.get(SocialAccount, account_id)
            assert account is not None and account.name == "Keep This Internal Name"

            second_task = CollectorTask(
                url=feed,
                platform="youtube",
                status="processing",
                attempts=1,
            )
            db.add(second_task)
            db.commit()
            second_task_id = second_task.id

        second = client.post(
            "/ingest",
            headers=COLLECTOR_HEADERS,
            json={
                "platform": "youtube",
                "page_type": "account",
                "url": feed,
                "profile_url": profile,
                "metrics": {"followers": 124, "content_count": 11},
                "discovered_urls": [old_url, new_url],
                "discovery_complete": True,
                "task_id": str(second_task_id),
            },
        )
        assert second.status_code == 200, second.text
        assert second.json()["discovered_tasks_created"] == 1

        with SessionLocal() as db:
            new_seen = db.scalar(
                select(MonitoredContentSeen).where(
                    MonitoredContentSeen.monitor_id == monitor_id,
                    MonitoredContentSeen.url == new_url,
                )
            )
            assert new_seen is not None and new_seen.is_baseline is False
            content_task = db.scalar(
                select(CollectorTask).where(
                    CollectorTask.url == new_url,
                    CollectorTask.status == "pending",
                )
            )
            assert content_task is not None
            content_task.status = "processing"
            content_task.attempts = 1
            db.commit()
            content_task_id = content_task.id

        content = client.post(
            "/ingest",
            headers=COLLECTOR_HEADERS,
            json={
                "platform": "youtube",
                "page_type": "content",
                "url": new_url,
                "title": "New public video",
                "account_name": "Wrong Page Guess",
                "profile_url": "",
                "content_external_id": "ci_new_video",
                "content_type": "video",
                "metrics": {"views": 456, "likes": 7},
                "task_id": str(content_task_id),
            },
        )
        assert content.status_code == 200, content.text
        assert content.json()["content_snapshot_created"] is True

        with SessionLocal() as db:
            item = db.scalar(select(PublishedContent).where(PublishedContent.url == new_url))
            assert item is not None
            assert item.account_id == account_id
            account = db.get(SocialAccount, account_id)
            assert account is not None and account.name == "Keep This Internal Name"
            snapshot = db.scalar(
                select(ContentMetricSnapshot)
                .where(ContentMetricSnapshot.content_id == item.id)
                .order_by(ContentMetricSnapshot.captured_at.desc())
                .limit(1)
            )
            assert snapshot is not None
            assert snapshot.views == 456
            assert snapshot.likes == 7
            assert snapshot.saves == 0
            assert snapshot.extra_metrics["known"]["views"] is True
            assert snapshot.extra_metrics["known"]["saves"] is False

        deleted_client = TestClient(app)
        deleted_client.cookies.set(COOKIE_NAME, create_session_token())
        with deleted_client:
            deleted = deleted_client.delete(f"/admin/accounts/{account_id}")
            assert deleted.status_code == 204, deleted.text
    _remove_profile(profile)
