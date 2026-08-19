from app.runtime_app import app


def test_runtime_contains_collector_mount() -> None:
    mount_paths = {getattr(route, "path", "") for route in app.routes}
    assert "/collector" in mount_paths
