"""Shared analytics-event writer for the people-analytics scenarios.

The single path for recording an :class:`AnalyticsEvent` — used by the live
worker (crowd / counting / loitering / intrusion engines). Persists the row,
optionally stores a JPEG snapshot under the ``people/events/`` prefix, and raises
an in-app notification (the operator bell) for the loud alert types. Deliberately
much simpler than the FRS recorder: no faces, embeddings, attendance or transit.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from edge.core.logging import get_logger

from .domain.models import AnalyticsEvent

log = get_logger("people.events")


# Event types loud enough to interrupt an operator — these raise an in-app
# notification for every active user. Line-crossing (in/out tallies) is routine
# telemetry and stays quiet.
_ALERT_TYPES = {"intrusion", "loitering", "crowd_threshold"}


async def record_event(
    db: AsyncSession,
    *,
    event_type: str,
    camera_id=None,
    camera_name: str | None = None,
    count: int | None = None,
    track_id: str | None = None,
    zone_name: str | None = None,
    bbox: list | None = None,
    title: str | None = None,
    severity: str = "info",
    snapshot_bytes: bytes | None = None,
    attributes: dict | None = None,
    triggered_at: dt.datetime | None = None,
) -> AnalyticsEvent:
    """Persist one ``pa_events`` row and (for alert types) notify operators.

    ``event_type`` is one of ``crowd_threshold`` | ``line_crossing`` |
    ``loitering`` | ``intrusion``. When ``snapshot_bytes`` is given it is stored
    under ``people/events/{id}.jpg`` and the event's ``snapshot_key`` is set. For
    the loud alert types (intrusion / loitering / crowd_threshold) an in-app
    notification is raised to every active user. Storage and notification are both
    guarded — neither can fail the caller. Commits and returns the refreshed event.
    """
    attributes = dict(attributes or {})

    ev = AnalyticsEvent(
        id=uuid.uuid4(),
        event_type=event_type,
        severity=severity,
        title=title,
        camera_id=camera_id,
        camera_name=camera_name,
        count=count,
        track_id=track_id,
        zone_name=zone_name,
        bbox=bbox or [],
        attributes=attributes,
    )
    if triggered_at is not None:
        ev.triggered_at = triggered_at

    # Snapshot is optional and never load-bearing — a storage hiccup must not lose
    # the event itself, so the row still commits without a snapshot_key.
    if snapshot_bytes:
        try:
            from edge.core.storage import get_storage

            key = f"people/events/{ev.id.hex}.jpg"
            await get_storage().put(key, snapshot_bytes, "image/jpeg")
            ev.snapshot_key = key
        except Exception as exc:  # noqa: BLE001 — snapshot is best-effort
            log.warning("event snapshot store failed event=%s err=%s", ev.id, exc)

    db.add(ev)
    await db.commit()
    await db.refresh(ev)

    # Operator bell for the loud alert types. Best-effort — a notify failure never
    # propagates to the worker (the event is already durable at this point).
    if event_type in _ALERT_TYPES:
        try:
            from edge.auth.models import User
            from edge.messaging.dispatcher import notify

            uids = (await db.execute(select(User.id).where(User.is_active.is_(True)))).scalars().all()
            if uids:
                where = camera_name or "a camera"
                await notify(
                    db, user_ids=list(uids),
                    title=title or f"{event_type.replace('_', ' ').title()} alert",
                    body=f"{event_type.replace('_', ' ').title()} detected on {where}.",
                )
        except Exception as exc:  # noqa: BLE001 — never let a notify failure break the recorder
            log.warning("event notify failed event=%s err=%s", ev.id, exc)

    return ev
