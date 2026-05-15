from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.uploads import router as uploads_router

app = FastAPI(title="Navvix CAD Processing API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "navvix"}

app.include_router(uploads_router, prefix="/api")
