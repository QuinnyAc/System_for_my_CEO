from fastapi.testclient import TestClient

from app.runtime_app import app


def test_runtime_health_contract() -> None:
    with TestClient(app) as client:
        api_health = client.get("/health")
        collector_health = client.get("/collector/health")

    assert api_health.status_code == 200, api_health.text
    assert collector_health.status_code == 200, collector_health.text
    assert api_health.json().get("status") == "ok"
    assert collector_health.json().get("status") == "ok"
