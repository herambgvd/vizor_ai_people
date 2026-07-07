"""Loitering feature module (license id: loitering)."""
from edge.core import ModuleSpec

from ._scenario import scenario_router

SPEC = ModuleSpec(
    id="loitering", name="Loitering", path="/loitering",
    icon="heroicons-outline:clock",
    router=scenario_router(event_type="loitering"),
)
