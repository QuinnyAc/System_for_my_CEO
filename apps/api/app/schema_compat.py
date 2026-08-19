from __future__ import annotations

from sqlalchemy import event, text

from app.db import Base


def account_group_key(name: str) -> str:
    return " ".join(name.strip().split()).casefold()


def _normalized_name_sql(column: str) -> str:
    return f"lower(trim(regexp_replace({column}, '\\s+', ' ', 'g')))"


def ensure_account_group_schema(connection) -> None:
    """Apply additive account-group schema changes and backfill existing accounts.

    This is deliberately idempotent. Existing installations can upgrade simply by
    restarting the app; no destructive migration or manual SQL is required.
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
    connection.execute(text("UPDATE social_accounts SET baseline_at = created_at WHERE baseline_at IS NULL"))


@event.listens_for(Base.metadata, "after_create")
def _after_create(target, connection, **kwargs) -> None:
    ensure_account_group_schema(connection)
