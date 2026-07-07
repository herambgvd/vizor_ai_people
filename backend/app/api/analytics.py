"""People Analytics summary / aggregation API — powers the Dashboard.

Rolls the raw ``pa_events`` up into the numbers a people-analytics operator actually
wants: live headcount (current occupancy, from the live overlay bus), directional
in/out tallies + net occupancy (from ``line_crossing`` events), and per-scenario
event counts — per camera and in total, over a time window.
"""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from edge.auth.deps import require_permission
from edge.db.base import get_db

from ..domain.models import AnalyticsEvent, Camera
from ..domain.permissions import PaPerm
from . import live as live_api

router = APIRouter(prefix="/people/analytics", tags=["people-analytics"])

_EVENT_TYPES = ["crowd_threshold", "line_crossing", "loitering", "intrusion"]


@router.get("/summary")
async def summary(
    since_hours: int = Query(24, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
    _=Depends(require_permission(PaPerm.EVENT_READ)),
) -> dict:
    """Dashboard rollup over the last ``since_hours``.

    Returns live occupancy (now), in/out/net line-counting tallies, and per-scenario
    event counts — broken down per camera and summed across all cameras.
    """
    from fastapi.concurrency import run_in_threadpool

    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=since_hours)

    cams = (await db.execute(select(Camera).order_by(Camera.name))).scalars().all()
    name_by_id = {str(c.id): c.name for c in cams}

    # Per-camera, per-type event counts.
    rows = (
        await db.execute(
            select(AnalyticsEvent.camera_id, AnalyticsEvent.event_type, func.count())
            .where(AnalyticsEvent.triggered_at >= since)
            .group_by(AnalyticsEvent.camera_id, AnalyticsEvent.event_type)
        )
    ).all()

    # Directional in/out from line_crossing attributes.direction — counted in Python
    # (portable across JSON/JSONB, and line-crossing rows are low-volume).
    lc_rows = (
        await db.execute(
            select(AnalyticsEvent.camera_id, AnalyticsEvent.attributes)
            .where(
                AnalyticsEvent.triggered_at >= since,
                AnalyticsEvent.event_type == "line_crossing",
            )
        )
    ).all()

    # Live occupancy right now (per camera) from the overlay bus.
    overlays = await run_in_threadpool(live_api.overlay.read_overlays)

    per_cam: dict[str, dict] = {}
    for cid, name in name_by_id.items():
        per_cam[cid] = {
            "camera_id": cid, "camera_name": name,
            "in_count": 0, "out_count": 0, "net": 0,
            "live_count": int((overlays.get(cid) or {}).get("count", 0) or 0),
            "events": {t: 0 for t in _EVENT_TYPES},
        }
    for cid, etype, n in rows:
        c = per_cam.get(str(cid))
        if c is not None and etype in c["events"]:
            c["events"][etype] = int(n)
    for cid, attrs in lc_rows:
        c = per_cam.get(str(cid))
        if c is None:
            continue
        direction = (attrs or {}).get("direction")
        if direction == "in":
            c["in_count"] += 1
        elif direction == "out":
            c["out_count"] += 1
    for c in per_cam.values():
        c["net"] = c["in_count"] - c["out_count"]

    cameras = list(per_cam.values())
    totals = {
        "in": sum(c["in_count"] for c in cameras),
        "out": sum(c["out_count"] for c in cameras),
        "net": sum(c["net"] for c in cameras),
        "live": sum(c["live_count"] for c in cameras),
        "by_type": {t: sum(c["events"][t] for c in cameras) for t in _EVENT_TYPES},
    }
    return {
        "since": since.isoformat(),
        "since_hours": since_hours,
        "totals": totals,
        "cameras": cameras,
    }
