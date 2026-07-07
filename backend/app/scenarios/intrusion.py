"""Intrusion scenario — alert the instant someone enters a restricted zone.

Edge-triggered: fires ``intrusion`` when a track's foot point crosses from outside
to inside ``zone``. To avoid spam when a person lingers at the zone EDGE (their foot
flickering in/out, or a brief detection miss), a track is only considered to have
truly LEFT — and thus re-armed for another alert — after it has stayed outside for a
sustained window. So a person who steps in, wanders near the boundary, and steps out
briefly won't re-trigger; only a genuine exit-and-return does. An empty zone disables
the engine.
"""

from __future__ import annotations

from .geometry import bbox_foot, point_in_poly

# A track must be continuously OUTSIDE this long before it re-arms (absorbs flapping).
REARM_QUIET_SECONDS = 15.0
_STALE_SECONDS = 60.0


class IntrusionEngine:
    """Per-camera zone-entry watcher with edge re-arm hysteresis. Rebuilt on config change."""

    def __init__(self, cfg: dict | None):
        cfg = cfg or {}
        self.enabled = bool(cfg.get("enabled"))
        self.zone = cfg.get("zone") or []          # empty => disabled
        self._armed_inside: dict[int, bool] = {}   # tid -> currently counts as "inside"
        self._out_since: dict[int, float] = {}     # tid -> when it first went outside
        self._seen: dict[int, float] = {}          # tid -> last-seen wall time

    def update(self, tracks, w: int, h: int, now: float) -> list[dict]:
        if not self.enabled or not self.zone:
            return []
        triggers: list[dict] = []
        for tid, bbox in tracks:
            self._seen[tid] = now
            fx, fy = bbox_foot(bbox)
            inside = point_in_poly(fx / max(w, 1), fy / max(h, 1), self.zone)
            if inside:
                self._out_since.pop(tid, None)
                if not self._armed_inside.get(tid, False):
                    self._armed_inside[tid] = True          # entry edge → alert once
                    triggers.append({
                        "event_type": "intrusion",
                        "track_id": tid,
                        "title": f"Intrusion #{tid}",
                        "severity": "warning",
                    })
            else:
                # Only commit "outside" (and re-arm) after a sustained absence.
                if tid not in self._out_since:
                    self._out_since[tid] = now
                if now - self._out_since[tid] >= REARM_QUIET_SECONDS:
                    self._armed_inside[tid] = False

        # Forget tracks not seen recently so state can't grow unbounded.
        cutoff = now - _STALE_SECONDS
        for t in [t for t, ts in self._seen.items() if ts < cutoff]:
            self._seen.pop(t, None)
            self._armed_inside.pop(t, None)
            self._out_since.pop(t, None)
        return triggers
