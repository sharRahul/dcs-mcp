# Airfield scenery revision

User-approved direction: realistic aircraft servicing areas, ordnance/cargo
staging, ladders, ammo boxes and airmen. Use real supported DCS assets.

- Read installed Massun92-Humans and VPC definitions as Lua syntax/data, never
  execute mod code. Expose static metadata through the existing type-source layer.
- Replace whole-slot support-truck rows with servicing props placed relative to
  aircraft dimensions. Keep people/tools outside aircraft/rotor footprints.
- Place ordnance and crates together in distinct reserved staging stands rather
  than scatter bombs under every aircraft. Use land personnel, not deck crew.
- Retain all authored flight parking; create the scene on a clone and commit only
  after complete placement. Report optional missing mods rather than invent IDs.
- Test declaration parsing, absent mods, comment handling, footprint separation,
  source preservation and save/reopen. Rebuild both mission outputs and validate.

Placement is a scene-design convention, not a surveyed apron plan. Catalogue
parking data has no stand orientation or taxi-lane geometry. Do not claim live
taxi clearance or exact boarding-ladder fit without DCS observation.
