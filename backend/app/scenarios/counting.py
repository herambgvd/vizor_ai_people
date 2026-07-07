"""Line-crossing scenario — directional in/out people counting.

Tracks which side of the counting line each person's foot point is on; when a track
flips side between frames it has crossed the line, and we emit one ``line_crossing``
event tagged with an in/out direction (chosen by the sign of the new side). Per-track
side state is kept and stale tracks are forgotten so ids that never return don't leak.
"""

from __future__ import annotations

from .geometry import bbox_foot, seg_side

# Drop a track's remembered side this long after it was last seen (id recycling /
# person left frame). Generous so a brief occlusion doesn't reset the crossing state.
_STALE_SECONDS = 30.0


class CountingEngine:
    """Per-camera directional line counter. Rebuilt when config changes."""

    def __init__(self, cfg: dict | None):
        cfg = cfg or {}
        self.enabled = bool(cfg.get("enabled"))
        # [[x1, y1], [x2, y2]] normalised; a < 2-point line disables the engine.
        self.line = cfg.get("line") or []
        self._side: dict[int, int] = {}   # tid -> last non-zero side (+1 / -1)
        self._seen: dict[int, float] = {}  # tid -> last-seen wall time

    def update(self, tracks, w: int, h: int, now: float) -> list[dict]:
        if not self.enabled or len(self.line) < 2:
            return []
        a, b = self.line[0], self.line[1]
        triggers: list[dict] = []
        for tid, bbox in tracks:
            fx, fy = bbox_foot(bbox)
            p = (fx / max(w, 1), fy / max(h, 1))
            self._seen[tid] = now
            side = seg_side(p, a, b)
            if side == 0:                     # exactly on the line — wait for a decision
                continue
            prev = self._side.get(tid)
            self._side[tid] = side
            if prev is not None and side != prev:
                direction = "in" if side > 0 else "out"
                triggers.append({
                    "event_type": "line_crossing",
                    "track_id": tid,
                    "title": f"Line crossing #{tid} ({direction})",
                    "attributes": {"direction": direction},
                })
        # Forget tracks not seen recently so per-tid state can't grow unbounded.
        cutoff = now - _STALE_SECONDS
        for t in [t for t, ts in self._seen.items() if ts < cutoff]:
            self._seen.pop(t, None)
            self._side.pop(t, None)
        return triggers
