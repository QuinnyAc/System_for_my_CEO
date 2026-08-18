from fastapi.testclient import TestClient

from app.main import app


def test_health_and_platform_catalog() -> None:
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["system"] == "zeno_social_ops"

        platforms = client.get("/api/v1/platforms")
        assert platforms.status_code == 200
        assert {item["slug"] for item in platforms.json()} == {
            "youtube",
            "instagram",
            "facebook",
            "pinterest",
        }
