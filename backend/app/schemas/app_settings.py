from __future__ import annotations

from pydantic import BaseModel


class AppSettings(BaseModel):
    """Resolved app-wide defaults the UI reads back. Each field carries
    a sensible fallback if the DB row is missing."""
    dim_color: str = "#7a7a7a"
    arrow_direction: str = "in"


class AppSettingsUpdate(BaseModel):
    """All-optional updates so the UI can patch one key at a time."""
    dim_color: str | None = None
    arrow_direction: str | None = None
