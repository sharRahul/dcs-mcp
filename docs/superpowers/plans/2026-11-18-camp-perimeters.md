# Camp perimeter implementation

Approved request: automatic static boundaries around military camps, entrances
and clear approaches. Scope is visual mission scenery, not defensive tactics.

- Implement a bounded rectangular static perimeter generator with rotated local
  coordinates, supported static types and configurable nominal segment sizes.
- Split edges around entrance intervals, reject invalid/overlapping entrances,
  and report world-space entrance/approach geometry. Never invent physical roads.
- Make barracks target areas include a perimeter by default; allow false to
  disable it. Other target templates preserve existing defaults. Use a cloned
  mission so invalid perimeters and name collisions cannot leave partial camps.
- Expose standalone perimeter creation and camp configuration through MCP.
- Test rotation, entrance width, valid static output, atomic failures, object
  limits, default/disabled camps, and save/reopen through actual MCP.
- Update public-schema fixture, docs, guide and run full checks/build/tests.

Default Twall_x1 span/depth are explicit layout assumptions, not measured model
dimensions. Terrain, meshes and live AI pathfinding remain unverified.

Completed: core geometry, automatic barracks boundaries, standalone tool, atomic
camp/zone staging, four focused tests including real MCP save/reopen, public
schema update and documentation. Build/check pass. Full regression: 312 tests,
304 passed, eight skipped, zero failures. Review's large-seam case was reproduced
and fixed by rejecting nominal gaps over 0.5 m; typical gate layouts still pass.
