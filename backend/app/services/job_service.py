from __future__ import annotations

import shutil
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import UploadFile
from sqlalchemy import select
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


def _drawing_outputs(drawing: dict) -> dict:
    return {
        "output_dxf_path": drawing.get("dimensioned_dxf"),
        "preview_pdf_path": drawing.get("preview_pdf"),
        "preview_png_path": drawing.get("preview_png"),
    }


def _child_filename(parent_filename: str, index: int) -> str:
    stem = Path(parent_filename).stem
    suffix = Path(parent_filename).suffix or ".dxf"
    return f"{stem}__drawing_{index:02d}{suffix}"


def process_job(db_factory, job_id: str) -> None:
    """Run the pipeline. If the input splits into multiple drawings, fan out:
    the original job row represents drawings[0] and one sibling Job is created
    per remaining drawing, all linked back via parent_job_id.
    """
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
        drawings = report.get("drawings") or []
        finished_at = utcnow()

        if not drawings:
            job.status = "done"
            job.done_at = finished_at
            job.report = report
            db.commit()
            return

        original_filename = job.filename
        first = drawings[0]
        outputs = _drawing_outputs(first)
        job.status = "done"
        job.done_at = finished_at
        job.output_dxf_path = outputs["output_dxf_path"]
        job.preview_pdf_path = outputs["preview_pdf_path"]
        job.preview_png_path = outputs["preview_png_path"]
        job.drawing_index = first.get("drawing", 1)
        job.report = report
        if len(drawings) > 1:
            job.filename = _child_filename(original_filename, job.drawing_index or 1)

        for d in drawings[1:]:
            child_outputs = _drawing_outputs(d)
            child = Job(
                id=uuid.uuid4().hex,
                parent_job_id=job.id,
                drawing_index=d.get("drawing"),
                filename=_child_filename(original_filename, d.get("drawing") or 0),
                status="done",
                size_bytes=0,
                input_path=job.input_path,
                output_dxf_path=child_outputs["output_dxf_path"],
                preview_pdf_path=child_outputs["preview_pdf_path"],
                preview_png_path=child_outputs["preview_png_path"],
                created_at=job.created_at,
                started_at=job.started_at,
                done_at=finished_at,
                report={"drawing": d, "parent_report_id": job.id},
            )
            db.add(child)

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
    """Delete a job. If it's a parent, cascade-delete all its children and
    wipe the on-disk job directory. If it's a child, delete just the row;
    files live in the parent's directory and are kept for surviving siblings.
    """
    job = db.get(Job, job_id)
    if not job:
        return

    if job.parent_job_id is None:
        children = db.scalars(select(Job).where(Job.parent_job_id == job.id)).all()
        for child in children:
            db.delete(child)
        shutil.rmtree(job_dir(job_id), ignore_errors=True)

    db.delete(job)
    db.commit()
