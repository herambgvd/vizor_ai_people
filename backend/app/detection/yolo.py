"""YOLO26 person detector over shared Triton (NMS-free, end-to-end).

YOLO26's one-to-one head emits already-decoded, de-duplicated detections — there is
NO NMS step. Triton returns a fixed ``[1, 300, 6]`` tensor of up to 300 detections,
each ``[x1, y1, x2, y2, score, class_id]`` in 640x640 letterbox space. We letterbox
the frame in, then un-letterbox the person boxes (class 0) back to native pixels.

The Triton HTTP client (geventhttpclient) is NOT thread-safe, and the worker runs
each camera on its own thread, so — exactly like the FRS engine — we keep one client
PER THREAD via ``threading.local``.
"""

from __future__ import annotations

import os
import threading

import numpy as np

try:  # tritonclient is only present in the images that actually run inference
    import tritonclient.http as triton_http
except Exception:  # noqa: BLE001
    triton_http = None


_MODEL = "yolo26"
_INPUT = "images"
_OUTPUT = "output0"
_IMG = 640
_PERSON_CLASS = int(os.getenv("PA_PERSON_CLASS", "0"))   # COCO person == 0


def letterbox(img: np.ndarray, new: int = _IMG, color: int = 114):
    """Aspect-preserving resize into a ``new x new`` canvas (YOLO-style padding).

    Returns ``(canvas, ratio, pad_left, pad_top)`` so detections can be mapped back
    to the original frame: ``x_orig = (x_letterbox - pad_left) / ratio``.
    """
    import cv2

    h, w = img.shape[:2]
    r = min(new / h, new / w)
    nh, nw = int(round(h * r)), int(round(w * r))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((new, new, 3), color, dtype=np.uint8)
    top, left = (new - nh) // 2, (new - nw) // 2
    canvas[top:top + nh, left:left + nw] = resized
    return canvas, r, left, top


class PersonDetector:
    """Detect people in a BGR frame via YOLO26 on Triton."""

    def __init__(self, url: str, conf: float = 0.4, timeout: float = 30.0):
        self.url = url.replace("http://", "").replace("https://", "")
        self.conf = conf
        self._timeout = timeout
        self._tls = threading.local()
        self.last_error: str | None = None

    def _conn(self):
        if triton_http is None:
            self.last_error = "tritonclient not installed"
            return None
        c = getattr(self._tls, "client", None)
        if c is not None:
            return c
        try:
            c = triton_http.InferenceServerClient(url=self.url, verbose=False)
            self._tls.client = c
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            c = None
        return c

    def ready(self) -> bool:
        c = self._conn()
        if c is None:
            return False
        try:
            return bool(c.is_model_ready(_MODEL))
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            return False

    def detect(self, frame_bgr: np.ndarray, conf: float | None = None) -> list[tuple[np.ndarray, float]]:
        """Return people as ``[(bbox_xyxy_float, score), ...]`` in native frame pixels.

        ``conf`` overrides the detector's default confidence floor (per-camera).
        Returns an empty list on any inference failure (never raises into the loop).
        """
        c = self._conn()
        if c is None:
            return []
        thr = self.conf if conf is None else conf
        h, w = frame_bgr.shape[:2]
        canvas, r, pad_l, pad_t = letterbox(frame_bgr)
        # BGR->RGB, /255, HWC->CHW, add batch → (1,3,640,640) float32.
        blob = canvas[:, :, ::-1].astype(np.float32) / 255.0
        blob = np.ascontiguousarray(blob.transpose(2, 0, 1)[None])
        try:
            inp = triton_http.InferInput(_INPUT, list(blob.shape), "FP32")
            inp.set_data_from_numpy(blob)
            out = c.infer(_MODEL, [inp], outputs=[triton_http.InferRequestedOutput(_OUTPUT)])
            dets = out.as_numpy(_OUTPUT)
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            return []
        if dets is None:
            return []
        dets = dets.reshape(-1, 6)  # [1,300,6] -> [300,6]
        people: list[tuple[np.ndarray, float]] = []
        for x1, y1, x2, y2, score, cls in dets:
            if int(round(cls)) != _PERSON_CLASS or score < thr:
                continue
            # Un-letterbox back to native frame coords + clip.
            bx1 = min(max((x1 - pad_l) / r, 0.0), w - 1)
            by1 = min(max((y1 - pad_t) / r, 0.0), h - 1)
            bx2 = min(max((x2 - pad_l) / r, 0.0), w - 1)
            by2 = min(max((y2 - pad_t) / r, 0.0), h - 1)
            if bx2 - bx1 < 1 or by2 - by1 < 1:
                continue
            people.append((np.array([bx1, by1, bx2, by2], dtype=np.float32), float(score)))
        return people
