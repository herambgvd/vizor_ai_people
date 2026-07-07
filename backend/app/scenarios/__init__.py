"""People-analytics scenario engines.

Each engine is a stateful per-camera class rebuilt when the camera's config changes.
It takes its ``scenarios[...]`` sub-dict, and its ``update(tracks, w, h, now)`` returns
a (possibly empty) list of trigger dicts the stream worker turns into events.
"""

from __future__ import annotations

from .counting import CountingEngine
from .crowd import CrowdEngine
from .intrusion import IntrusionEngine
from .loitering import LoiteringEngine

__all__ = ["CrowdEngine", "CountingEngine", "LoiteringEngine", "IntrusionEngine"]
