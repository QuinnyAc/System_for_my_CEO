from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx


META_SCOPES = [
    "pages_show_list",
    "pages_read_engagement",
    "pages_read_user_content",
    "read_insights",
    "instagram_basic",
    "instagram_manage_insights",
]


class MetaApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class OAuthTokens:
    access_token: str
    expires_at: datetime | None
    scopes: list[str]


def build_authorize_url(app_id: str, graph_version: str, redirect_uri: str, state: str) -> str:
    return (
        f"https://www.facebook.com/{graph_version}/dialog/oauth?"
        + urlencode(
            {
                "client_id": app_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": ",".join(META_SCOPES),
                "state": state,
            }
        )
    )


def _graph_url(graph_version: str, path: str) -> str:
    return f"https://graph.facebook.com/{graph_version}/{path.lstrip('/')}"


def exchange_code(code: str, app_id: str, app_secret: str, graph_version: str, redirect_uri: str) -> OAuthTokens:
    try:
        response = httpx.get(
            _graph_url(graph_version, "oauth/access_token"),
            params={"client_id": app_id, "client_secret": app_secret, "redirect_uri": redirect_uri, "code": code},
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
        token = str(payload.get("access_token") or "")
        if not token:
            raise MetaApiError("Meta 没有返回 access_token。")
        expires_in = int(payload.get("expires_in") or 0)
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in) if expires_in else None
        return OAuthTokens(token, expires_at, META_SCOPES)
    except MetaApiError:
        raise
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        raise MetaApiError(f"Meta OAuth token 交换失败：{exc}") from exc


def extend_user_token(token: str, app_id: str, app_secret: str, graph_version: str) -> OAuthTokens:
    try:
        response = httpx.get(
            _graph_url(graph_version, "oauth/access_token"),
            params={
                "grant_type": "fb_exchange_token",
                "client_id": app_id,
                "client_secret": app_secret,
                "fb_exchange_token": token,
            },
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
        extended = str(payload.get("access_token") or token)
        expires_in = int(payload.get("expires_in") or 0)
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in) if expires_in else None
        return OAuthTokens(extended, expires_at, META_SCOPES)
    except (httpx.HTTPError, ValueError, TypeError):
        return OAuthTokens(token, None, META_SCOPES)


def _get(path: str, access_token: str, graph_version: str, *, params: dict | None = None) -> dict:
    request_params = dict(params or {})
    request_params["access_token"] = access_token
    try:
        response = httpx.get(_graph_url(graph_version, path), params=request_params, timeout=15)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        detail = ""
        if isinstance(exc, httpx.HTTPStatusError):
            detail = exc.response.text[:300]
        raise MetaApiError(f"Meta Graph API 请求失败。{detail}") from exc


def fetch_managed_pages(user_access_token: str, graph_version: str) -> list[dict]:
    payload = _get(
        "me/accounts",
        user_access_token,
        graph_version,
        params={"fields": "id,name,access_token,tasks,instagram_business_account{id,username,name}"},
    )
    return list(payload.get("data") or [])


def resolve_managed_asset(*, platform_slug: str, account_external_id: str | None, handle: str | None, account_name: str, pages: list[dict]) -> dict:
    if platform_slug == "facebook":
        candidates = pages
        id_key = "id"
        handle_key = "name"
    elif platform_slug == "instagram":
        candidates = []
        for page in pages:
            ig = page.get("instagram_business_account") or {}
            if ig:
                candidates.append({**ig, "access_token": page.get("access_token"), "page_id": page.get("id")})
        id_key = "id"
        handle_key = "username"
    else:
        raise MetaApiError("Meta 平台不支持。")

    if account_external_id:
        for candidate in candidates:
            if str(candidate.get(id_key) or "") == str(account_external_id):
                return candidate
    normalized_handle = (handle or "").lstrip("@").lower()
    if normalized_handle:
        for candidate in candidates:
            if str(candidate.get(handle_key) or "").lstrip("@").lower() == normalized_handle:
                return candidate
    normalized_name = account_name.strip().lower()
    if normalized_name:
        for candidate in candidates:
            if str(candidate.get("name") or "").strip().lower() == normalized_name:
                return candidate
    if len(candidates) == 1:
        return candidates[0]
    raise MetaApiError("无法唯一识别要连接的 Meta 账号。请填写准确的平台 ID 或用户名后重试。")


def fetch_facebook_page(page_id: str, access_token: str, graph_version: str) -> dict:
    return _get(page_id, access_token, graph_version, params={"fields": "id,name,followers_count,fan_count"})


