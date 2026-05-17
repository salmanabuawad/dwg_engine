# Topology Engine Foundation

This update adds:
- endpoint snapping
- topology graph
- collinear wall chain merging
- gap/opening preservation
- debug JSON output
- dimension candidates from WallChain objects

Previous bad outputs came from merged regions / area bboxes, producing wrong values like:
- 15674
- 13141
- 8412

Still needed:
- room polygon detection
- wall ownership
- opening classification
- chain dimension rendering
- collision filtering
- semantic room validation
