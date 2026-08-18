from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, urlencode, urlparse

import httpx


YOUTUBE_SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API_BASE = "https://www.googleapis.com/youtube/v3"
ANALYTICS_URL = "https://youtubeanalytics.googleapis.com/v2/reports"


class YouTubeApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class OAuthTokens:
    access_token: str
    refresh_token: str
    expires_at: datetime | None
    scopes: list[str]


@dataclass(frozen=True)
class AccountMetrics:
    followers: int
    views: int
    content_count: int
    extra_metrics: dict


@dataclass(frozen=True)
class ContentMetrics:
    views: int
    likes: int
    comments: int
    saves: int
    shares: int
    extra_metrics: dict


def build_authorize_url(client_id: str, redirect_uri: str, state: str) -> str:
    return f"{AUTH_URL}?{urlencode({'client_id': client_id, 'redirect_uri': redirect_uri, 'response_type': 'code', 'scope': ' '.join(YOUTUBE_SCOPES), 'access_type': 'offline', 'prompt': 'consent', 'include_granted_scopes': 'true', 'state': state})}"


def _tokens(payload: dict) -> OAuthTokens:
    access_token = str(payload.get("access_token") or "")
    if not access_token:
        raise YouTubeApiError("Google 没有返回 access_token。")
    expires_in = int(payload.get("expires_in") or 0)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in) if expires_in else None
    scope = str(payload.get("scope") or " ".join(YOUTUBE_SCOPES))
    return OAuthTokens(
        access_token=access_token,
        refresh_token=str(payload.get("refresh_token") or ""),
        expires_at=expires_at,
        scopes=[item for item in scope.replace(",", " ").split() if item],
    )


def exchange_code(code: str, client_id: str, client_secret: str, redirect_uri: str) -> OAuthTokens:
    try:
        response = httpx.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            timeout=15,
        )
        response.raise_for_status()
        return _tokens(response.json())
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        raise YouTubeApiError(f"Google OAuth token 交换失败：{exc}") from exc


def refresh_access_token(refresh_token: str, client_id: str, client_secret: str) -> OAuthTokens:
    try:
        response = httpx.post(
            TOKEN_URL,
            data={
                "refresh_token": refresh_token,
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
            },
            timeout=15,
        )
        response.raise_for_status()
        result = _tokens(response.json())
        return OAuthTokens(result.access_token, refresh_token, result.expires_at, result.scopes)
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        raise YouTubeApiError(f"Google OAuth token 刷新失败：{exc}") from exc


def _get(path: str, *, params: dict, api_key: str = "", access_token: str = "") -> dict:
    request_params = dict(params)
    headers: dict[str, str] = {}
    if api_key:
        request_params["key"] = api_key
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    try:
        response = httpx.get(f"{API_BASE}/{path}", params=request_params, headers=headers, timeout=15)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        detail = ""
        if isinstance(exc, httpx.HTTPStatusError):
            detail = exc.response.text[:300]
        raise YouTubeApiError(f"YouTube API 请求失败。{detail}") from exc


def fetch_authenticated_channel(access_token: str) -> dict:
    payload = _get(
        "channels",
        params={"part": "snippet,statistics,contentDetails", "mine": "true"},
        access_token=access_token,
    )
    items = payload.get("items") or []
    if not items:
        raise YouTubeApiError("该 Google 授权账号下没有找到 YouTube 频道。")
    return items[0]


def fetch_channel(channel_id: str, *, api_key: str = "", access_token: str = "") -> dict:
    payload = _get(
        "channels",
        params={"part": "snippet,statistics,contentDetails", "id": channel_id},
        api_key=api_key,
        access_token=access_token,
    )
    items = payload.get("items") or []
    if not items:
        raise YouTubeApiError("没有找到该 YouTube Channel ID。")
    return items[0]


def channel_metrics(channel: dict) -> AccountMetrics:
    stats = channel.get("statistics") or {}
    return AccountMetrics(
        followers=int(stats.get("subscriberCount") or 0),
        views=int(stats.get("viewCount") or 0),
        content_count=int(stats.get("videoCount") or 0),
        extra_metrics={
            "source": "youtube_data_api",
            "hidden_subscriber_count": bool(stats.get("hiddenSubscriberCount", False)),
            "subscriber_count_is_rounded": True,
        },
    )


