from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx


META_SCOPES = [
    "pages_show_list",
    "pages_read_engagement",
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
            if ig.get("id"):
                candidates.append({**ig, "page_id": page.get("id"), "page_name": page.get("name"), "access_token": page.get("access_token")})
        id_key = "id"
        handle_key = "username"
    else:
        raise MetaApiError("该账号不是 Meta 支持的平台账号。")

    if account_external_id:
        for item in candidates:
            if str(item.get(id_key) or "") == account_external_id:
                return item

    normalized_handle = (handle or "").lstrip("@").strip().lower()
    if normalized_handle:
        for item in candidates:
            if str(item.get(handle_key) or "").lstrip("@").strip().lower() == normalized_handle:
                return item

    normalized_name = account_name.strip().lower()
    for item in candidates:
        if str(item.get("name") or item.get("page_name") or "").strip().lower() == normalized_name:
            return item

    if len(candidates) == 1:
        return candidates[0]

    if not candidates:
        if platform_slug == "instagram":
            raise MetaApiError("没有找到已连接到 Facebook Page 的 Instagram Professional 账号。")
        raise MetaApiError("当前 Meta 用户没有返回可管理的 Facebook Page。")
    raise MetaApiError("检测到多个可管理账号，请先在账号记录中填写准确的平台内部 ID 或 Handle 后重新授权。")


def fetch_facebook_page(page_id: str, page_access_token: str, graph_version: str) -> dict:
    return _get(page_id, page_access_token, graph_version, params={"fields": "id,name,fan_count,followers_count"})


def fetch_instagram_profile(ig_id: str, page_access_token: str, graph_version: str) -> dict:
    return _get(ig_id, page_access_token, graph_version, params={"fields": "id,username,name,followers_count,media_count"})


def _safe_insight(object_id: str, metric: str, token: str, graph_version: str, *, period: str | None = None) -> int:
    params: dict[str, str] = {"metric": metric}
    if period:
        params["period"] = period
    try:
        payload = _get(f"{object_id}/insights", token, graph_version, params=params)
    except MetaApiError:
        return 0
    data = payload.get("data") or []
    if not data:
        return 0
    item = data[0]
    if isinstance(item.get("total_value"), dict):
        try:
            return int(float(item["total_value"].get("value") or 0))
        except (TypeError, ValueError):
            return 0
    values = item.get("values") or []
    if values:
        try:
            return int(float(values[-1].get("value") or 0))
        except (TypeError, ValueError):
            return 0
    return 0


def facebook_account_snapshot(profile: dict, page_access_token: str, graph_version: str) -> dict:
    page_id = str(profile.get("id") or "")
    followers = int(profile.get("followers_count") or profile.get("fan_count") or 0)
    return {
        "followers": followers,
        "views": _safe_insight(page_id, "page_views_total", page_access_token, graph_version, period="day"),
        "impressions": _safe_insight(page_id, "page_impressions", page_access_token, graph_version, period="day"),
        "reach": _safe_insight(page_id, "page_impressions_unique", page_access_token, graph_version, period="day"),
        "engagements": _safe_insight(page_id, "page_post_engagements", page_access_token, graph_version, period="day"),
        "content_count": 0,
        "extra_metrics": {"source": "meta_graph_api", "fan_count": int(profile.get("fan_count") or 0)},
    }


def instagram_account_snapshot(profile: dict, page_access_token: str, graph_version: str) -> dict:
    ig_id = str(profile.get("id") or "")
    return {
        "followers": int(profile.get("followers_count") or 0),
        "views": _safe_insight(ig_id, "profile_views", page_access_token, graph_version, period="day"),
        "impressions": 0,
        "reach": _safe_insight(ig_id, "reach", page_access_token, graph_version, period="day"),
        "engagements": _safe_insight(ig_id, "total_interactions", page_access_token, graph_version, period="day"),
        "content_count": int(profile.get("media_count") or 0),
        "extra_metrics": {
            "source": "instagram_graph_api",
            "accounts_engaged": _safe_insight(ig_id, "accounts_engaged", page_access_token, graph_version, period="day"),
        },
    }


def list_facebook_content(page_id: str, page_access_token: str, graph_version: str, *, limit: int = 25) -> list[dict]:
    payload = _get(
        f"{page_id}/published_posts",
        page_access_token,
        graph_version,
        params={"fields": "id,message,permalink_url,created_time", "limit": str(min(max(limit, 1), 100))},
    )
    return list(payload.get("data") or [])


def list_instagram_content(ig_id: str, page_access_token: str, graph_version: str, *, limit: int = 25) -> list[dict]:
    payload = _get(
        f"{ig_id}/media",
        page_access_token,
        graph_version,
        params={"fields": "id,caption,media_type,media_product_type,permalink,timestamp", "limit": str(min(max(limit, 1), 100))},
    )
    return list(payload.get("data") or [])


def facebook_content_snapshot(post_id: str, page_access_token: str, graph_version: str) -> dict:
    basic = _get(
        post_id,
        page_access_token,
        graph_version,
        params={"fields": "reactions.limit(0).summary(true),comments.limit(0).summary(true),shares"},
    )
    reactions = (((basic.get("reactions") or {}).get("summary") or {}).get("total_count") or 0)
    comments = (((basic.get("comments") or {}).get("summary") or {}).get("total_count") or 0)
    shares = ((basic.get("shares") or {}).get("count") or 0)
    impressions = _safe_insight(post_id, "post_impressions", page_access_token, graph_version)
    reach = _safe_insight(post_id, "post_impressions_unique", page_access_token, graph_version)
    video_views = _safe_insight(post_id, "post_video_views", page_access_token, graph_version)
    engagements = _safe_insight(post_id, "post_engaged_users", page_access_token, graph_version)
    return {
        "views": video_views or impressions,
        "likes": int(reactions),
        "comments": int(comments),
        "saves": 0,
        "shares": int(shares),
        "impressions": impressions,
        "reach": reach,
        "extra_metrics": {"source": "meta_graph_api", "engaged_users": engagements, "video_views": video_views},
    }


def instagram_content_snapshot(media_id: str, page_access_token: str, graph_version: str) -> dict:
    basic = _get(media_id, page_access_token, graph_version, params={"fields": "id,like_count,comments_count,media_type,media_product_type"})
    views = _safe_insight(media_id, "views", page_access_token, graph_version)
    reach = _safe_insight(media_id, "reach", page_access_token, graph_version)
    shares = _safe_insight(media_id, "shares", page_access_token, graph_version)
    saves = _safe_insight(media_id, "saved", page_access_token, graph_version)
    total_interactions = _safe_insight(media_id, "total_interactions", page_access_token, graph_version)
    return {
        "views": views,
        "likes": int(basic.get("like_count") or 0),
        "comments": int(basic.get("comments_count") or 0),
        "saves": saves,
        "shares": shares,
        "impressions": 0,
        "reach": reach,
        "extra_metrics": {"source": "instagram_graph_api", "total_interactions": total_interactions},
    }
