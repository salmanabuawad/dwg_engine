from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.engine.pipeline.processor import process_uploaded_file

router = APIRouter(tags=["uploads"])

DATA_DIR = Path("server_files")
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

@router.post("/process")
async def process_file(file: UploadFile = File(...)):
    suffix = Path(file.filename or "").suffix.lower()

    if suffix not in [".dxf", ".pdf"]:
        raise HTTPException(status_code=400, detail="Only PDF and DXF files are supported")

    job_id = str(uuid4())
    input_path = UPLOAD_DIR / f"{job_id}{suffix}"
    output_dir = OUTPUT_DIR / job_id
    output_dir.mkdir(parents=True, exist_ok=True)

    input_path.write_bytes(await file.read())

    try:
        result = process_uploaded_file(input_path=input_path, output_dir=output_dir)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "job_id": job_id,
        "filename": file.filename,
        "input_type": suffix.replace(".", ""),
        "status": "completed",
        "result": result,
    }

@router.get("/outputs/{job_id}/{filename}")
def get_output_file(job_id: str, filename: str):
    path = OUTPUT_DIR / job_id / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path)
