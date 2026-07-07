"""Shared router factory for the per-scenario LICENSE-GATED feature modules.

Each people-analytics scenario (crowd / counting / loitering / intrusion) is its own
feature module: the edge registry mounts its router at ``/api/modules/<id>`` ONLY
when the client's license grants that module. All four read the same ``pa_events``
table, differing only by ``event_type`` (+ whether they're a directional in/out
counter), so they share this factory — a module is then a two-line ``ModuleSpec``.
"""

from __future__ import annotations

import datetime as dt
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from edge.auth.deps import require_permission
from edge.core.audit import record as audit_record
from edge.core.errors import NotFoundError
from edge.core.storage import get_storage

from ..domain.models import AnalyticsEvent, Camera
from ..domain.permissions import PaPerm


async def _serialize(e, storage) -> dict:
    return {
        "id": str(e.id),
        "event_type": e.event_type,
        "camera_id": str(e.camera_id) if e.camera_id else None,
        "camera_name": e.camera_name,
        "count": e.count,
        "track_id": e.track_id,
        "zone_name": e.zone_name,
        "severity": e.severity,
        "title": e.title,
        "bbox": e.bbox or [],
        "snapshot_url": await storage.url(e.snapshot_key) if e.snapshot_key else None,
        "attributes": e.attributes or {},
        "triggered_at": e.triggered_at.isoformat() if e.triggered_at else None,
    }


