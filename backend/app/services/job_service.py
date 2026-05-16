from __future__ import annotations

import shutil
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import UploadFile
from sqlalchemy.orm import Session

from app.engine.pipeline.processor import process_uploaded_file
from app.models import Job
from app.services.storage import job_dir

ALLOWED_EXTENSIONS = {".dxf", ".pdf"}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def create_job(db: Session, file: UploadFile) -> Job:
    filename = file.filename or "input.dxf"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError("Only .dxf and .pdf files are accepted")

    job_id = uuid.uuid4().hex
    directory = job_dir(job_id)
    input_path = directory / f"input{ext}"
    data = await file.read()
    input_path.write_bytes(data)

    job = Job(
        id=job_id,
        filename=filename,
        status="pending",
        size_bytes=len(data),
        input_path=str(input_path),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def _primary_outputs(report: dict) -> dict:
    """Pick representative DXF/PDF/PNG outputs from the multi-drawing report.

    The dwg_engine pipeline splits a DXF into multiple drawings; the navvix-style
    UI shows a single preview, so we surface the first drawing's outputs.
    """
    drawings = report.get("drawings") or []
    if drawings:
        first = drawings[0]
        return {
            "output_dxf_path": first.get("dimensioned_dxf"),
            "preview_pdf_path": first.get("preview_pdf"),
            "preview_png_path": first.get("preview_png"),
        }
    pages = report.get("pages") or []
    if pages:
        first = pages[0]
        return {
            "output_dxf_path": None,
            "preview_pdf_path": None,
            "preview_png_path": first.get("preview_png"),
        }
    return {"output_dxf_path": None, "preview_pdf_path": None, "preview_png_path": None}


def process_job(db_factory, job_id: str) -> None:
    db: Session = db_factory()
    try:
        job = db.get(Job, job_id)
        if not job:
            return
        job.status = "processing"
        job.started_at = utcnow()
        db.commit()

        directory = job_dir(job_id)
        report = process_uploaded_file(Path(job.input_path), directory)
        outputs = _primary_outputs(report)

        job.status = "done"
        job.done_at = utcnow()
        job.output_dxf_path = outputs["output_dxf_path"]
        job.preview_pdf_path = outputs["preview_pdf_path"]
        job.preview_png_path = outputs["preview_png_path"]
        job.report = report
        db.commit()
    except Exception:
        job = db.get(Job, job_id)
        if job:
            job.status = "error"
            job.error = traceback.format_exc()
            db.commit()
    finally:
        db.close()


def delete_job(db: Session, job_id: str) -> None:
    job = db.get(Job, job_id)
    if not job:
        return
    shutil.rmtree(job_dir(job_id), ignore_errors=True)
    db.delete(job)
    db.commit()
