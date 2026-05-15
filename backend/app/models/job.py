from sqlalchemy import Column, DateTime, Integer, JSON, String
from sqlalchemy.sql import func
from app.database import Base

class ProcessingJob(Base):
    __tablename__ = "processing_jobs"

    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String, nullable=False)
    input_type = Column(String, nullable=False)
    status = Column(String, nullable=False, default="created")
    output_dir = Column(String, nullable=True)
    result = Column(JSON, nullable=True)
    error = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
