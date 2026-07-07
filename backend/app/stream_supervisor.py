"""Live people-analytics stream supervisor — the analytics worker process.

Runs OUTSIDE the API process (its own container / ``python -m app.stream_supervisor``,
behind the compose ``live`` profile). For every enabled camera with analytics on, a
worker thread pulls frames via the shared FFmpeg RTSPReader, detects + tracks people
with the shared YOLO26 detector and ByteTrack, runs the four scenario engines
(crowd / counting / loitering / intrusion) over the tracks, and persists any triggered
events via the shared :func:`app.events.record_event` — the same writer the ingest API
uses. Live boxes are pushed to Redis for the Live wall via :func:`app.overlay.push_overlay`.

The stream plumbing (RTSPReader with NVDEC + scale_cuda, the offline watchdog with a
startup grace, the per-camera restart-on-config-change) is ported verbatim from the FRS
supervisor; only the face pipeline is replaced by the person pipeline.

This module is import-safe on a machine with no cameras: it simply finds no enabled
cameras and idles, refreshing the camera list periodically.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import os
import threading
import time

from edge.core.logging import get_logger
from edge.db.base import get_sessionmaker

log = get_logger("people.supervisor")

# How often the supervisor re-reads the camera table to pick up add/edit/disable.
REFRESH_SECONDS = 20.0
# Cap live-overlay pushes to ~4/s so a high-fps camera doesn't flood Redis; scenario
# analysis still runs every decoded frame.
OVERLAY_INTERVAL = 0.25


def _envf(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _envi(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# Fallback default for the per-camera repeat-event cooldown (the live value is read
# off the camera's alert_suppress_seconds).
COOLDOWN_SECONDS = _envi("PA_ALERT_SUPPRESS_SECONDS", 30)
# Triton endpoint hosting the ``yolo26`` person detector. Shared-infra hostname by
# default; override with PA_TRITON_URL (or the platform-wide TRITON_URL).
TRITON_URL = os.getenv("PA_TRITON_URL", os.getenv("TRITON_URL", "vizor-triton:8000"))
# Person-detector confidence fallback (per-camera person_conf overrides it).
PERSON_CONF = _envf("PA_PERSON_CONF", 0.4)


class CameraWorker(threading.Thread):
    """Pulls frames from one camera, detects+tracks people, runs the scenarios."""

    def __init__(self, camera, loop: asyncio.AbstractEventLoop):
        super().__init__(daemon=True, name=f"cam-{camera.id}")
        self.camera = camera
        self.loop = loop
        self._stop = threading.Event()
        self._cam_key = str(camera.id)
        # Per-(event_type, track) cooldown so a lingering person / repeated crossing
        # doesn't spam events. Editing any config field restarts the worker (see
        # _cfg_sig), which naturally clears this state.
        self._cooldown: dict[tuple, float] = {}

        def _val(attr, default):
            v = getattr(camera, attr, None)
            return v if v is not None else default

        self._person_conf = float(_val("person_conf", PERSON_CONF))
        self._min_box_px = int(_val("min_box_px", 0))
        self._cooldown_seconds = float(_val("alert_suppress_seconds", COOLDOWN_SECONDS))
        self._live_fps = int(_val("fps", 10))
        self._scenarios = dict(_val("scenarios", {}) or {})

        # Stateful pipeline (detector client, tracker, scenario engines) built lazily
        # on first frame so a missing dependency never breaks worker construction.
        self._detector = None
        self._tracker = None
        self._engines: list = []
        self._last_overlay = 0.0

        # Wall-clock of the last decoded frame — the supervisor watches this to flip a
        # camera to "offline" when the stream stalls, and back to "online".
        self.last_frame_at = time.time()
        # When this worker (re)started, and whether it has EVER produced a frame. The
        # offline watchdog uses these to avoid false "offline" alerts during the normal
        # connect window right after a (re)start (ffprobe + RTSP handshake + NVDEC init).
        self.started_at = time.time()
        self.got_first_frame = False

    def _ensure_pipeline(self) -> bool:
        """Build the per-camera detector + ByteTracker + scenario engines once.
        Returns False if a dependency can't be imported (worker then idles)."""
        if self._detector is not None and self._tracker is not None:
            return True
        try:
            from .detection.tracker import ByteTracker
            from .detection.yolo import PersonDetector
            from .scenarios import (
                CountingEngine,
                CrowdEngine,
                IntrusionEngine,
                LoiteringEngine,
            )

            self._detector = PersonDetector(TRITON_URL, conf=self._person_conf)
            # Person tracking: looser IoU + longer max_age than the face tracker since
            # people move slower and occlude more. New tracks spawn from detections
            # already gated at person_conf, so keep the high threshold at/below it.
            self._tracker = ByteTracker(
                iou_threshold=0.2,
                max_age=60,
                high_thresh=min(0.4, self._person_conf),
                low_thresh=0.1,
            )
            sc = self._scenarios or {}
            self._engines = [
                CrowdEngine(sc.get("crowd") or {}),
                CountingEngine(sc.get("counting") or {}),
                LoiteringEngine(sc.get("loitering") or {}),
                IntrusionEngine(sc.get("intrusion") or {}),
            ]
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("pipeline init failed cam=%s err=%s", self.camera.id, exc)
            return False

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        import cv2

        from edge.stream.rtsp import RTSPReader

        c = self.camera
        log.info("camera worker start id=%s name=%s fps=%s", c.id, c.name, c.fps)
        if not self._ensure_pipeline():
            log.warning("camera worker idling (no pipeline) id=%s", c.id)
            return
        reader = RTSPReader(
            c.rtsp_url,
            fps=max(1, int(c.fps or self._live_fps)),
            reconnect=True,
            hw_accel=getattr(c, "hw_accel", "none") or "none",
            max_width=int(getattr(c, "analyze_width", 0) or 0),
        )
        got_frame = False
        try:
            for frame in reader.frames():
                if self._stop.is_set():
                    break
                self.last_frame_at = time.time()   # liveness heartbeat for the supervisor
                self.got_first_frame = True        # unblocks the offline watchdog
                if not got_frame:  # first decoded frame => camera is confirmed online
                    got_frame = True
                    self._set_status("online")
                try:
                    triggers, snapshot = self._process_frame(frame, cv2)
                except Exception as exc:  # noqa: BLE001 — never let one bad frame kill the worker
                    log.warning("analyse failed cam=%s err=%s", c.id, exc)
                    continue
                for trig in triggers:
                    asyncio.run_coroutine_threadsafe(self._persist(trig, snapshot), self.loop)
        except Exception as exc:  # noqa: BLE001
            log.warning("camera worker error id=%s err=%s", c.id, exc)
            self._set_status("error", str(exc)[:500])
        finally:
            reader.close()
            log.info("camera worker stop id=%s", c.id)

    def _process_frame(self, frame, cv2):
        """One frame → detect → track → overlay → scenario triggers.

        Returns ``(triggers, snapshot_bytes|None)``. The snapshot is the FULL frame
        encoded ONCE (only when something triggered) and shared by every event on it.
        """
        import numpy as np  # noqa: F401 — imported so a numpy-less env fails loudly here

        h, w = frame.shape[:2]
        now = time.time()

        # 1) detect people (native px) + drop boxes smaller than min_box_px.
        persons = self._detector.detect(frame, conf=self._person_conf)
        if self._min_box_px > 0:
            persons = [
                (b, s) for (b, s) in persons
                if min(float(b[2] - b[0]), float(b[3] - b[1])) >= self._min_box_px
            ]

        # 2) track.
        tracks = self._tracker.update([(b, s) for b, s in persons])

        # 3) live overlay (throttled). Boxes are pushed NORMALISED (0..1) w.r.t. the
        # analysis frame so the Live wall can scale them onto the (higher-res) WebRTC
        # video regardless of resolution — the analysis frame is downscaled
        # (analyze_width) while the wall plays the full-res MediaMTX stream, so raw
        # analysis-pixel boxes would land in the wrong place (shrunk toward top-left).
        if now - self._last_overlay >= OVERLAY_INTERVAL:
            self._last_overlay = now
            boxes = [
                {"bbox": [float(b[0]) / w, float(b[1]) / h, float(b[2]) / w, float(b[3]) / h],
                 "tid": int(tid), "label": f"#{tid}"}
                for tid, b in tracks
            ]
            try:
                from .overlay import push_overlay
                push_overlay(self._cam_key, boxes, count=len(tracks))
            except Exception as exc:  # noqa: BLE001 — overlay must never break analysis
                log.debug("overlay push failed cam=%s err=%s", self.camera.id, exc)

        # 3b) Annotated single-camera stream (1-up view): ONLY while a viewer is
        # watching this camera (Redis "want" flag). Boxes are drawn in THIS frame's
        # own pixel space and served as MJPEG → perfectly synced, no cross-pipeline
        # lag. Skipped entirely (no encode cost) for cameras nobody is watching.
        try:
            from .overlay import annotated_wanted, push_annotated
            if annotated_wanted(self._cam_key):
                ann = frame.copy()
                for tid, b in tracks:
                    x1, y1, x2, y2 = (int(b[0]), int(b[1]), int(b[2]), int(b[3]))
                    cv2.rectangle(ann, (x1, y1), (x2, y2), (0, 200, 0), 2)
                    cv2.putText(ann, f"#{int(tid)}", (x1, max(12, y1 - 6)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 0), 1, cv2.LINE_AA)
                cv2.putText(ann, f"People: {len(tracks)}", (10, 26),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 220, 0), 2, cv2.LINE_AA)
                ok, buf = cv2.imencode(".jpg", ann, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if ok:
                    push_annotated(self._cam_key, buf.tobytes())
        except Exception as exc:  # noqa: BLE001 — annotated view must never break analysis
            log.debug("annotated push failed cam=%s err=%s", self.camera.id, exc)

        # Normalised (0..1) box per track id, so a single-person event (intrusion /
        # loitering / line-crossing) can carry the triggering person's box for the
        # Events UI to crop. Normalised to match the snapshot regardless of resolution.
        track_boxes = {
            int(tid): [float(b[0]) / w, float(b[1]) / h, float(b[2]) / w, float(b[3]) / h]
            for tid, b in tracks
        }

        # 4) run each scenario engine; apply the per-(event_type, track) cooldown.
        fired: list[dict] = []
        for eng in self._engines:
            try:
                triggers = eng.update(tracks, w, h, now)
            except Exception as exc:  # noqa: BLE001 — one bad engine can't kill the frame
                log.warning("scenario failed cam=%s eng=%s err=%s",
                            self.camera.id, type(eng).__name__, exc)
                continue
            for trig in triggers:
                key = (trig.get("event_type"), str(trig.get("track_id") or ""))
                if now - self._cooldown.get(key, 0.0) < self._cooldown_seconds:
                    continue
                self._cooldown[key] = now
                # Attach the triggering person's box (if the trigger names a track).
                if trig.get("bbox") is None and trig.get("track_id") is not None:
                    trig["bbox"] = track_boxes.get(int(trig["track_id"]))
                fired.append(trig)

        snapshot = None
        if fired:
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            snapshot = buf.tobytes() if ok else None
        return fired, snapshot

    async def _persist(self, trig: dict, snapshot: bytes | None) -> None:
        from .events import record_event

        c = self.camera
        tid = trig.get("track_id")
        async with get_sessionmaker()() as db:
            try:
                await record_event(
                    db,
                    event_type=trig["event_type"],
                    camera_id=c.id,
                    camera_name=c.name,
                    count=trig.get("count"),
                    track_id=(str(tid) if tid is not None else None),
                    zone_name=trig.get("zone_name"),
                    bbox=trig.get("bbox"),
                    title=trig.get("title"),
                    severity=trig.get("severity", "info"),
                    snapshot_bytes=snapshot,
                    attributes=trig.get("attributes"),
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("event persist failed cam=%s err=%s", c.id, exc)

    def _set_status(self, status: str, error: str | None = None) -> None:
        asyncio.run_coroutine_threadsafe(self._write_status(status, error), self.loop)

    async def _write_status(self, status: str, error: str | None) -> None:
        from .domain.models import Camera

        async with get_sessionmaker()() as db:
            cam = await db.get(Camera, self.camera.id)
            if cam is not None:
                cam.status = status
                cam.last_error = error
                if status == "online":
                    cam.last_seen_at = dt.datetime.now(dt.timezone.utc)
                await db.commit()


def _cfg_sig(cam) -> str:
    """Order-stable signature of the analytics-affecting PER-CAMERA config.
    Editing a camera's name / location does NOT change it (no needless worker churn),
    but any stream param, detector tuning, cooldown, or scenario config does → the
    supervisor restarts the worker so the new params take effect."""
    import json

    return json.dumps(
        {
            "rtsp_url": getattr(cam, "rtsp_url", None),
            "fps": getattr(cam, "fps", None),
            "hw_accel": getattr(cam, "hw_accel", None),
            "analyze_width": getattr(cam, "analyze_width", None),
            "person_conf": getattr(cam, "person_conf", None),
            "min_box_px": getattr(cam, "min_box_px", None),
            "alert_suppress_seconds": getattr(cam, "alert_suppress_seconds", None),
            "scenarios": getattr(cam, "scenarios", None),
        },
        sort_keys=True,
        default=str,
    )


async def _load_cameras():
    """Snapshot of cameras with analytics turned ON (detached simple objects)."""
    from sqlalchemy import select

    from .domain.models import Camera

    async with get_sessionmaker()() as db:
        rows = (
            await db.execute(
                select(Camera).where(
                    Camera.enabled.is_(True), Camera.analytics_enabled.is_(True)
                )
            )
        ).scalars().all()
        # Detach lightweight copies (with ALL per-camera analytics params) so worker
        # threads never touch the async session.
        return [
            type("Cam", (), {
                "id": c.id, "name": c.name, "rtsp_url": c.rtsp_url, "fps": c.fps,
                "hw_accel": c.hw_accel, "analyze_width": c.analyze_width,
                "person_conf": c.person_conf, "min_box_px": c.min_box_px,
                "alert_suppress_seconds": c.alert_suppress_seconds,
                "scenarios": c.scenarios,
            })()
            for c in rows
        ]


async def _mark_status(cam_id, cam_name: str, status: str) -> None:
    """Persist a camera's online/offline state and raise an in-app notification
    (bell) for every active operator on the transition."""
    from sqlalchemy import select

    from .domain.models import Camera

    async with get_sessionmaker()() as db:
        cam = await db.get(Camera, cam_id)
        if cam is not None:
            cam.status = status
            cam.last_error = "stream unreachable" if status == "offline" else None
            await db.commit()
        try:
            from edge.auth.models import User
            from edge.messaging.dispatcher import notify

            uids = (await db.execute(select(User.id).where(User.is_active.is_(True)))).scalars().all()
            if uids:
                offline = status == "offline"
                await notify(
                    db, user_ids=list(uids),
                    title=f"Camera {'offline' if offline else 'back online'}",
                    body=f"{cam_name} {'is offline — no video stream received.' if offline else 'is online again.'}",
                )
        except Exception as exc:  # noqa: BLE001 — never let a notify failure break the loop
            log.warning("camera-status notify failed cam=%s: %s", cam_id, exc)


async def supervise() -> None:
    """Reconcile running workers with the enabled-camera set forever."""
    loop = asyncio.get_running_loop()
    workers: dict[str, CameraWorker] = {}
    sigs: dict[str, str] = {}
    offline_state: dict[str, bool] = {}   # cid -> currently flagged offline
    offline_after = _envf("PA_OFFLINE_SECONDS", 45.0)
    # Grace window after a worker (re)starts before it can be judged offline. Covers
    # ffprobe + RTSP handshake + first decode (and NVDEC init), so a routine
    # config-change restart never emits a spurious "camera offline" alert.
    startup_grace = _envf("PA_OFFLINE_STARTUP_SECONDS", 90.0)
    log.info("people-analytics stream supervisor started")
    while True:
        try:
            cams = await _load_cameras()
        except Exception as exc:  # noqa: BLE001
            log.warning("camera load failed: %s", exc)
            cams = []
        want = {str(c.id): c for c in cams}

        # Stop a worker whose camera was removed / analytics turned off, that died, OR
        # whose per-camera config changed — restart to pick up new params / scenarios.
        for cid in list(workers):
            changed = cid in want and _cfg_sig(want[cid]) != sigs.get(cid)
            if cid not in want or not workers[cid].is_alive() or changed:
                workers[cid].stop()
                workers.pop(cid, None)
                sigs.pop(cid, None)
                if changed:
                    log.info("camera %s config changed → restarting worker", cid)
        # Start a worker for every desired camera not currently running.
        for cid, cam in want.items():
            if cid not in workers:
                w = CameraWorker(cam, loop)
                w.start()
                workers[cid] = w
                sigs[cid] = _cfg_sig(cam)

        # ── Offline watchdog: no decoded frame for `offline_after`s → flip the camera
        # to "offline" (+ notify once); frames resuming flips it back to "online". ──
        now = time.time()
        for cid, w in list(workers.items()):
            if getattr(w, "got_first_frame", False):
                # Streaming worker: offline only after a real stall in the feed.
                stale = (now - getattr(w, "last_frame_at", now)) > offline_after
            else:
                # Still connecting for the first time (fresh/restarted worker): don't
                # judge until the startup grace elapses — otherwise a routine restart
                # or a slow RTSP handshake looks like an outage.
                stale = (now - getattr(w, "started_at", now)) > startup_grace
            if stale and not offline_state.get(cid):
                offline_state[cid] = True
                await _mark_status(w.camera.id, getattr(w.camera, "name", "Camera"), "offline")
            elif not stale and offline_state.get(cid):
                offline_state[cid] = False
                await _mark_status(w.camera.id, getattr(w.camera, "name", "Camera"), "online")
        for cid in list(offline_state):        # forget workers that were removed
            if cid not in workers:
                offline_state.pop(cid, None)

        if not workers:
            log.info("no cameras with analytics on; idling")
        await asyncio.sleep(REFRESH_SECONDS)


def main() -> None:
    import logging

    # Standalone process — configure our own logging (no uvicorn to do it for us).
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        asyncio.run(supervise())
    except KeyboardInterrupt:
        log.info("supervisor interrupted; exiting")


if __name__ == "__main__":
    main()
