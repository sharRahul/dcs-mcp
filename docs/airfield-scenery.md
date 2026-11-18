# Airfield scenery conventions

Use coherent servicing, ordnance staging and cargo scenes. Choose aircraft and
equipment to suit the airfield's mission role rather than repeating identical
rows at every base. Preserve active and late-activated flight-start parking.

The Iron Veil scenery helper follows these rules:

- Kutaisi: fighter servicing, utility helicopter, and separate ordnance staging.
- Senaki-Kolkhi: C-130/utility-helicopter support and cargo staging.
- Vaziani: fighter servicing, a parked Ka-50, and separate ordnance staging.
- Tbilisi-Lochini: An-26/Mi-8 transport support and cargo staging.
- Access ladders, toolboxes and technicians are grouped around fixed-wing
  aircraft only where the stand dimensions allow them outside the aircraft's
  bounding footprint. Helicopter rotor footprints remain clear of close props.
- Ground power and workshop items share reserved servicing stands. Ordnance or
  cargo shares a different reserved stand. A toolbox does not consume an entire
  stand by itself: the bay is reserved for its full group of props.
- Bombs are represented by actual bomb-cart assets in ordnance staging areas.
  Generic ammo crates are not labelled as particular aircraft weapons. Static
  props neither load weapons nor change aircraft payloads.

## Assets and local dependencies

The revised `iron-veil-01-first-contact-airfields.miz` contains 79 statics across
four airfields: seven planes, five helicopters and 67 servicing/staging props.
Those props include 19 ground-crew figures, two bomb carts and ten ladders.

Core/catalogued objects include `Ladder`, `Toolbox01`, `Toolbox02`, `ammo_cargo`,
`M92_Ammo_Pallet`, `AM32a-60_01`, `Ural-4320 APA-5D`, `B600`, `Cargo01`, `Cargo02`.

Additional objects come from mods installed on this machine:

| Mod | Objects used |
| --- | --- |
| Massun92-Humans | `M92_Personnel06_PBR`, `M92_Personnel07_PBR` |
| VPC Airfield Equipment | `VP-MAN_1_Idle`, `VP-MAN_2_Check`, `VP-FIRE_EX`, `VP-BOGIE OFAB 120`, `VPC-NATO-GBU-31 CART` |

The source declarations are read from the profile's `Mods/tech` directory as Lua
syntax/data, never executed. The server exposes these local static types through
its existing type catalogue after startup. The mod scanner also recognises the
declarations, so deployed scenery is not incorrectly reported as missing.
Absent optional mods are recorded in the scene manifest's `skipped` list; no
invented type ID, carrier-deck crew or armed-infantry substitute is inserted.

The generated mission requires the above mods for the full visual scene. Their
scripts and models are not embedded or redistributed. Presence of declarations
does not independently establish that a mod loaded correctly in DCS.

## Placement and verification limits

The scene is built on a clone and committed only after complete placement.
Aircraft use category/size-compatible free open stands. Props are checked against
the reserved stand's nominal dimensions and aircraft bounding footprints.
Stand headings use a nearest-row normal oriented toward the airfield reference
point; they are explicitly a heuristic because catalogue parking data contains
no surveyed stand orientations or taxi-lane geometry.

This is visual scene design, not a surveyed apron or weapons-handling plan.
Object clearances use conservative placement sizes, not collision meshes.
Terrain, buildings, taxi lanes, exact ladder fit and mod rendering must still be
inspected in DCS. Do not call the layout taxi-clear or live-verified from the
offline tests alone.

Verification: the generated mission reopened with all 79 objects and zero
validation errors. The full regression run passed 300 tests, with eight skipped;
TypeScript check/build and focused read-only review also passed.
