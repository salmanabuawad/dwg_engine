"""
App-wide settings — DB-backed, no localStorage. Every UI session reads
the same defaults; uploads apply them; jobs snapshot the resolved
values into their own columns.

Supported keys (validated below):
- dim_color: 7-char hex like '#7a7a7a' (renderer dim line/arrow/label colour)
- arrow_direction: 'in' or 'out' (dimension arrowhead orientation)

Adding a new key:
1. Add it to SCHEMA below with its validator + default.
2. Add a typed accessor.
3. The /api/settings endpoint surfaces it automatically.
"""

from __future__ import annotations

from typing import Any, Callable
from sqlalchemy.orm import Session

from app.models import AppSetting


# ── Validators ───────────────────────────────────────────────────────


def _validate_hex_color(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    s = value.strip()
    if len(s) != 7 or not s.startswith("#"):
        return None
    if not all(c in "0123456789abcdefABCDEF" for c in s[1:]):
        return None
    return s.lower()


def _validate_arrow_direction(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    s = value.strip().lower()
    if s in ("in", "out"):
        return s
    return None


# ── Schema ───────────────────────────────────────────────────────────


SCHEMA: dict[str, tuple[Callable[[Any], Any], Any]] = {
    "dim_color":        (_validate_hex_color,       "#7a7a7a"),
    "arrow_direction":  (_validate_arrow_direction, "in"),
}


def _resolve_default(key: str) -> Any:
    return SCHEMA[key][1]


# ── Accessors ────────────────────────────────────────────────────────


def get_all_settings(db: Session) -> dict[str, Any]:
    """Return every known setting key, falling back to its default when
    the DB row is missing or invalid."""
    rows = {r.key: r.value for r in db.query(AppSetting).all()}
    out: dict[str, Any] = {}
    for key, (validator, default) in SCHEMA.items():
        raw = rows.get(key)
        out[key] = validator(raw) if raw is not None else default
        if out[key] is None:
            out[key] = default
    return out


def get_setting(db: Session, key: str) -> Any:
    if key not in SCHEMA:
        return None
    validator, default = SCHEMA[key]
    row = db.get(AppSetting, key)
    if row is None:
        return default
    parsed = validator(row.value)
    return parsed if parsed is not None else default


def update_settings(db: Session, updates: dict[str, Any]) -> dict[str, Any]:
    """Upsert each provided key after validation. Unknown keys are
    ignored. Invalid values raise ValueError so the API can return 400."""
    for key, raw in updates.items():
        if key not in SCHEMA:
            continue
        validator, _ = SCHEMA[key]
        clean = validator(raw)
        if clean is None:
            raise ValueError(f"invalid value for {key}: {raw!r}")
        row = db.get(AppSetting, key)
        if row is None:
            row = AppSetting(key=key, value=str(clean))
            db.add(row)
        else:
            row.value = str(clean)
    db.commit()
    return get_all_settings(db)
