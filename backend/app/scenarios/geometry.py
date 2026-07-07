"""Pure-geometry helpers shared by the four people-analytics scenario engines.

Zones (polygons) and counting lines are stored NORMALISED (0..1) on the camera so
they are resolution-independent. A person's ground position is the bottom-centre
("foot") of its bounding box — the point that actually touches the floor, which is
what a zone/line is drawn against. Engines normalise the foot point
(``fx = px / w``, ``fy = py / h``) before testing it, so every routine here operates
in one consistent 0..1 space.
"""

from __future__ import annotations


def point_in_poly(px: float, py: float, poly) -> bool:
    """Ray-casting point-in-polygon test.

    ``poly`` is ``[[x, y], ...]`` (same coordinate space as ``px, py``). Returns
    False for a degenerate polygon (< 3 vertices).
    """
    if not poly or len(poly) < 3:
        return False
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i][0], poly[i][1]
        xj, yj = poly[j][0], poly[j][1]
        if (yi > py) != (yj > py):
            xint = (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi
            if px < xint:
                inside = not inside
        j = i
    return inside


def norm_to_px(poly, w: int, h: int):
    """Scale a normalised polygon / line ``[[x, y], ...]`` to pixel coordinates."""
    return [[p[0] * w, p[1] * h] for p in (poly or [])]


def bbox_foot(bbox):
    """Ground position of a person = bottom-centre of the bbox ``(x1, y1, x2, y2)``."""
    x1, y1, x2, y2 = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
    return ((x1 + x2) / 2.0, y2)


def seg_side(p, a, b) -> int:
    """Which side of the directed line ``a -> b`` the point ``p`` lies on.

    Sign of the 2-D cross product ``(b - a) x (p - a)``: ``+1`` left, ``-1`` right,
    ``0`` exactly on the line. A track flips sign as it crosses the line, which the
    counting engine turns into an in/out tally.
    """
    cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    if cross > 0:
        return 1
    if cross < 0:
        return -1
    return 0
