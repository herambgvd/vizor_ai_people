"""Pydantic request/response schemas for the People Analytics domain API."""

from __future__ import annotations

import datetime as dt
import uuid

from pydantic import BaseModel, ConfigDict, Field


# --------------------------------------------------------------------------- cameras
class CameraCreate(BaseModel):
    name: str
    rtsp_url: str
    location: str | None = None
    zone: str | None = None
    enabled: bool = True
    analytics_enabled: bool = True
    person_conf: float = Field(0.4, ge=0.1, le=0.95)
    min_box_px: int = Field(0, ge=0, le=2000)
    alert_suppress_seconds: int = Field(30, ge=0, le=3600)
    scenarios: dict | None = None      # per-scenario config; server fills defaults
    fps: int = Field(10, ge=1, le=15)
    hw_accel: str = "none"             # none | nvdec
    analyze_width: int = Field(0, ge=0, le=3840)   # 0 = native; else downscale cap


class CameraUpdate(BaseModel):
    name: str | None = None
    rtsp_url: str | None = None
    location: str | None = None
    zone: str | None = None
    enabled: bool | None = None
    analytics_enabled: bool | None = None
    person_conf: float | None = Field(None, ge=0.1, le=0.95)
    min_box_px: int | None = Field(None, ge=0, le=2000)
    alert_suppress_seconds: int | None = Field(None, ge=0, le=3600)
    scenarios: dict | None = None
    fps: int | None = Field(None, ge=1, le=15)
    hw_accel: str | None = None
    analyze_width: int | None = Field(None, ge=0, le=3840)


class CameraOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    rtsp_url: str
    location: str | None
    zone: str | None
    enabled: bool
    analytics_enabled: bool
    person_conf: float
    min_box_px: int
    alert_suppress_seconds: int
    scenarios: dict
    fps: int
    hw_accel: str
    analyze_width: int
    status: str
    last_seen_at: dt.datetime | None
    last_error: str | None
    # Computed / enriched by the router.
    snapshot_url: str | None = None
    events_24h: int = 0
