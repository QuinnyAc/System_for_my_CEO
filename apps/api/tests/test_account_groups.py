from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import COOKIE_NAME, create_session_token
from app.collector_app import app, seed_platforms
from app.db import Base, SessionLocal, engine
from app.models import AccountGroup, MonitoredAccount, Platform, SocialAccount
from app.schema_compat import account_group_key


def _prepare() -> None:
    Base.metadata.create_all(bind=engine)
    seed_platforms()


def _cleanup(group_name: str) -> None:
    _prepare()
    key = account_group_key(group_name)
    with SessionLocal() as db:
        accounts = list(db.scalars(select(SocialAccount).where(SocialAccount.name == group_name)))
        profiles = [account.profile_url for account in accounts if account.profile_url]
        if profiles:
            for monitor in db.scalars(select(MonitoredAccount).where(MonitoredAccount.profile_url.in_(profiles))):
                db.delete(monitor)
        for account in accounts:
            db.delete(account)
        group = db.scalar(select(AccountGroup).where(AccountGroup.name_key == key))
        if group:
            db.delete(group)
        db.commit()


def test_same_name_across_platforms_shares_group_and_gets_independent_baselines() -> None:
    group_name = "Zeno CI 01"
    _cleanup(group_name)

    with TestClient(app) as client:
        client.cookies.set(COOKIE_NAME, create_session_token())

        youtube = client.post(
            "/admin/accounts",
            json={
                "platform": "youtube",
                "name": group_name,
                "profile_url": "https://www.youtube.com/@zeno-ci-group",
                "machine_name": None,
            },
        )
        assert youtube.status_code == 200, youtube.text

        pinterest = client.post(
            "/admin/accounts",
            json={
                "platform": "pinterest",
                "name": "  Zeno   CI  01  ",
                "profile_url": "https://www.pinterest.com/zeno-ci-group/",
                "machine_name": None,
            },
        )
        assert pinterest.status_code == 200, pinterest.text

        with SessionLocal() as db:
            youtube_platform = db.scalar(select(Platform).where(Platform.slug == "youtube"))
            pinterest_platform = db.scalar(select(Platform).where(Platform.slug == "pinterest"))
            assert youtube_platform is not None
            assert pinterest_platform is not None

            yt_account = db.scalar(
                select(SocialAccount).where(
                    SocialAccount.platform_id == youtube_platform.id,
                    SocialAccount.profile_url == "https://youtube.com/@zeno-ci-group",
                )
            )
            pin_account = db.scalar(
                select(SocialAccount).where(
                    SocialAccount.platform_id == pinterest_platform.id,
                    SocialAccount.profile_url == "https://pinterest.com/zeno-ci-group",
                )
            )
            assert yt_account is not None
            assert pin_account is not None
            assert yt_account.id != pin_account.id
            assert yt_account.group_id is not None
            assert yt_account.group_id == pin_account.group_id
            assert yt_account.baseline_at is not None
            assert pin_account.baseline_at is not None

            group = db.get(AccountGroup, yt_account.group_id)
            assert group is not None
            assert group.name_key == account_group_key(group_name)

        repeated = client.post(
            "/admin/accounts",
            json={
                "platform": "youtube",
                "name": group_name,
                "profile_url": "https://www.youtube.com/@zeno-ci-group",
                "machine_name": None,
            },
        )
        assert repeated.status_code == 200, repeated.text
        assert repeated.json()["account_created"] is False
        assert repeated.json()["account_id"] == youtube.json()["account_id"]

    _cleanup(group_name)
