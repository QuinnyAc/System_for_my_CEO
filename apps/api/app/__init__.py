# Import compatibility hooks before application startup calls metadata.create_all.
from app import schema_compat as _schema_compat  # noqa: F401
