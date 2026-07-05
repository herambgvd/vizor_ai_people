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
    # Feature modules will be registered here, e.g.:
    #   from .modules import feature_a
    #   registry.register(feature_a.SPEC)
    return registry
