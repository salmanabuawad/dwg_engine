# Claude Instructions

Do not overwrite the pipeline architecture.

Preserve:
- app.engine.splitter
- app.engine.geometry
- app.engine.dimensions
- app.engine.rendering
- app.engine.pipeline

Do not bypass the split step for DXF files.

When improving the engine:
- extend modules
- add tests
- preserve guards
- do not return to full-sheet processing
