from __future__ import annotations

from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import event, text

from app.db import Base
from app.models import SocialAccount


def account_group_key(name: str) -> str:
    return " ".join(name.strip().split()).casefold()


def _normalized_name_sql(column: str) -> str:
    return f"lower(trim(regexp_replace({column}, '\\s+', ' ', 'g')))"


def _group_uuid(name_key: str):
    return uuid5(NAMESPACE_URL, f"media-ops-account-group:{name_key}")


def ensure_account_group_schema(connection) -> None:
    """Apply additive account-group schema changes and backfill existing accounts.

    Existing installations upgrade on restart. Existing content is intentionally
    placed before a new baseline so historical test/import content is no longer
    treated as post-registration business content.
    """
    connection.execute(text("ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS group_id UUID"))
    connection.execute(text("ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS baseline_at TIMESTAMPTZ"))
    connection.execute(text("CREATE INDEX IF NOT EXISTS ix_social_accounts_group_id ON social_accounts (group_id)"))
    connection.execute(text("CREATE INDEX IF NOT EXISTS ix_social_accounts_baseline_at ON social_accounts (baseline_at)"))
    connection.execute(
        text(
            "DO $$ BEGIN "
            "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_social_accounts_group_id') THEN "
            "ALTER TABLE social_accounts ADD CONSTRAINT fk_social_accounts_group_id "
            "FOREIGN KEY (group_id) REFERENCES account_groups(id) ON DELETE SET NULL; "
            "END IF; END $$;"
        )
    )

    normalized = _normalized_name_sql("name")
    connection.execute(
        text(
            "WITH source AS ("
            " SELECT DISTINCT ON (name_key) name_key, display_name, created_at FROM ("
            f"  SELECT CASE WHEN {normalized} = '' THEN id::text ELSE {normalized} END AS name_key,"
            "         CASE WHEN trim(name) = '' THEN 'Unnamed Account' ELSE trim(name) END AS display_name,"
            "         created_at"
            "  FROM social_accounts"
            " ) q ORDER BY name_key, created_at ASC"
            "), prepared AS ("
            " SELECT (substr(md5(name_key),1,8)||'-'||substr(md5(name_key),9,4)||'-'||"
            "         substr(md5(name_key),13,4)||'-'||substr(md5(name_key),17,4)||'-'||"
            "         substr(md5(name_key),21,12))::uuid AS id,"
            "        display_name AS name, name_key, created_at"
            " FROM source"
            ")"
            " INSERT INTO account_groups (id, name, name_key, created_at)"
            " SELECT id, name, name_key, created_at FROM prepared"
            " ON CONFLICT (name_key) DO NOTHING"
        )
    )
    normalized_account = _normalized_name_sql("sa.name")
    connection.execute(
        text(
            "UPDATE social_accounts sa SET group_id = ag.id "
            "FROM account_groups ag "
            f"WHERE ag.name_key = CASE WHEN {normalized_account} = '' THEN sa.id::text ELSE {normalized_account} END "
            "AND (sa.group_id IS NULL OR sa.group_id <> ag.id)"
        )
    )
    connection.execute(text("UPDATE social_accounts SET baseline_at = now() WHERE baseline_at IS NULL"))


@event.listens_for(Base.metadata, "after_create")
def _after_create(target, connection, **kwargs) -> None:
    ensure_account_group_schema(connection)


def _assign_group(connection, target: SocialAccount) -> None:
    display_name = " ".join((target.name or "").strip().split()) or "Unnamed Account"
    key = account_group_key(display_name) or str(target.id)
    preferred_id = _group_uuid(key)
    connection.execute(
        text(
            "INSERT INTO account_groups (id, name, name_key, created_at) "
            "VALUES (:id, :name, :key, now()) ON CONFLICT (name_key) DO NOTHING"
        ),
        {"id": preferred_id, "name": display_name, "key": key},
    )
    group_id = connection.execute(
        text("SELECT id FROM account_groups WHERE name_key = :key"), {"key": key}
    ).scalar_one()
    target.group_id = group_id
    if target.baseline_at is None:
        target.baseline_at = datetime.now(timezone.utc)


@event.listens_for(SocialAccount, "before_insert")
def _before_account_insert(mapper, connection, target: SocialAccount) -> None:
    _assign_group(connection, target)


@event.listens_for(SocialAccount, "before_update")
def _before_account_update(mapper, connection, target: SocialAccount) -> None:
    _assign_group(connection, target)
