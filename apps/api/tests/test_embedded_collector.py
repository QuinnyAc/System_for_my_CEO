from fastapi.testclient import TestClient

from app import collector_app
from app.main import app


def test_embedded_collector_health() -> None:
    with TestClient(app) as client:
        response = client.get("/collector/health")
        assert response.status_code == 200, response.text
        data = response.json()
        assert data.get("status") == "ok"


def test_embedded_collector_rejects_missing_token() -> None:
    with TestClient(app) as client:
        response = client.get("/collector/tasks/next")
        assert response.status_code == 401, response.text


def test_embedded_collector_accepts_configured_token(monkeypatch) -> None:
    monkeypatch.setattr(collector_app, "COLLECTOR_TOKEN", "embedded-ci-token")
    with TestClient(app) as client:
        response = client.get(
            "/collector/tasks/next",
            headers={"X-Collector-Token": "embedded-ci-token"},
        )
        assert response.status_code == 200, response.text
        assert "task" in response.json()
