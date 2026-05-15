# CLAUDE GUARD — DO NOT OVERWRITE ENGINE RULES

This project accepts PDF or DXF files.

A single DXF file may contain one drawing or many drawings.

Mandatory production flow:

1. Detect input type: PDF or DXF.
2. For DXF: always split into separate drawing workspaces first.
3. Process each drawing independently.
4. Never dimension the full sheet directly.
5. Never dimension legends, tables, title blocks, frames, notes, schedules, or page borders.
6. Build a normalized line registry first.
7. Group lines locally, not globally.
8. Generate dimensions from semantic architectural spans, not raw CAD entities.
9. Use perimeter-first strategy.
10. Export per drawing: split DXF, dimensioned DXF, PNG preview, PDF preview, report.

Do not revert to:
- raw line-by-line dimensioning
- full-sheet dimensioning
- global same-length grouping
- processing tables/legends as walls
- deleting this guard file
