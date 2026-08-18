from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx


AUTH_URL = "https://www.pinterest.com/oauth/"
TOKEN_URL = "https://api.pinterest.com/v5/oauth/token"
API_BASE = "https://api.pinterest.com/v5"
SCOPES = ["user_accounts:read", "pins:read"]


class PinterestApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class OAuthTokens:
    access_token: str
    refresh_token: str
    expires_at: datetime | None
    scopes: list[str]


def build_authorize_url(client_id: str, redirect_uri: str, state: str) -> str:
    return f"{AUTH_URL}?{urlencode({'client_id': client_id, 'redirect_uri': redirect_uri, 'response_type': 'code', 'scope': ','.join(SCOPES), 'state': state})}"


def _parse_tokens(payload: dict) -> OAuthTokens:
    token = str(payload.get("access_token") or "")
    if not token:
        raise PinterestApiError("Pinterest 没有返回 access_token。")
    expires_in = int(payload.get("expires_in") or 0)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in) if expires_in else None
    scope = str(payload.get("scope") or "")
    return OAuthTokens(
        access_token=token,
        refresh_token=str(payload.get("refresh_token") or ""),
        expires_at=expires_at,
        scopes=[item for item in scope.replace(",", " ").split() if item],
    )


def exchange_code(code: str, client_id: str, client_secret: str, redirect_uri: str) -> OAuthTokens:
    try:
        response = httpx.post(
            TOKEN_URL,
            auth=(client_id, client_secret),
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "continuous_refresh": "true",
            },
            timeout=15,
        )
        response.raise_for_status()
        return _parse_tokens(response.json())
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        raise PinterestApiError(f"Pinterest OAuth token 交换失败：{exc}") from exc


def refresh_access_token(refresh_token: str, client_id: str, client_secret: str) -> OAuthTokens:
    try:
        response = httpx.post(
            TOKEN_URL,
            auth=(client_id, client_secret),
            data={"grant_type": "refresh_token", "refresh_token": refresh_token},
            timeout=15,
        )
        response.raise_for_status()
        result = _parse_tokens(response.json())
        return OAuthTokens(
            result.access_token,
            result.refresh_token or refresh_token,
            result.expires_at,
            result.scopes,
        )
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        raise PinterestApiError(f"Pinterest access token 刷新失败：{exc}") from exc


def _get(path: str, access_token: str, *, params: dict | None = None) -> dict:
    try:
        response = httpx.get(
            f"{API_BASE}/{path.lstrip('/')}",
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            params=params or {},
            timeout=15,
        )
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        detail = ""
        if isinstance(exc, httpx.HTTPStatusError):
            detail = exc.response.text[:300]
        raise PinterestApiError(f"Pinterest API 请求失败。{detail}") from exc


def fetch_user_account(access_token: str) -> dict:
    return _get("user_account", access_token)


def list_pins(access_token: str, *, page_size: int = 25) -> list[dict]:
    payload = _get("pins", access_token, params={"page_size": min(max(page_size, 1), 100), "pin_metrics": "true"})
    return list(payload.get("items") or [])


def fetch_pin(pin_id: str, access_token: str) -> dict:
    return _get(f"pins/{pin_id}", access_token, params={"pin_metrics": "true"})


def _metric(data: dict, *names: str) -> int:
    for name in names:
        value = data.get(name)
        if value is not None:
            try:
                return int(float(value))
            except (TypeError, ValueError):
                continue
    return 0


def account_snapshot(profile: dict, pins: list[dict]) -> dict:
    return {
        "followers": _metric(profile, "follower_count", "followers"),
        "views": _metric(profile, "monthly_views", "monthly_view_count"),
        "impressions": 0,
        "reach": _metric(profile, "monthly_total_audience", "total_audience"),
        "engagements": 0,
        "content_count": _metric(profile, "pin_count") or len(pins),
        "extra_metrics": {
            "source": "pinterest_api_v5",
            "following_count": _metric(profile, "following_count"),
            "monthly_views": _metric(profile, "monthly_views", "monthly_view_count"),
        },
    }


def pin_snapshot(pin: dict) -> dict:
    metrics_container = pin.get("pin_metrics") or {}
    metrics = metrics_container.get("lifetime_metrics") or metrics_container.get("90d") or metrics_container
    metrics = metrics if isinstance(metrics, dict) else {}
    return {
        "views": _metric(metrics, "video_start", "video_10s_view", "video_mrc_view", "impression"),
        "likes": _metric(metrics, "reaction"),
        "comments": _metric(metrics, "comment"),
        "saves": _metric(metrics, "save", "repin"),
        "shares": 0,
        "impressions": _metric(metrics, "impression"),
        "reach": _metric(metrics, "total_audience"),
        "extra_metrics": {
            "source": "pinterest_api_v5",
            "pin_click": _metric(metrics, "pin_click"),
            "outbound_click": _metric(metrics, "outbound_click", "clickthrough"),
            "engagement": _metric(metrics, "engagement"),
            "metric_window": "lifetime" if metrics_container.get("lifetime_metrics") else "90d",
        },
    }
