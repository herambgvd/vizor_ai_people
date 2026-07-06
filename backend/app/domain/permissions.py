"""People Analytics domain permissions — registered into the shared catalog at import time.

Feature/scenario code declares its own permission keys so they appear in the role
editor and can gate routes. Imported by app/api so registration happens on startup.
"""

from __future__ import annotations

from edge.auth import PERMISSIONS, Permission


class PaPerm:
    """People Analytics permission keys. Extended per feature."""

    # Cameras (video sources) + live monitoring
    CAMERA_READ = "people.camera.read"
    CAMERA_MANAGE = "people.camera.manage"
    # Analytics events (crowd / counting / loitering / intrusion)
    EVENT_READ = "people.event.read"
    EVENT_MANAGE = "people.event.manage"
    # Feature settings
    SETTINGS_MANAGE = "people.settings.manage"


PERMISSIONS.register(
    Permission(PaPerm.CAMERA_READ, "View cameras / live monitoring", "People · Cameras"),
    Permission(PaPerm.CAMERA_MANAGE, "Add / edit / delete cameras", "People · Cameras"),
    Permission(PaPerm.EVENT_READ, "View analytics events / reports", "People · Events"),
    Permission(PaPerm.EVENT_MANAGE, "Purge events / manage retention", "People · Events"),
    Permission(PaPerm.SETTINGS_MANAGE, "Manage People Analytics settings", "People · Settings"),
)
