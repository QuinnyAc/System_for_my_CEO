from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    database_url: str = "postgresql+psycopg://zeno_social_ops:change-me-local@localhost:55432/zeno_social_ops"
    cors_origins: str = "http://localhost:3100"
    public_web_url: str = "http://localhost:3100"
    app_username: str = "admin"
    app_password: str = "change-me-now"
    session_secret: str = "development-only-zeno-session-secret"
    youtube_api_key: str = ""
    google_client_id: str = ""
    google_client_secret: str = ""
    meta_app_id: str = ""
    meta_app_secret: str = ""
    pinterest_app_id: str = ""
    pinterest_app_secret: str = ""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
