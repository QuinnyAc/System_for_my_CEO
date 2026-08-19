from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.auth import COOKIE_NAME, create_session_token
from app.collector_app import app
from app.db import Base, SessionLocal, engine
from app.models import CollectorTask


def test_admin_task_batch_accepts_youtube_account_feeds_and_is_idempotent() -> None:
    Base.metadata.create_all(bind=engine)
    urls = [
        "https://youtube.com/@ci-sync-now/videos",
        "https://youtube.com/@ci-sync-now/shorts",
    ]

    with SessionLocal() as db:
        db.execute(delete(CollectorTask).where(CollectorTask.url.in_(urls)))
        db.commit()

    with TestClient(app) as client:
        client.cookies.set(COOKIE_NAME, create_session_token())
        first = client.post(
            "/admin/tasks/batch",
            json={"urls": urls, "machine_name": None},
        )
        assert first.status_code == 200, first.text
        assert first.json()["created"] == 2

        second = client.post(
            "/admin/tasks/batch",
            json={"urls": urls, "machine_name": None},
        )
        assert second.status_code == 200, second.text
        assert second.json()["created"] == 0
        assert second.json()["skipped"] == 2

    with SessionLocal() as db:
        db.execute(delete(CollectorTask).where(CollectorTask.url.in_(urls)))
        db.commit()
