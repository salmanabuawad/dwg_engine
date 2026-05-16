from __future__ import annotations

import os
from pathlib import Path

STORAGE_ROOT = Path(os.getenv("STORAGE_DIR", "./server_files/jobs"))


def storage_root() -> Path:
    STORAGE_ROOT.mkdir(parents=True, exist_ok=True)
    return STORAGE_ROOT


def job_dir(job_id: str) -> Path:
    path = storage_root() / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path
