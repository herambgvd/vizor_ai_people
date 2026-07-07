"""People Analytics feature-module registry.

The edge base (auth, branding, license, messaging, reports, system, audit, ...) is
always mounted by create_base_app. Register this scenario's OWN feature modules here
as they are built — each a self-contained package under app/modules/<id>/ with a
ModuleSpec — which the license then enables/disables per client.
"""

from __future__ import annotations

from edge.core import ModuleRegistry


def build_registry() -> ModuleRegistry:
    registry = ModuleRegistry()
    # Each people-analytics scenario is a LICENSE-GATED feature module: its router
    # (events + summary) mounts at /api/modules/<id> and its nav page appears ONLY
    # when the client's license grants that module. Cameras / Live / Dashboard are
    # core (always-on) and live in app.api.domain_routers() instead.
    from .modules import counting, crowd, intrusion, loitering

    registry.register(crowd.SPEC)
    registry.register(counting.SPEC)
    registry.register(loitering.SPEC)
    registry.register(intrusion.SPEC)
    return registry
