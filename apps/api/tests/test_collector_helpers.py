from app.collector_app import (
    CollectorPayload,
    PublicMetrics,
    normalize_handle,
    normalize_profile_url,
    normalize_url,
    platform_for_url,
)


def test_normalize_youtube_watch_url_removes_tracking() -> None:
    assert normalize_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s") == "https://youtube.com/watch?v=dQw4w9WgXcQ"


def test_normalize_social_url_removes_tracking_query_and_fragment() -> None:
    assert normalize_url("https://www.instagram.com/example/?utm_source=test#top") == "https://instagram.com/example"


def test_facebook_story_identity_query_is_preserved() -> None:
    first = normalize_url("https://www.facebook.com/story.php?story_fbid=111&id=222&utm_source=test")
    second = normalize_url("https://www.facebook.com/story.php?story_fbid=333&id=222&utm_source=test")
    assert first == "https://facebook.com/story.php?story_fbid=111&id=222"
    assert second == "https://facebook.com/story.php?story_fbid=333&id=222"
    assert first != second


def test_facebook_photo_and_watch_identity_is_preserved() -> None:
    assert normalize_url("https://facebook.com/photo.php?fbid=123&id=456&set=x") == "https://facebook.com/photo.php?fbid=123&id=456"
    assert normalize_url("https://facebook.com/watch/?v=987&utm_source=x") == "https://facebook.com/watch?v=987"


def test_facebook_profile_id_is_preserved() -> None:
    assert normalize_profile_url("facebook", "https://www.facebook.com/profile.php?id=123&utm_source=x") == "https://facebook.com/profile.php?id=123"


def test_youtube_profile_tabs_normalize_to_channel_home() -> None:
    assert normalize_profile_url("youtube", "https://www.youtube.com/@creator/shorts") == "https://youtube.com/@creator"
    assert normalize_profile_url("youtube", "https://www.youtube.com/@creator/videos") == "https://youtube.com/@creator"


def test_profile_normalization_keeps_only_account_path_for_instagram_and_pinterest() -> None:
    assert normalize_profile_url("instagram", "https://www.instagram.com/creator/reels/") == "https://instagram.com/creator"
    assert normalize_profile_url("pinterest", "https://www.pinterest.com/creator/_created/") == "https://pinterest.com/creator"


def test_platform_detection_supports_short_link_domains() -> None:
    assert platform_for_url("https://youtu.be/abc") == "youtube"
    assert platform_for_url("https://fb.watch/abc") == "facebook"
    assert platform_for_url("https://pin.it/abc") == "pinterest"


def test_normalize_handle() -> None:
    assert normalize_handle("creator") == "@creator"
    assert normalize_handle("@creator") == "@creator"
    assert normalize_handle("") == ""


def test_public_metrics_accept_zero_values() -> None:
    metrics = PublicMetrics(views=0, likes=0, comments=0)
    assert metrics.views == 0
    assert metrics.likes == 0
    assert metrics.comments == 0


def test_collector_payload_defaults_to_content() -> None:
    payload = CollectorPayload(platform="youtube", url="https://youtube.com/watch?v=dQw4w9WgXcQ")
    assert payload.page_type == "content"
    assert payload.metrics.followers is None
    assert payload.discovery_complete is False
