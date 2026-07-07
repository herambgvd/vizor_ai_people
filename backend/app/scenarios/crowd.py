"""Crowd-density scenario — alert when too many people occupy a zone.

Counts the tracks whose foot point falls inside ``zone`` (empty zone = whole frame)
and alerts ONCE when a crowd forms. It then stays quiet while the crowd persists —
and, crucially, does NOT re-alert on brief count dips (a person momentarily occluded
or missed). It only re-arms after the count has stayed BELOW the threshold for a
sustained "clear" window, so a lingering crowd can't spam an alert every few seconds.
You're told when a crowd forms, and again only if it genuinely disperses and reforms.
"""

from __future__ import annotations

from .geometry import bbox_foot, point_in_poly

# How long the count must stay below the threshold before we consider the crowd
# cleared and re-arm the alert. Absorbs flapping (3↔2 people as they move/occlude).
REARM_QUIET_SECONDS = 30.0


class CrowdEngine:
    """Rising-edge occupancy alerter with sustained-clear hysteresis. Per camera."""

    def __init__(self, cfg: dict | None):
        cfg = cfg or {}
        self.enabled = bool(cfg.get("enabled"))
        self.zone = cfg.get("zone") or []              # empty => whole frame
        self.threshold = int(cfg.get("threshold", 10) or 10)
        self._breached = False        # a crowd is currently alerted → stay quiet
        self._below_since: float | None = None  # when the count first went below threshold

    def update(self, tracks, w: int, h: int, now: float) -> list[dict]:
        if not self.enabled:
            return []
        count = 0
        for _tid, bbox in tracks:
            fx, fy = bbox_foot(bbox)
            if not self.zone or point_in_poly(fx / max(w, 1), fy / max(h, 1), self.zone):
                count += 1

        if count >= self.threshold:
            self._below_since = None          # still crowded — reset the clear timer
            if self._breached:
                return []                     # already alerted for this crowd
            self._breached = True             # rising edge → alert once
            return [{
                "event_type": "crowd_threshold",
                "count": count,
                "zone_name": "crowd",
                "title": f"Crowd: {count} people",
                "severity": "warning",
                "attributes": {"threshold": self.threshold},
            }]

        # Below threshold. Only re-arm once it has stayed below for the clear window,
        # so a brief dip (occlusion / missed detection) doesn't re-trigger the alert.
        if self._below_since is None:
            self._below_since = now
        if self._breached and (now - self._below_since) >= REARM_QUIET_SECONDS:
            self._breached = False
        return []
