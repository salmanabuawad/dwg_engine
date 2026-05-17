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


## Critical fix added

The system must isolate architectural geometry before dimensioning.

Never use:
- page frame lines
- title border lines
- sheet rectangles
- sparse full-sheet geometry

as:
- dimension bbox
- wall edges
- perimeter dimensions

Main protection module:
`app.engine.isolation.main_plan_isolation`

Do not remove it.

## Topology foundation added

Do not regress from topology back to bbox/region dimensioning.

New mandatory modules:
- app.engine.topology.snap
- app.engine.topology.node_graph
- app.engine.topology.wall_chain
- app.engine.validation.dimension_validator

Dimension engine must use WallChain objects as the main source of dimension candidates.

Forbidden:
- dimensioning merged region interiors
- dimensions from arbitrary connected components
- dimensions from room blobs
- giant values from bbox spans like 15674 / 13141 / 8412
