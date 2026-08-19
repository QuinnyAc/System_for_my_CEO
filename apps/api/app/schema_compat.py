from __future__ import annotations

from datetime import timezone

from sqlalchemy import select, text

from app.db import SessionLocal, engine
from app.models import AccountGroup, SocialAccount


def account_group_key(name: str) -> str:
    return " ".join(name.strip().split()).casefold()


def ensure_account_group_schema() -> None:
    """Apply the small additive schema changes needed by existing installations.

    SQLAlchemy create_all creates new tables but does not add columns to an existing
    social_accounts table, so we keep these two additive ALTERs here. They are safe
    to run at every startup.
    """
    with engine.begin() as connection:
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

    with SessionLocal() as db:
        groups = {group.name_key: group for group in db.scalars(select(AccountGroup)).all()}
        changed = False
        for account in db.scalars(select(SocialAccount).order_by(SocialAccount.created_at.asc())).all():
            key = account_group_key(account.name)
            if not key:
                key = str(account.id)
            group = groups.get(key)
            if group is None:
                group = AccountGroup(name=account.name.strip() or "Unnamed Account", name_key=key)
                db.add(group)
                db.flush()
                groups[key] = group
                changed = True
            if account.group_id != group.id:
                account.group_id = group.id
                changed = True
            if account.baseline_at is None:
                account.baseline_at = account.created_at
                if account.baseline_at is not None and account.baseline_at.tzinfo is None:
                    account.baseline_at = account.baseline_at.replace(tzinfo=timezone.utc)
                changed = True
        if changed:
            db.commit()
