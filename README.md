# Navvix Production CAD Processor

Production-oriented starter code for processing architectural PDF/DXF files.

## Stack

- React + TypeScript frontend
- Python + FastAPI backend
- PostgreSQL via SQLAlchemy
- DXF engine with ezdxf
- PDF preview handling with PyMuPDF

## Supported input

- `.dxf`
- `.pdf`

## Important behavior

A file may contain one drawing or many drawings.

DXF flow:

```text
upload.dxf
→ split into separate drawings
→ process each drawing independently
→ create dimensioned DXF per drawing
→ create PNG/PDF preview per drawing
→ create processing report
```

PDF flow:

```text
upload.pdf
→ split/render pages as previews
→ report pages
→ ready for future vector/OCR extraction
```

## Run backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Run frontend

```bash
cd frontend
npm install
npm run dev
```

## CLI

```bash
python scripts/process_file.py samples/input.dxf --output-dir server_files/test_output
python scripts/process_file.py samples/input.pdf --output-dir server_files/pdf_output
```
