from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.uploads import router as uploads_router
from app.auth import router as auth_router, ensure_users_schema

app = FastAPI(title="Navvix CAD Processing API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup_users() -> None:
    try:
        ensure_users_schema()
    except Exception as exc:  # noqa: BLE001
        # Don't crash the app if the DB isn't reachable at boot — the login
        # endpoint will fail with 500 instead of the whole service going down.
        print(f"[auth] users schema ensure failed: {exc}")


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "navvix"}

app.include_router(uploads_router, prefix="/api")
app.include_router(auth_router, prefix="/api")
