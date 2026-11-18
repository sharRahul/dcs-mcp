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

The current GPT mission build contains 115 statics across four airfields:
seven planes, five helicopters and 103 servicing/staging props. Each airfield
also has a dedicated logistics stand containing crates, a pallet, a tug,
tools and optional crew/fire equipment. The previous build contained 79 statics.

Core/catalogued objects include `Ladder`, `Toolbox01`, `Toolbox02`, `ammo_cargo`,
`Cargo03`, `AM32a-60_01`, `Ural-4320 APA-5D`, `B600`, `Cargo01`, `Cargo02`.

Live DCS inspection found that `M92_Ammo_Pallet` requests a missing sling-cargo
definition for `M92_Cargo03`. Visual pallets therefore use the `Cargo03`
fortification static, which uses the same model without cargo handling.

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

Follow the [terrain placement workflow](terrain-placement.md) before finalizing
airfield objects. Parking coordinates do not establish level ground or model
contact; check the full footprint of aircraft, helicopters and support props.

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

Live DCS inspection on 18 November 2026 found all 79 previous-build statics alive
at their authored positions. Terrain checks found no water at the sampled ground
objects. The initial mission message executed. The full flight-dependent trigger
sequence was not flown. Keyboard camera controls did not respond during the
daylight inspection; these results do not establish a complete rendered review.

The revised 115-object build passes the scenery regression test and TypeScript
check/build, and generates with zero validation errors (five catalogue warnings).
The additional objects and corrected pallet have not yet had a rendered pass.

The GPT mission's original EWR and Ural command-truck footprints crossed steep
terrain: 30 m samples spanned approximately 10.5 m and 5.5 m in height. Their live
origins matched the central terrain elevation, so forcing altitude was not the
appropriate correction. Nearby replacement locations were selected with DCS's
clear-spot query (25 m clearance, slope limit 2 degrees): EWR x=-290248.263,
y=838491.087; command truck x=-289698.263, y=839841.087. Reported sampled slopes
were 0.99 and 0.47 degrees. These are scenery suitability checks, not validated
operational deployment positions; model contact still needs visual inspection.
