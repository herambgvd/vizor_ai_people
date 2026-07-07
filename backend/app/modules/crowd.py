"""Crowd Counting feature module (license id: crowd)."""
from edge.core import ModuleSpec

from ._scenario import scenario_router

SPEC = ModuleSpec(
    id="crowd", name="Crowd Counting", path="/crowd",
    icon="heroicons-outline:user-group",
    router=scenario_router(event_type="crowd_threshold"),
)
