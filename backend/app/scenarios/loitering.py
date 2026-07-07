"""Loitering scenario — alert when someone dwells in a zone too long.

Records the first time each track's foot point is seen inside ``zone`` and, once a
track has been in the zone for ``threshold_seconds``, emits ONE ``loitering`` event
(then latches so it doesn't re-fire for the same stay). To avoid spam / a reset-loop
when a person hovers at the zone EDGE (foot flickering out, or a brief detection
miss), a short exit does NOT reset the dwell timer — the timer only resets, and the
alert re-arms, after the track has stayed OUTSIDE for a sustained window. An empty
zone disables the engine (a whole-frame loitering rule would be meaningless).
"""

from __future__ import annotations

from .geometry import bbox_foot, point_in_poly

# A track must be continuously OUTSIDE this long before its dwell resets / re-arms.
REARM_QUIET_SECONDS = 10.0
_STALE_SECONDS = 60.0


class LoiteringEngine:
    """Per-camera dwell-time watcher with edge hysteresis. Rebuilt on config change."""

    def __init__(self, cfg: dict | None):
        cfg = cfg or {}
        self.enabled = bool(cfg.get("enabled"))
        self.zone = cfg.get("zone") or []   # empty => disabled
        self.threshold_seconds = float(cfg.get("threshold_seconds", 30) or 30)
        self._first_seen: dict[int, float] = {}  # tid -> first-in-zone wall time
        self._alerted: set[int] = set()           # tids already alerted this stay
        self._out_since: dict[int, float] = {}    # tid -> when it went outside
        self._seen: dict[int, float] = {}         # tid -> last-seen wall time

    def update(self, tracks, w: int, h: int, now: float) -> list[dict]:
        if not self.enabled or not self.zone:
            return []
        triggers: list[dict] = []
        for tid, bbox in tracks:
            self._seen[tid] = now
            fx, fy = bbox_foot(bbox)
            inside = point_in_poly(fx / max(w, 1), fy / max(h, 1), self.zone)
            if not inside:
                # Brief exits are ignored; only a SUSTAINED absence resets the dwell.
                if tid not in self._out_since:
                    self._out_since[tid] = now
                if now - self._out_since[tid] >= REARM_QUIET_SECONDS:
                    self._first_seen.pop(tid, None)
                    self._alerted.discard(tid)
                continue
            self._out_since.pop(tid, None)   # back inside — cancel any pending reset
            first = self._first_seen.get(tid)
            if first is None:
                self._first_seen[tid] = now
                continue
            dwell = now - first
            if dwell >= self.threshold_seconds and tid not in self._alerted:
                self._alerted.add(tid)
                triggers.append({
                    "event_type": "loitering",
                    "track_id": tid,
                    "title": f"Loitering #{tid} ({int(dwell)}s)",
                    "attributes": {"dwell_seconds": round(dwell, 1)},
                })
        # Forget tracks not seen recently (vanished while inside, id recycled, ...).
        cutoff = now - _STALE_SECONDS
        for t in [t for t, ts in self._seen.items() if ts < cutoff]:
            self._seen.pop(t, None)
            self._first_seen.pop(t, None)
            self._out_since.pop(t, None)
            self._alerted.discard(t)
        return triggers
