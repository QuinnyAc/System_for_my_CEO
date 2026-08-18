from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal
from app.main import _sync_account, sync_content
from app.models import Platform, PublishedContent, SocialAccount


def run_sync_cycle() -> dict[str, int]:
    results = {"accounts_ok": 0, "accounts_error": 0, "content_ok": 0, "content_error": 0}
    with SessionLocal() as db:
        accounts = list(db.scalars(select(SocialAccount)))
        for account in accounts:
            platform = db.get(Platform, account.platform_id)
            if platform is None:
                continue
            try:
                _sync_account(db, account, platform)
                results["accounts_ok"] += 1
            except HTTPException:
                results["accounts_error"] += 1

        contents = list(db.scalars(select(PublishedContent)))
        for item in contents:
            try:
                sync_content(item.id, db)
                results["content_ok"] += 1
            except HTTPException:
                results["content_error"] += 1
    return results


def main() -> None:
    interval_seconds = max(settings.auto_sync_interval_minutes, 5) * 60
    print(
        f"Media Ops sync worker started. enabled={settings.auto_sync_enabled} "
        f"interval={settings.auto_sync_interval_minutes}m",
        flush=True,
    )

    while True:
        if settings.auto_sync_enabled:
            started_at = datetime.now(timezone.utc).isoformat()
            try:
                result = run_sync_cycle()
                print(f"[{started_at}] automatic sync completed: {result}", flush=True)
            except Exception as exc:  # keep the worker alive after a provider/network failure
                print(f"[{started_at}] automatic sync cycle failed: {exc}", flush=True)
        time.sleep(interval_seconds)


if __name__ == "__main__":
    main()
