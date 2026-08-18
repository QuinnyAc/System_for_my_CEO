from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


def test_health_auth_and_platform_catalog() -> None:
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["system"] == "zeno_social_ops"

        protected = client.get("/api/v1/platforms")
        assert protected.status_code == 401

        login = client.post("/api/v1/auth/login", json={"username": settings.app_username, "password": settings.app_password})
        assert login.status_code == 200

        platforms = client.get("/api/v1/platforms")
        assert platforms.status_code == 200
        assert {item["slug"] for item in platforms.json()} == {"youtube", "instagram", "facebook", "pinterest"}
