"""Cross-process live overlay bus (worker → backend) over Redis.

The people-analytics worker runs in a *separate process* from the FastAPI
backend, so the edge in-memory event bus can't carry per-frame overlay data
across that boundary. Instead the worker publishes the latest analysed frame's
person boxes + count to a short-lived Redis key, and the Live wall polls the
backend which reads those keys back.

Keys are ``pa:overlay:{camera_id}`` holding JSON
``{"boxes": [...], "count": int, "ts": epoch, "extra": {...}}`` with a ~5s TTL,
so a camera that stops being analysed simply drops off the wall on its own.

Both halves use the *sync* redis client (redis-py ships sync + async in the same
package): the worker runs in a plain thread/process, and the backend calls
:func:`read_overlays` via ``run_in_threadpool`` from its async endpoint.
"""

from __future__ import annotations

import json
import time

import redis

from edge.core.config import get_settings
from edge.core.logging import get_logger

log = get_logger("people.overlay")

# Key prefix + TTL. TTL is short so a stale key (worker died mid-stream) can never
# keep ghost boxes on the wall for more than a few seconds.
_KEY_PREFIX = "pa:overlay:"
_TTL_SECONDS = 5

# --- Annotated single-camera stream (Hybrid live boxes) --------------------------
# For the 1-up (single-camera) live view we burn the person boxes into the frame in
# the worker and serve that as an MJPEG stream — perfectly synced (same frame). To
# avoid encoding for cameras nobody is watching, the viewer sets a short-lived "want"
# flag; the worker only draws+encodes while that flag is live.
_WANT_PREFIX = "pa:annview:"      # viewer -> worker: "annotate this camera now"
_ANN_PREFIX = "pa:annotated:"     # worker -> viewer: latest annotated JPEG (binary)
_WANT_TTL = 8                     # viewer refreshes well within this
_ANN_TTL = 3                      # annotated frame is fresh for a few seconds

# Lazily-created module-level sync client, shared across calls. Redis clients are
# thread-safe (each command checks out a connection from an internal pool), so a
# single instance is fine for both the worker push and the threadpool read.
_client: "redis.Redis | None" = None


def _redis() -> "redis.Redis | None":
    """Return the shared sync Redis client, creating it on first use.

    Never raises — on any construction failure it logs and returns ``None`` so the
    caller degrades to a no-op (overlays are best-effort eye-candy, not data).
    """
    global _client
    if _client is None:
        try:
            _client = redis.Redis.from_url(get_settings().redis_url, decode_responses=True)
        except Exception as exc:  # noqa: BLE001 — overlays are best-effort
            log.warning("overlay redis client init failed: %s", exc)
            return None
    return _client


# Separate client WITHOUT decode_responses so annotated JPEG bytes round-trip raw.
_bin_client: "redis.Redis | None" = None


def _bin_redis() -> "redis.Redis | None":
    """Shared sync Redis client that returns raw ``bytes`` (for JPEG frames)."""
    global _bin_client
    if _bin_client is None:
        try:
            _bin_client = redis.Redis.from_url(get_settings().redis_url, decode_responses=False)
        except Exception as exc:  # noqa: BLE001
            log.warning("overlay binary redis client init failed: %s", exc)
            return None
    return _bin_client


# --- Annotated stream: viewer <-> worker handshake + frame transport -------------
def request_annotated(camera_id: str, ttl: int = _WANT_TTL) -> None:
    """Viewer side: signal the worker to annotate this camera for ``ttl`` seconds.
    Called repeatedly by the MJPEG endpoint so the flag stays live while watched."""
    c = _redis()
    if c is None:
        return
    try:
        c.set(f"{_WANT_PREFIX}{camera_id}", "1", ex=ttl)
    except Exception as exc:  # noqa: BLE001
        log.debug("request_annotated failed camera=%s err=%s", camera_id, exc)


def annotated_wanted(camera_id: str) -> bool:
    """Worker side: is anyone currently watching this camera in 1-up?"""
    c = _redis()
    if c is None:
        return False
    try:
        return bool(c.exists(f"{_WANT_PREFIX}{camera_id}"))
    except Exception:  # noqa: BLE001
        return False


def push_annotated(camera_id: str, jpeg: bytes, ttl: int = _ANN_TTL) -> None:
    """Worker side: publish the latest annotated (boxes-burned-in) JPEG frame."""
    c = _bin_redis()
    if c is None:
        return
    try:
        c.set(f"{_ANN_PREFIX}{camera_id}", jpeg, ex=ttl)
    except Exception as exc:  # noqa: BLE001
        log.debug("push_annotated failed camera=%s err=%s", camera_id, exc)


def get_annotated(camera_id: str) -> "bytes | None":
    """Viewer/backend side: latest annotated JPEG for ``camera_id`` (or None)."""
    c = _bin_redis()
    if c is None:
        return None
    try:
        return c.get(f"{_ANN_PREFIX}{camera_id}")
    except Exception:  # noqa: BLE001
        return None


def push_overlay(camera_id: str, boxes: list[dict], count: int, extra: dict | None = None) -> None:
    """Publish one analysed frame's overlay for ``camera_id`` (worker side).

    ``boxes`` is ``[{"bbox": [x1, y1, x2, y2], "tid": int, "label": str}, ...]`` in
    the pixel space of the frame the worker analysed. Stored as JSON at
    ``pa:overlay:{camera_id}`` with a ~5s TTL alongside the current people
    ``count`` and an optional ``extra`` blob (e.g. per-scenario in/out tallies).

    Best-effort: any Redis / serialization error is swallowed so a live-overlay
    hiccup can never stall or crash the analysis loop.
    """
    client = _redis()
    if client is None:
        return
    try:
        payload = json.dumps({
            "boxes": boxes,
            "count": count,
            "ts": time.time(),
            "extra": extra or {},
        })
        client.set(f"{_KEY_PREFIX}{camera_id}", payload, ex=_TTL_SECONDS)
    except Exception as exc:  # noqa: BLE001 — never break the worker for an overlay
        log.debug("overlay push failed camera=%s err=%s", camera_id, exc)


def read_overlays(camera_ids: list[str] | None = None) -> dict:
    """Read the current overlays (backend side). Sync — call via ``run_in_threadpool``.

    Returns ``{camera_id: {"boxes": ..., "count": ..., "ts": ..., "extra": ...}}``
    for every key that currently exists. When ``camera_ids`` is given only those
    cameras are fetched (one ``MGET``); otherwise the whole ``pa:overlay:*`` space
    is scanned. Missing / expired keys are simply omitted.

    Best-effort: returns ``{}`` on any Redis error rather than raising.
    """
    client = _redis()
    if client is None:
        return {}
    out: dict = {}
    try:
        if camera_ids:
            keys = [f"{_KEY_PREFIX}{cid}" for cid in camera_ids]
            values = client.mget(keys)
            pairs = zip(camera_ids, values)
        else:
            scanned = list(client.scan_iter(match=f"{_KEY_PREFIX}*"))
            values = client.mget(scanned) if scanned else []
            pairs = ((k[len(_KEY_PREFIX):], v) for k, v in zip(scanned, values))
        for cid, raw in pairs:
            if not raw:
                continue
            try:
                out[cid] = json.loads(raw)
            except (TypeError, ValueError):
                continue
    except Exception as exc:  # noqa: BLE001 — degrade to no overlays
        log.debug("overlay read failed err=%s", exc)
        return {}
    return out
