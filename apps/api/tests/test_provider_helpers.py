from uuid import uuid4

import pytest

from app.credential_crypto import decrypt_secret, encrypt_secret
from app.oauth_state import OAuthStateError, create_oauth_state, decode_oauth_state
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
