from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas import AppSettings, AppSettingsUpdate
from app.services.settings_service import get_all_settings, update_settings


router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", response_model=AppSettings)
def read_settings(db: Session = Depends(get_db)):
    return get_all_settings(db)


@router.put("", response_model=AppSettings)
def write_settings(patch: AppSettingsUpdate, db: Session = Depends(get_db)):
    payload = patch.model_dump(exclude_unset=True, exclude_none=True)
    if not payload:
        return get_all_settings(db)
    try:
        return update_settings(db, payload)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
