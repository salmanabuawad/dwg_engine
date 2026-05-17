from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.jobs import router as jobs_router
from app.api.app_settings import router as app_settings_router
from app.auth import router as auth_router, ensure_users_schema
from app.database import Base, engine
import app.models  # noqa: F401  — register ORM models with Base before create_all

app = FastAPI(title="dwg-engine", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    Base.metadata.create_all(bind=engine)
    try:
        ensure_users_schema()
    except Exception as exc:  # noqa: BLE001
        print(f"[auth] users schema ensure failed: {exc}")


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "dwg-engine"}


app.include_router(jobs_router, prefix="/api")
app.include_router(app_settings_router, prefix="/api")
app.include_router(auth_router, prefix="/api")
