"""People Counting (directional line-crossing) feature module (license id: counting)."""
from edge.core import ModuleSpec

from ._scenario import scenario_router

SPEC = ModuleSpec(
    id="counting", name="People Counting", path="/counting",
    icon="heroicons-outline:arrows-right-left",
    router=scenario_router(event_type="line_crossing", directional=True),
)
