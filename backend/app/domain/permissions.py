"""People Analytics domain permissions — registered into the shared catalog at import time.

Feature/scenario code declares its own permission keys so they appear in the role
editor and can gate routes. Imported by app/api so registration happens on startup.
"""

from __future__ import annotations

from edge.auth import PERMISSIONS, Permission


class ScenarioPerm:
    """People Analytics permission keys. Extended per feature."""

    READ = "people-analytics.read"
    MANAGE = "people-analytics.manage"


PERMISSIONS.register(
    Permission(ScenarioPerm.READ, "View People Analytics", "People Analytics"),
    Permission(ScenarioPerm.MANAGE, "Manage People Analytics", "People Analytics"),
)
