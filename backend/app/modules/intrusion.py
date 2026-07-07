"""Intrusion Detection feature module (license id: intrusion)."""
from edge.core import ModuleSpec

from ._scenario import scenario_router

SPEC = ModuleSpec(
    id="intrusion", name="Intrusion", path="/intrusion",
    icon="heroicons-outline:shield-exclamation",
    router=scenario_router(event_type="intrusion"),
)