def scenario_router(*, event_type: str, directional: bool = False) -> APIRouter:
    """Build the events + summary router for one scenario (mounted at /api/modules/<id>)."""
    from edge.db.base import get_db

    router = APIRouter()

    @router.get("/events")
    async def list_events(
        camera_id: uuid.UUID | None = None,
        since: dt.datetime | None = None,
        until: dt.datetime | None = None,
        limit: int = Query(50, ge=1, le=200),
        offset: int = Query(0, ge=0),
        db: AsyncSession = Depends(get_db),
        _=Depends(require_permission(PaPerm.EVENT_READ)),
    ) -> dict:
        stmt = select(AnalyticsEvent).where(AnalyticsEvent.event_type == event_type)
        if camera_id:
            stmt = stmt.where(AnalyticsEvent.camera_id == camera_id)
        if since:
            stmt = stmt.where(AnalyticsEvent.triggered_at >= since)
        if until:
            stmt = stmt.where(AnalyticsEvent.triggered_at <= until)
        total = int(await db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
        rows = (
            await db.execute(stmt.order_by(AnalyticsEvent.triggered_at.desc()).limit(limit).offset(offset))
        ).scalars().all()
        storage = get_storage()
        return {"items": [await _serialize(e, storage) for e in rows], "total": total}

    @router.get("/events/{event_id}")
    async def get_event(
        event_id: uuid.UUID,
        db: AsyncSession = Depends(get_db),
        _=Depends(require_permission(PaPerm.EVENT_READ)),
    ) -> dict:
        e = await db.get(AnalyticsEvent, event_id)
        if e is None or e.event_type != event_type:
            raise NotFoundError("event not found")
        return await _serialize(e, get_storage())

    @router.delete("/events/{event_id}", status_code=204)
    async def delete_event(
        event_id: uuid.UUID,
        db: AsyncSession = Depends(get_db),
        actor=Depends(require_permission(PaPerm.EVENT_MANAGE)),
    ) -> None:
        e = await db.get(AnalyticsEvent, event_id)
        if e is None or e.event_type != event_type:
            raise NotFoundError("event not found")
        if e.snapshot_key:
            try:
                await get_storage().delete(e.snapshot_key)
            except Exception:  # noqa: BLE001 — best-effort snapshot purge
                pass
        await db.delete(e)
        await db.commit()
        await audit_record(
            db, actor=actor, action=f"people.{event_type}.delete",
            target_type="people_event", target_id=str(event_id), meta={},
        )

    @router.post("/events/bulk-delete", status_code=204)
    async def bulk_delete(
        payload: dict,
        db: AsyncSession = Depends(get_db),
        actor=Depends(require_permission(PaPerm.EVENT_MANAGE)),
    ) -> None:
        """Delete many events of THIS scenario at once. Body: ``{"ids": [uuid, ...]}``."""
        raw = payload.get("ids") or []
        ids: list[uuid.UUID] = []
        for r in raw:
            try:
                ids.append(uuid.UUID(str(r)))
            except (TypeError, ValueError):
                continue
        if not ids:
            return
        rows = (
            await db.execute(
                select(AnalyticsEvent).where(
                    AnalyticsEvent.id.in_(ids),
                    AnalyticsEvent.event_type == event_type,  # never touch other scenarios' rows
                )
            )
        ).scalars().all()
        storage = get_storage()
        for e in rows:
            if e.snapshot_key:
                try:
                    await storage.delete(e.snapshot_key)
                except Exception:  # noqa: BLE001 — best-effort snapshot purge
                    pass
            await db.delete(e)
        await db.commit()
        await audit_record(
            db, actor=actor, action=f"people.{event_type}.bulk_delete",
            target_type="people_event", target_id="", meta={"count": len(rows)},
        )

    @router.get("/summary")
    async def summary(
        since_hours: int = Query(24, ge=1, le=720),
        db: AsyncSession = Depends(get_db),
        _=Depends(require_permission(PaPerm.EVENT_READ)),
    ) -> dict:
        """This scenario's rollup: per-camera event count (+ in/out/net when directional)."""
        since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=since_hours)
        cams = (await db.execute(select(Camera).order_by(Camera.name))).scalars().all()
        per: dict[str, dict] = {}
        for c in cams:
            row = {"camera_id": str(c.id), "camera_name": c.name, "count": 0}
            if directional:
                row.update({"in_count": 0, "out_count": 0, "net": 0})
            per[str(c.id)] = row
        rows = (
            await db.execute(
                select(AnalyticsEvent.camera_id, AnalyticsEvent.attributes).where(
                    AnalyticsEvent.event_type == event_type,
                    AnalyticsEvent.triggered_at >= since,
                )
            )
        ).all()
        for cid, attrs in rows:
            c = per.get(str(cid))
            if not c:
                continue
            c["count"] += 1
            if directional:
                d = (attrs or {}).get("direction")
                if d == "in":
                    c["in_count"] += 1
                elif d == "out":
                    c["out_count"] += 1
        if directional:
            for c in per.values():
                c["net"] = c["in_count"] - c["out_count"]
        cameras = list(per.values())
        totals = {"count": sum(c["count"] for c in cameras)}
        if directional:
            totals.update({
                "in": sum(c["in_count"] for c in cameras),
                "out": sum(c["out_count"] for c in cameras),
                "net": sum(c["net"] for c in cameras),
            })
        return {"event_type": event_type, "directional": directional,
                "since_hours": since_hours, "totals": totals, "cameras": cameras}

    @router.get("/timeseries")
    async def timeseries(
        since_hours: int = Query(24, ge=1, le=720),
        camera_id: uuid.UUID | None = None,
        db: AsyncSession = Depends(get_db),
        _=Depends(require_permission(PaPerm.EVENT_READ)),
    ) -> dict:
        """Time-bucketed counts for charting (hourly ≤48h, else daily).

        For directional scenarios each bucket carries ``in``/``out``/``net`` and a
        running cumulative occupancy; otherwise just ``count``. Optionally scoped to
        one camera. This is what the People-Counting page plots instead of a raw log.
        """
        now = dt.datetime.now(dt.timezone.utc)
        since = now - dt.timedelta(hours=since_hours)
        bucket_h = 1 if since_hours <= 48 else 24
        nb = max(1, -(-since_hours // bucket_h))  # ceil
        buckets = [
            {"start": (since + dt.timedelta(hours=i * bucket_h)).isoformat(),
             "in": 0, "out": 0, "count": 0}
            for i in range(nb)
        ]
        stmt = select(AnalyticsEvent.attributes, AnalyticsEvent.triggered_at).where(
            AnalyticsEvent.event_type == event_type,
            AnalyticsEvent.triggered_at >= since,
        )
        if camera_id:
            stmt = stmt.where(AnalyticsEvent.camera_id == camera_id)
        rows = (await db.execute(stmt)).all()
        for attrs, ts in rows:
            if ts is None:
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=dt.timezone.utc)
            idx = int((ts - since).total_seconds() // (bucket_h * 3600))
            idx = min(max(idx, 0), nb - 1)
            b = buckets[idx]
            b["count"] += 1
            if directional:
                d = (attrs or {}).get("direction")
                if d == "in":
                    b["in"] += 1
                elif d == "out":
                    b["out"] += 1
        # Running cumulative occupancy (net people inside) across the window.
        if directional:
            occ = 0
            for b in buckets:
                b["net"] = b["in"] - b["out"]
                occ += b["net"]
                b["occupancy"] = occ
        return {"event_type": event_type, "directional": directional,
                "since_hours": since_hours, "bucket_hours": bucket_h, "buckets": buckets}

    return router
