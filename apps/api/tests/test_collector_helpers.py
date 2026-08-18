from app.collector_app import CollectorPayload, PublicMetrics, normalize_handle, normalize_url


def test_normalize_youtube_watch_url_removes_tracking() -> None:
    assert normalize_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s") == "https://youtube.com/watch?v=dQw4w9WgXcQ"


def test_normalize_social_url_removes_query_and_fragment() -> None:
    assert normalize_url("https://www.instagram.com/example/?utm_source=test#top") == "https://instagram.com/example"


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
