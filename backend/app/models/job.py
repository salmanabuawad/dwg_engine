from __future__ import annotations

from datetime import datetime, timezone
from sqlalchemy import Column, DateTime, Integer, JSON, String, Text
from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Job(Base):
    __tablename__ = "jobs"

    id = Column(String(64), primary_key=True)
    filename = Column(String(512), nullable=False)
    status = Column(String(32), nullable=False, default="pending")
    size_bytes = Column(Integer, nullable=False, default=0)
    error = Column(Text, nullable=True)
    report = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=True)
    done_at = Column(DateTime(timezone=True), nullable=True)

    input_path = Column(String(1024), nullable=False)
    output_dxf_path = Column(String(1024), nullable=True)
    preview_pdf_path = Column(String(1024), nullable=True)
    preview_png_path = Column(String(1024), nullable=True)