def fetch_instagram_profile(account_id: str, access_token: str, graph_version: str) -> dict:
    return _get(account_id, access_token, graph_version, params={"fields": "id,username,name,followers_count,media_count"})


def list_facebook_content(page_id: str, access_token: str, graph_version: str, *, limit: int = 25) -> list[dict]:
    payload = _get(
        f"{page_id}/published_posts",
        access_token,
        graph_version,
        params={"fields": "id,message,created_time,permalink_url", "limit": min(max(limit, 1), 50)},
    )
    return list(payload.get("data") or [])


def list_instagram_content(account_id: str, access_token: str, graph_version: str, *, limit: int = 25) -> list[dict]:
    payload = _get(
        f"{account_id}/media",
        access_token,
        graph_version,
        params={
            "fields": "id,caption,media_type,media_product_type,permalink,timestamp",
            "limit": min(max(limit, 1), 50),
        },
    )
    return list(payload.get("data") or [])


def _metric_value(payload: dict, name: str) -> int:
    for item in payload.get("data") or []:
        if str(item.get("name") or "") != name:
            continue
        values = item.get("values") or []
        if values:
            raw = values[0].get("value")
            if isinstance(raw, (int, float)):
                return int(raw)
    return 0


def facebook_account_snapshot(profile: dict, access_token: str, graph_version: str) -> dict:
    page_id = str(profile.get("id") or "")
    insights = _get(
        f"{page_id}/insights",
        access_token,
        graph_version,
        params={"metric": "page_impressions,page_post_engagements", "period": "day"},
    ) if page_id else {"data": []}
    return {
        "followers": int(profile.get("followers_count") or profile.get("fan_count") or 0),
        "views": 0,
        "impressions": _metric_value(insights, "page_impressions"),
        "reach": 0,
        "engagements": _metric_value(insights, "page_post_engagements"),
        "content_count": 0,
        "extra_metrics": {"provider": "meta"},
    }


def instagram_account_snapshot(profile: dict, access_token: str, graph_version: str) -> dict:
    account_id = str(profile.get("id") or "")
    insights = _get(
        f"{account_id}/insights",
        access_token,
        graph_version,
        params={"metric": "views,reach,accounts_engaged", "period": "day"},
    ) if account_id else {"data": []}
    return {
        "followers": int(profile.get("followers_count") or 0),
        "views": _metric_value(insights, "views"),
        "impressions": 0,
        "reach": _metric_value(insights, "reach"),
        "engagements": _metric_value(insights, "accounts_engaged"),
        "content_count": int(profile.get("media_count") or 0),
        "extra_metrics": {"provider": "meta"},
    }


def facebook_content_snapshot(post_id: str, access_token: str, graph_version: str) -> dict:
    reactions = _get(f"{post_id}/reactions", access_token, graph_version, params={"summary": "total_count", "limit": 0})
    comments = _get(f"{post_id}/comments", access_token, graph_version, params={"summary": "total_count", "limit": 0})
    insights = _get(
        f"{post_id}/insights",
        access_token,
        graph_version,
        params={"metric": "post_impressions,post_impressions_unique,post_engaged_users"},
    )
    return {
        "views": _metric_value(insights, "post_impressions"),
        "likes": int((reactions.get("summary") or {}).get("total_count") or 0),
        "comments": int((comments.get("summary") or {}).get("total_count") or 0),
        "saves": 0,
        "shares": 0,
        "impressions": _metric_value(insights, "post_impressions"),
        "reach": _metric_value(insights, "post_impressions_unique"),
        "extra_metrics": {"engaged_users": _metric_value(insights, "post_engaged_users"), "provider": "meta"},
    }


def instagram_content_snapshot(media_id: str, access_token: str, graph_version: str) -> dict:
    media = _get(media_id, access_token, graph_version, params={"fields": "like_count,comments_count,media_product_type"})
    insights = _get(
        f"{media_id}/insights",
        access_token,
        graph_version,
        params={"metric": "views,reach,saved,shares"},
    )
    return {
        "views": _metric_value(insights, "views"),
        "likes": int(media.get("like_count") or 0),
        "comments": int(media.get("comments_count") or 0),
        "saves": _metric_value(insights, "saved"),
        "shares": _metric_value(insights, "shares"),
        "impressions": 0,
        "reach": _metric_value(insights, "reach"),
        "extra_metrics": {"provider": "meta", "media_product_type": media.get("media_product_type")},
    }
