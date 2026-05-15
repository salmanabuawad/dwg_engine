from __future__ import annotations

from pathlib import Path
import fitz

def process_pdf(input_pdf: Path, output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(str(input_pdf))

    pages = []
    for i, page in enumerate(doc, start=1):
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        png = output_dir / f"page_{i:02d}_preview.png"
        pix.save(str(png))
        pages.append({
            "page": i,
            "preview_png": str(png),
            "width": page.rect.width,
            "height": page.rect.height,
            "status": "preview_generated",
        })

    return {
        "input_type": "pdf",
        "pages": pages,
        "note": "PDF support is enabled. Raster/scanned PDFs need vector extraction/OCR before CAD dimension generation.",
    }
