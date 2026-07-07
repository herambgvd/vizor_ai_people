"""People Analytics domain API — routers mounted always-on (not license-gated).

Importing this package also registers the scenario permission catalog (via
..domain.permissions) so the role editor knows the new keys. Feature routers are
added to ``domain_routers()`` as they are built.
"""

from ..domain import permissions as _perms  # noqa: F401 — registers perms on import
from . import analytics, cameras, live


def domain_routers():
    """CORE (always-on) people-analytics routers for create_base_app(extra_routers=...).

    Cameras, the Live wall, and the Dashboard summary are always available. The four
    scenario modules (crowd/counting/loitering/intrusion) are LICENSE-GATED instead —
    registered in app.registry.build_registry() and mounted per the client's license.
    """
    return [cameras.router, live.router, analytics.router]


__all__ = ["domain_routers"]
