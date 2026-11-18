# Static camp boundaries

`dcs_miz_add_target_area` with `template: "barracks"` now creates the camp's
static buildings and a rectangular static perimeter by default. The default is
`Twall_x1`, 50 m padding from the grid's outer object centres, and one centred
12 m front entrance. The trigger zone, when requested, covers the whole result.
`objects` includes the perimeter objects; `perimeter` contains their geometry.

Other target templates preserve their existing open layout unless `perimeter`
is supplied. Imported scenes retain their original boundaries without adding
another perimeter. Set `perimeter: false` for an open barracks camp.

Example customization within an existing target-area request:

```json
{
  "template": "barracks",
  "perimeter": {
    "type": "Twall_x1",
    "segmentLengthMetres": 3,
    "segmentDepthMetres": 0.4,
    "paddingMetres": 50,
    "gates": [
      {"edge": "front", "offsetMetres": 0, "widthMetres": 12},
      {"edge": "rear", "offsetMetres": 0, "widthMetres": 8}
    ]
  }
}
```

For an existing scene, use `dcs_miz_add_perimeter` with session, coalition,
country, name, x/y or lat/lon, heading, `widthMetres` and `depthMetres`. It accepts
the same wall and entrance settings, except padding: standalone dimensions are
already explicit. Rectangles are limited to 20–2000 m per side and 1000 objects.

Width runs across the local right axis. Depth runs along the camp heading;
`front` is positive depth, `rear` negative, and `left`/`right` are across width.
Entrance offsets run along the corresponding edge in these local axes.
Overlapping entrances, corner intrusions and wall runs too short for the chosen
segment size are rejected before any mission edit commits.

The response includes each wall segment, entrance centre and nominal width, plus
inside/outside approach points. The inside approach stops no farther than the
rectangle centre. These points describe entrance approaches: they neither author
physical roads nor reserve paths through existing buildings. Keep these approaches
clear when adding vehicles or further scenery. Camp padding provides space around
the building-centre grid; building collision dimensions are not known here.

## Geometry limits

Default segment span 3 m, depth 0.4 m and zero model heading offset are explicit
scene-layout assumptions, not measurements of `Twall_x1`. `dimensionsVerified`
is always false. Full-size objects are distributed along each wall run without
scaling them, so nominal seams up to 0.5 m can remain. Layouts exceeding this
tolerance are rejected; choose shorter segments or adjust the dimensions/gates.
Nominal segment intervals do not enter
the requested gate openings. Actual wall ends, corners and openings depend on
the model's real dimensions and orientation.

Custom HESCO, sandbag or other Fortifications assets require appropriate nominal
dimensions and `modelHeadingOffsetDegrees`. Asset names are validated against
the available type catalogue; their collision meshes are not inspected. Terrain,
buildings, exact wall joins and native DCS vehicle pathfinding need live checks.
This is visual mission scenery, not a real-world fortification plan.

Core edits are atomic. Invalid types, entrance geometry, excessive counts and
name collisions leave the original mission unchanged; the MCP camp tool also
stages its trigger zone before committing.