def fetch_channel_analytics(access_token: str, *, days: int = 28) -> dict:
    period_days = min(max(days, 1), 90)
    end_date = date.today() - timedelta(days=1)
    start_date = end_date - timedelta(days=period_days - 1)
    metrics = [
        "views",
        "estimatedMinutesWatched",
        "averageViewDuration",
        "likes",
        "comments",
        "shares",
        "subscribersGained",
        "subscribersLost",
    ]
    try:
        response = httpx.get(
            ANALYTICS_URL,
            params={
                "ids": "channel==MINE",
                "startDate": start_date.isoformat(),
                "endDate": end_date.isoformat(),
                "metrics": ",".join(metrics),
            },
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        detail = ""
        if isinstance(exc, httpx.HTTPStatusError):
            detail = exc.response.text[:300]
        raise YouTubeApiError(f"YouTube Analytics API 请求失败。{detail}") from exc

    headers = [str(item.get("name") or "") for item in payload.get("columnHeaders") or []]
    rows = payload.get("rows") or []
    values = rows[0] if rows else []
    result: dict[str, int | float | str] = {
        "period_start": start_date.isoformat(),
        "period_end": end_date.isoformat(),
    }
    for index, name in enumerate(headers):
        if not name or index >= len(values):
            continue
        value = values[index]
        if name == "averageViewDuration":
            try:
                result[name] = float(value or 0)
            except (TypeError, ValueError):
                result[name] = 0.0
        else:
            try:
                result[name] = int(float(value or 0))
            except (TypeError, ValueError):
                result[name] = 0
    return result


def video_id_from_reference(value: str) -> str | None:
    raw = value.strip()
    if len(raw) == 11 and all(ch.isalnum() or ch in "-_" for ch in raw):
        return raw
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    host = parsed.netloc.lower().split(":", 1)[0]
    if host.startswith("www."):
        host = host[4:]
    if host == "youtu.be":
        candidate = parsed.path.strip("/").split("/", 1)[0]
        return candidate or None
    if host not in {"youtube.com", "m.youtube.com", "music.youtube.com"}:
        return None
    if parsed.path == "/watch":
        return parse_qs(parsed.query).get("v", [None])[0]
    for prefix in ("/shorts/", "/embed/", "/live/"):
        if parsed.path.startswith(prefix):
            candidate = parsed.path[len(prefix):].split("/", 1)[0]
            return candidate or None
    return None


def fetch_video(video_id: str, *, api_key: str = "", access_token: str = "") -> dict:
    payload = _get(
        "videos",
        params={"part": "snippet,statistics,contentDetails", "id": video_id},
        api_key=api_key,
        access_token=access_token,
    )
    items = payload.get("items") or []
    if not items:
        raise YouTubeApiError("没有找到该 YouTube 视频。")
    return items[0]


def video_metrics(video: dict) -> ContentMetrics:
    stats = video.get("statistics") or {}
    return ContentMetrics(
        views=int(stats.get("viewCount") or 0),
        likes=int(stats.get("likeCount") or 0),
        comments=int(stats.get("commentCount") or 0),
        saves=0,
        shares=0,
        extra_metrics={
            "source": "youtube_data_api",
            "saves_available": False,
            "shares_available": False,
        },
    )


def list_recent_uploads(channel: dict, *, api_key: str = "", access_token: str = "", limit: int = 25) -> list[dict]:
    uploads_id = (((channel.get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads"))
    if not uploads_id:
        raise YouTubeApiError("YouTube 没有返回频道 uploads playlist。")
    payload = _get(
        "playlistItems",
        params={"part": "snippet,contentDetails", "playlistId": uploads_id, "maxResults": min(max(limit, 1), 50)},
        api_key=api_key,
        access_token=access_token,
    )
    ids = [str((item.get("contentDetails") or {}).get("videoId") or "") for item in payload.get("items") or []]
    ids = [item for item in ids if item]
    if not ids:
        return []
    details = _get(
        "videos",
        params={"part": "snippet,statistics,contentDetails", "id": ",".join(ids)},
        api_key=api_key,
        access_token=access_token,
    )
    by_id = {str(item.get("id")): item for item in details.get("items") or []}
    return [by_id[item] for item in ids if item in by_id]
