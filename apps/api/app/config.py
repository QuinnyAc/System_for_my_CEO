from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    database_url: str = "postgresql+psycopg://zeno_social_ops:change-me-local@localhost:55432/zeno_social_ops"
    cors_origins: str = "http://localhost:3100"
    public_web_url: str = "http://localhost:3100"
    app_username: str = "admin"
    app_password: str = "change-me-now"
    session_secret: str = "development-only-zeno-session-secret"
    credentials_secret: str = "development-only-zeno-credentials-secret"
    auto_sync_enabled: bool = False
    auto_sync_interval_minutes: int = 60

    # Google / YouTube
    youtube_api_key: str = ""
    google_client_id: str = ""
    google_client_secret: str = ""

    # Meta / Instagram / Facebook
    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_graph_version: str = "v23.0"

    # Pinterest
    pinterest_app_id: str = ""
    pinterest_app_secret: str = ""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def normalized_public_web_url(self) -> str:
        return self.public_web_url.rstrip("/")

    @property
    def google_callback_url(self) -> str:
        return f"{self.normalized_public_web_url}/api/v1/oauth/google/callback"

    @property
    def meta_callback_url(self) -> str:
        return f"{self.normalized_public_web_url}/api/v1/oauth/meta/callback"

    @property
    def pinterest_callback_url(self) -> str:
        return f"{self.normalized_public_web_url}/api/v1/oauth/pinterest/callback"

    @property
    def google_oauth_configured(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def meta_oauth_configured(self) -> bool:
        return bool(self.meta_app_id and self.meta_app_secret)

    @property
    def pinterest_oauth_configured(self) -> bool:
        return bool(self.pinterest_app_id and self.pinterest_app_secret)

    @model_validator(mode="after")
    def production_security(self) -> "Settings":
        if self.auto_sync_interval_minutes < 5:
            raise ValueError("AUTO_SYNC_INTERVAL_MINUTES must be at least 5")
        if self.app_env == "production":
            weak_values = {
                "change-me-now",
                "development-only-zeno-session-secret",
                "development-only-zeno-credentials-secret",
            }
            if self.app_password in weak_values:
                raise ValueError("APP_PASSWORD must be changed in production")
            if self.session_secret in weak_values or len(self.session_secret) < 32:
                raise ValueError("SESSION_SECRET must be a strong production secret")
            if self.credentials_secret in weak_values or len(self.credentials_secret) < 32:
                raise ValueError("CREDENTIALS_SECRET must be a strong production secret")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
