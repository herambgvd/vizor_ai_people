"""People Analytics domain ORM models.

Person-centric analytics (crowd counting, in/out counting, loitering, intrusion)
over a shared YOLO26 person detector + ByteTrack. Cameras reuse the proven FRS
stream plumbing (NVDEC/scale_cuda decode, offline watchdog, per-camera restart);
face-specific fields are dropped in favour of a per-camera ``scenarios`` config.
All portable SQLAlchemy types so the same models run on Postgres and SQLite.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from edge.db.base import Base


# Default per-camera scenario config. Each scenario is independently toggled and
# carries its own zone/line (normalised 0..1 coords) + threshold. Stored as one
# JSON blob on the camera so new scenarios extend it without a schema change.
DEFAULT_SCENARIOS: dict = {
    # Count people inside `zone` (empty = whole frame); event when count >= threshold.
    "crowd": {"enabled": False, "zone": [], "threshold": 10},
    # Directional line crossing for in/out tallies. `line` = [[x1,y1],[x2,y2]].
    "counting": {"enabled": False, "line": []},
    # Person dwelling in `zone` longer than threshold_seconds → event.
    "loitering": {"enabled": False, "zone": [], "threshold_seconds": 30},
    # Any person entering `zone` → event.
    "intrusion": {"enabled": False, "zone": []},
}


class Camera(Base):
    """An RTSP camera analysed by the people-analytics worker.

    Stream columns (fps / hw_accel / analyze_width / status) are ported verbatim
    from FRS so the shared RTSPReader + supervisor behave identically. Analytics is
    driven entirely by ``analytics_enabled`` + the per-scenario ``scenarios`` blob.
    """

    __tablename__ = "pa_cameras"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    rtsp_url: Mapped[str] = mapped_column(String, nullable=False)
    location: Mapped[str | None] = mapped_column(String, nullable=True)
    zone: Mapped[str | None] = mapped_column(String, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Master analytics toggle — when off the worker doesn't run (and the Live wall
    # shows a "scenario off" tile), mirroring FRS's recognition_enabled.
    analytics_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Person detector tuning.
    person_conf: Mapped[float] = mapped_column(Float, nullable=False, default=0.4)
    min_box_px: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Minimum gap between repeat events of the same kind on this camera.
    alert_suppress_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=30)

    # Per-scenario config (crowd / counting / loitering / intrusion). See DEFAULT_SCENARIOS.
    scenarios: Mapped[dict] = mapped_column(JSON, nullable=False, default=lambda: dict(DEFAULT_SCENARIOS))

    # Stream (ported from FRS — NVDEC + GPU downscale support).
    fps: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    hw_accel: Mapped[str] = mapped_column(String, nullable=False, default="none")
    analyze_width: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Health (maintained by the supervisor's offline watchdog).
    status: Mapped[str] = mapped_column(String, nullable=False, default="offline", index=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(String, nullable=True)
    snapshot_key: Mapped[str | None] = mapped_column(String, nullable=True)
    attributes: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AnalyticsEvent(Base):
    """An event raised by any people-analytics scenario.

    One row per alert: crowd threshold breach, line crossing (in/out), loitering,
    or intrusion. The scenario-specific payload lives in ``attributes`` (e.g. count,
    direction, dwell_seconds) so all four scenarios share one uniform table + UI.
    """

    __tablename__ = "pa_events"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    camera_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    camera_name: Mapped[str | None] = mapped_column(String, nullable=True)
    # crowd_threshold | line_crossing | loitering | intrusion
    event_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    severity: Mapped[str] = mapped_column(String, nullable=False, default="info")
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    # People count at trigger time (crowd/occupancy); None for single-person events.
    count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    track_id: Mapped[str | None] = mapped_column(String, nullable=True)
    zone_name: Mapped[str | None] = mapped_column(String, nullable=True)
    bbox: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    snapshot_key: Mapped[str | None] = mapped_column(String, nullable=True)
    attributes: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    triggered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
