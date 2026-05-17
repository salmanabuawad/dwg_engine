from __future__ import annotations

from datetime import datetime, timezone
from sqlalchemy import Column, DateTime, String
from app.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AppSetting(Base):
    """Key/value store for app-wide rendering and pipeline defaults.

    The UI reads/writes settings here instead of localStorage so every
    browser session sees the same values and deploys can ship sensible
    defaults centrally. Each Job snapshots the resolved values into its
    own columns (jobs.dim_color, jobs.arrow_direction) at upload time —
    changing app_settings later does NOT retro-edit completed jobs.
    """
    __tablename__ = "app_settings"

    key = Column(String(64), primary_key=True)
    value = Column(String(256), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)
