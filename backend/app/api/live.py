"""People-analytics live feed — recent events + per-frame overlays for the wall.

Matches vizor_nvr's polling model: the Live page polls ``GET /people/live`` for
the newest events and ``GET /people/live/overlays`` for the current person boxes
+ counts (the worker publishes both; see :mod:`app.overlay` and
:mod:`app.events`). ``/streams`` republishes each camera's RTSP through MediaMTX
so the browser plays HLS/WebRTC without ever touching the camera. Gated by
``people.event.read``.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from edge.auth.deps import require_permission
from edge.auth.security import decode_token
from edge.core.errors import ForbiddenError, NotFoundError, UnauthorizedError
from edge.core.logging import get_logger
from edge.core.storage import get_storage
from edge.db.base import get_db, get_sessionmaker
from edge.stream.mediamtx import MediaMTXClient, MediaMTXError

from .. import overlay
from ..domain.models import AnalyticsEvent, Camera
from ..domain.permissions import PaPerm

log = get_logger("people.live")

router = APIRouter(prefix="/people/live", tags=["people-live"])


async def _authenticate_token(token: str):
    """Authenticate a streaming caller from a ``?token=<access>`` query param.

    An MJPEG ``<img>`` can't set an Authorization header, so the browser passes the
    same short-lived access token as a query param (mirrors edge.core.ws_auth).
    Enforces the same ``people.event.read`` permission as the polling feed.
    """
    from edge.auth.models import User

    if not token:
        raise UnauthorizedError("missing token")
    try:
        payload = decode_token(token)
    except jwt.PyJWTError as exc:
        raise UnauthorizedError("invalid or expired token") from exc
    if payload.get("type") != "access":
        raise UnauthorizedError("not an access token")
    try:
        user_id = uuid.UUID(str(payload.get("sub")))
    except (TypeError, ValueError) as exc:
        raise UnauthorizedError("malformed token") from exc
    async with get_sessionmaker()() as db:  # short-lived — not held during streaming
        user = await db.get(User, user_id)
        if user is None or not user.is_active:
            raise UnauthorizedError("user not found or inactive")
        if not user.role.grants(PaPerm.EVENT_READ):
            raise ForbiddenError(f"missing permission: {PaPerm.EVENT_READ}")
    return user


_MJPEG_BOUNDARY = "paframe"


@router.get("/annotated/{camera_id}")
async def annotated_stream(
    camera_id: uuid.UUID,
    request: Request,
    token: str = Query(...),
) -> StreamingResponse:
    """MJPEG stream of one camera with person boxes burned into the frame (1-up view).

    The worker draws the boxes into the SAME frame it analysed, so they are perfectly
    synced with the video — no cross-pipeline lag. The worker only produces these
    frames while this endpoint keeps the per-camera "want" flag alive (refreshed each
    loop), so a camera nobody is watching costs zero encode. Auth via ``?token=``.
    """
    await _authenticate_token(token)
    cid = str(camera_id)

    async def _gen():
        last: bytes | None = None
        # Prime the want-flag immediately so the worker starts annotating.
        await run_in_threadpool(overlay.request_annotated, cid)
        while True:
            if await request.is_disconnected():
                break
            await run_in_threadpool(overlay.request_annotated, cid)   # keep-alive
            jpeg = await run_in_threadpool(overlay.get_annotated, cid)
            if jpeg and jpeg != last:                                 # only new frames
                last = jpeg
                yield (
                    b"--" + _MJPEG_BOUNDARY.encode() + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
                    + jpeg + b"\r\n"
                )
            await asyncio.sleep(0.08)   # poll ~12/s; frames arrive at analyze-fps

    return StreamingResponse(
        _gen(),
        media_type=f"multipart/x-mixed-replace; boundary={_MJPEG_BOUNDARY}",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.get("")
async def live_feed(
    camera_id: uuid.UUID | None = None,
    limit: int = Query(30, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _=Depends(require_permission(PaPerm.EVENT_READ)),
) -> dict:
    """Newest analytics events (last 10 minutes), optionally scoped to a camera."""
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)
    stmt = select(AnalyticsEvent).where(AnalyticsEvent.triggered_at >= since)
    if camera_id:
        stmt = stmt.where(AnalyticsEvent.camera_id == camera_id)
    rows = (
        await db.execute(stmt.order_by(AnalyticsEvent.triggered_at.desc()).limit(limit))
    ).scalars().all()
    storage = get_storage()
    items = []
    for e in rows:
        items.append({
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
        })
    return {"items": items}


@router.get("/overlays")
async def live_overlays(
    camera_id: list[uuid.UUID] | None = Query(None),
    _=Depends(require_permission(PaPerm.EVENT_READ)),
) -> dict:
    """Current per-frame person boxes + counts for the wall, keyed by camera id.

    Reads the short-lived Redis overlay keys the worker publishes each analysed
    frame (see :mod:`app.overlay`). Returns
    ``{camera_id: {"boxes": ..., "count": ..., "ts": ..., "extra": ...}}`` for the
    cameras that currently have a live overlay; optionally scoped to ``camera_id``.
    The Redis read is sync, so it runs off the event loop.
    """
    ids = [str(c) for c in camera_id] if camera_id else None
    return await run_in_threadpool(overlay.read_overlays, ids)


# =============================================================================
# Live video streams — register a camera's RTSP under MediaMTX and hand the
# browser back HLS / WebRTC republish URLs for the VMS wall. MediaMTX pulls the
# camera on demand and re-publishes it on host-published ports (browser-reachable
# via ``mediamtx_public_host``), so the Live wall never touches the camera RTSP.
# =============================================================================

def _stream_urls_for(camera: Camera) -> dict:
    """Ensure a MediaMTX path for ``camera`` and return its playback URLs.

    Registers (idempotently — ``add_path`` replaces) a path ``cam-<id>`` that
    pulls the camera RTSP, then derives browser-reachable HLS + WebRTC URLs.
    Raises :class:`MediaMTXError` on any control-plane failure (caller maps it
    to a 502).
    """
    name = f"cam-{camera.id}"
    client = MediaMTXClient()
    try:
        try:
            client.add_path(name, camera.rtsp_url)
        except MediaMTXError as exc:
            # add_path isn't idempotent — MediaMTX 400s if the path is already
            # registered. That's the happy path for a re-mount: the stream is live,
            # so treat "already exists" as success and just hand back the URLs.
            if "already exists" not in str(exc):
                raise
            log.debug("MediaMTX path %s already registered — reusing", name)
        return {
            "name": name,
            "hls": client.read_url(name, "hls"),
            "webrtc": client.read_url(name, "webrtc"),
        }
    finally:
        client.close()


@router.post("/streams/{camera_id}")
async def register_stream(
    camera_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_permission(PaPerm.EVENT_READ)),
) -> dict:
    """Register (or refresh) the live MediaMTX stream for one camera and return its URLs.

    Looks up the camera, republishes its RTSP under ``cam-<id>`` in MediaMTX, and
    returns ``{name, hls, webrtc}`` — the HLS playlist the wall's ``hls.js`` player
    loads and the WebRTC/WHEP page. Idempotent (safe to call on every tile mount).
    Returns 404 for an unknown camera, 502 if MediaMTX rejects the path.
    """
    camera = await db.get(Camera, camera_id)
    if camera is None:
        raise NotFoundError(f"camera {camera_id} not found")
    try:
        # _stream_urls_for makes blocking sync HTTP calls to MediaMTX — run it off the
        # event loop so it doesn't stall other requests.
        return await run_in_threadpool(_stream_urls_for, camera)
    except MediaMTXError as exc:
        log.error("MediaMTX register failed for camera %s: %s", camera_id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/streams")
async def list_streams(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_permission(PaPerm.EVENT_READ)),
) -> dict:
    """Ensure + return live-stream URLs for every enabled camera (bulk wall bootstrap).

    Registers each enabled camera's MediaMTX path and returns a list of
    ``{camera_id, name, hls, webrtc}``. A camera whose registration fails is
    reported with ``error`` set instead of URLs, so one bad RTSP never fails the
    whole wall.
    """
    rows = (
        await db.execute(select(Camera).where(Camera.enabled.is_(True)).order_by(Camera.name))
    ).scalars().all()
    items = []
    for c in rows:
        entry = {"camera_id": str(c.id)}
        try:
            # Blocking sync MediaMTX HTTP calls — keep them off the event loop.
            entry.update(await run_in_threadpool(_stream_urls_for, c))
        except MediaMTXError as exc:
            entry["error"] = str(exc)
            log.warning("MediaMTX register failed for camera %s: %s", c.id, exc)
        items.append(entry)
    return {"items": items}
