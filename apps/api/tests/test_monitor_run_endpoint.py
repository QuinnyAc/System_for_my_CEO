from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import COOKIE_NAME, create_session_token
from app.collector_app import app, seed_platforms
from app.db import Base, SessionLocal, engine
from app.models import CollectorTask, MonitoredAccount


def _ensure_db() -> None:
    Base.metadata.create_all(bind=engine)
    seed_platforms()


def test_monitor_run_endpoint_queues_account_feeds() -> None:
    _ensure_db()
    profile = "https://youtube.com/@ci-run-monitor"
    with SessionLocal() as db:
        for task in db.scalars(select(CollectorTask).where(CollectorTask.url.like(f"{profile}%"))):
            db.delete(task)
        for monitor in db.scalars(select(MonitoredAccount).where(MonitoredAccount.profile_url == profile)):
            db.delete(monitor)
        db.commit()
        monitor = MonitoredAccount(
            platform="youtube",
            name="CI Run Monitor",
            profile_url=profile,
            enabled=True,
        )
        db.add(monitor)
        db.commit()
        db.refresh(monitor)
        monitor_id = monitor.id

    with TestClient(app) as client:
        client.cookies.set(COOKIE_NAME, create_session_token())
        response = client.post(f"/admin/monitors/{monitor_id}/run")
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["ok"] is True
        assert data["monitor_id"] == str(monitor_id)
        assert data["queued"] == 2

    with SessionLocal() as db:
        urls = set(
            db.scalars(
                select(CollectorTask.url).where(
                    CollectorTask.url.in_([f"{profile}/videos", f"{profile}/shorts"])
                )
            )
        )
        assert urls == {f"{profile}/videos", f"{profile}/shorts"}
        monitor = db.get(MonitoredAccount, monitor_id)
        if monitor:
            db.delete(monitor)
        for task in db.scalars(select(CollectorTask).where(CollectorTask.url.like(f"{profile}%"))):
            db.delete(task)
        db.commit()
