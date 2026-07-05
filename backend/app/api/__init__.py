"""People Analytics domain API — routers mounted always-on (not license-gated).

Importing this package also registers the scenario permission catalog (via
..domain.permissions) so the role editor knows the new keys. Feature routers are
added to ``domain_routers()`` as they are built.
"""

from ..domain import permissions as _perms  # noqa: F401 — registers perms on import


def domain_routers():
    """Every people-analytics domain router, for create_base_app(extra_routers=...)."""
    return []


__all__ = ["domain_routers"]
