from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest

from app.credential_crypto import decrypt_secret, encrypt_secret
from app.oauth_state import OAuthStateError, create_oauth_state, decode_oauth_state
from app.providers.meta import build_authorize_url as meta_authorize_url
from app.providers.pinterest import build_authorize_url as pinterest_authorize_url
from app.providers.youtube import build_authorize_url as youtube_authorize_url
from app.providers.youtube import video_id_from_reference


def test_credential_crypto_round_trip() -> None:
    secret = "provider-access-token-example"
    encrypted = encrypt_secret(secret)
    assert encrypted != secret
    assert decrypt_secret(encrypted) == secret


def test_oauth_state_is_account_and_provider_scoped() -> None:
    account_id = uuid4()
    token = create_oauth_state(account_id, "google")
    assert decode_oauth_state(token, "google") == account_id
    with pytest.raises(OAuthStateError):
        decode_oauth_state(token, "meta")


@pytest.mark.parametrize(
    ("reference", "expected"),
    [
        ("dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtu.be/dQw4w9WgXcQ?t=2", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://example.com/video/dQw4w9WgXcQ", None),
    ],
)
def test_youtube_video_id(reference: str, expected: str | None) -> None:
    assert video_id_from_reference(reference) == expected


def test_youtube_oauth_requests_data_and_analytics_readonly() -> None:
    url = youtube_authorize_url("client-id", "https://example.com/callback", "state-token")
    query = parse_qs(urlparse(url).query)
    scopes = set(query["scope"][0].split())
    assert "https://www.googleapis.com/auth/youtube.readonly" in scopes
    assert "https://www.googleapis.com/auth/yt-analytics.readonly" in scopes
    assert query["access_type"] == ["offline"]
    assert query["state"] == ["state-token"]


def test_meta_oauth_requests_read_permissions_used_by_sync() -> None:
    url = meta_authorize_url("app-id", "v23.0", "https://example.com/callback", "state-token")
    query = parse_qs(urlparse(url).query)
    scopes = set(query["scope"][0].replace(",", " ").split())
    assert {
        "pages_show_list",
        "pages_read_engagement",
        "pages_read_user_content",
        "read_insights",
        "instagram_basic",
        "instagram_manage_insights",
    }.issubset(scopes)
    assert query["state"] == ["state-token"]


def test_pinterest_oauth_requests_minimum_read_scopes() -> None:
    url = pinterest_authorize_url("app-id", "https://example.com/callback", "state-token")
    query = parse_qs(urlparse(url).query)
    scopes = set(query["scope"][0].replace(",", " ").split())
    assert scopes == {"user_accounts:read", "pins:read"}
    assert query["state"] == ["state-token"]
