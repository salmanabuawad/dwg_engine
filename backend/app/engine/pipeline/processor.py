from __future__ import annotations

from pathlib import Path
import json
import zipfile

from app.engine.dimensions.dimension_engine import dimension_dxf
from app.engine.pipeline.pdf_handler import process_pdf
from app.engine.rendering.preview_renderer import render_dxf_preview
from app.engine.splitter.drawing_splitter import split_dxf

def process_dxf(input_path: Path, output_dir: Path) -> dict:
    split_dir = output_dir / "01_split_drawings"
    dim_dir = output_dir / "02_dimensioned_drawings"
    preview_dir = output_dir / "03_previews"

    split_dir.mkdir(parents=True, exist_ok=True)
    dim_dir.mkdir(parents=True, exist_ok=True)
    preview_dir.mkdir(parents=True, exist_ok=True)

    split_report = split_dxf(input_path, split_dir)

    drawings = []
    for drawing in split_report["drawings"]:
        n = drawing["drawing"]
        split_path = Path(drawing["file"])
        dimensioned_path = dim_dir / f"drawing_{n:02d}_dimensioned.dxf"

        dim_report = dimension_dxf(split_path, dimensioned_path)

        png = preview_dir / f"drawing_{n:02d}_dimensioned_preview.png"
        pdf = preview_dir / f"drawing_{n:02d}_dimensioned_preview.pdf"
        render_ok = render_dxf_preview(dimensioned_path, png, pdf)

        drawings.append({
            **drawing,
            "dimensioned_dxf": str(dimensioned_path),
            "preview_png": str(png) if render_ok else None,
            "preview_pdf": str(pdf) if render_ok else None,
            "dimension_report": dim_report,
        })

    result = {
        "input_type": "dxf",
        "input": str(input_path),
        "drawings_detected": len(drawings),
        "split_dir": str(split_dir),
        "dimensioned_dir": str(dim_dir),
        "preview_dir": str(preview_dir),
        "drawings": drawings,
    }

    report_path = output_dir / "processing_report.json"
    report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    zip_path = output_dir / "outputs.zip"
    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in output_dir.rglob("*"):
            if p.is_file() and p != zip_path:
                z.write(p, p.relative_to(output_dir))

    result["zip"] = str(zip_path)
    return result

def process_uploaded_file(input_path: Path, output_dir: Path) -> dict:
    suffix = input_path.suffix.lower()
    output_dir.mkdir(parents=True, exist_ok=True)

    if suffix == ".dxf":
        return process_dxf(input_path, output_dir)

    if suffix == ".pdf":
        result = process_pdf(input_path, output_dir)
        report_path = output_dir / "processing_report.json"
        report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        return result

    raise ValueError("Only .dxf and .pdf files are supported")
