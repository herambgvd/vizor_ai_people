"""People-analytics events log — list / filter / detail / delete.

Reads the shared ``pa_events`` substrate written by the live worker (crowd /
counting / loitering / intrusion engines; see :mod:`app.events`). A slim,
face-free port of the FRS events API: no feedback / verdict logic. Deleting an
event also purges its snapshot from storage.
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
from edge.core.logging import get_logger
from edge.core.storage import get_storage
from edge.db.base import get_db

from ..domain.models import AnalyticsEvent
from ..domain.permissions import PaPerm

log = get_logger("people.events")

router = APIRouter(prefix="/people/events", tags=["people-events"])


async def _serialize(e: AnalyticsEvent, storage) -> dict:
    """Project one event to the wire shape shared with the live feed."""
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


def _apply_filters(stmt, *, camera_id, event_type, since, until):
    if camera_id:
        stmt = stmt.where(AnalyticsEvent.camera_id == camera_id)
    if event_type:
        stmt = stmt.where(AnalyticsEvent.event_type == event_type)
    if since:
        stmt = stmt.where(AnalyticsEvent.triggered_at >= since)
    if until:
        stmt = stmt.where(AnalyticsEvent.triggered_at <= until)
    return stmt


@router.get("")
async def list_events(
    event_type: str | None = None,
    camera_id: uuid.UUID | None = None,
    since: dt.datetime | None = None,
    until: dt.datetime | None = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _=Depends(require_permission(PaPerm.EVENT_READ)),
) -> dict:
    """Paginated, filterable event log (newest first) → ``{items, total}``."""
    base = _apply_filters(
        select(AnalyticsEvent), camera_id=camera_id, event_type=event_type, since=since, until=until
    )
    total = int(await db.scalar(select(func.count()).select_from(base.subquery())) or 0)
    rows = (
        await db.execute(base.order_by(AnalyticsEvent.triggered_at.desc()).limit(limit).offset(offset))
    ).scalars().all()
    storage = get_storage()
    items = [await _serialize(e, storage) for e in rows]
    return {"items": items, "total": total}


@router.get("/{event_id}")
async def get_event(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_permission(PaPerm.EVENT_READ)),
) -> dict:
    """Single event detail (with a resolved snapshot URL)."""
    e = await db.get(AnalyticsEvent, event_id)
    if e is None:
        raise NotFoundError("event not found")
    return await _serialize(e, get_storage())


@router.delete("/{event_id}", status_code=204)
async def delete_event(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor=Depends(require_permission(PaPerm.EVENT_MANAGE)),
) -> None:
    """Delete an event and best-effort purge its snapshot from storage."""
    e = await db.get(AnalyticsEvent, event_id)
    if e is None:
        raise NotFoundError("event not found")
    if e.snapshot_key:
        try:
            await get_storage().delete(e.snapshot_key)
        except Exception as exc:  # noqa: BLE001 — orphaned blob is harmless
            log.warning("snapshot delete failed event=%s err=%s", e.id, exc)
    await db.delete(e)
    await db.commit()
    await audit_record(
        db, actor=actor, action="people.event.delete", target_type="people_event",
        target_id=str(event_id), meta={},
    )
