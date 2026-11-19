# Ground sites and movement

Use `dcs_list_scene_templates` for scenery and `dcs_list_site_templates` for active
SAM/radar compositions. Scenery, an operational group and its terrain location are
separate choices. A fuel-depot model does not create fuel service, and a shelter
does not create a launcher.

## Compounds and boundaries

`dcs_miz_add_target_area` provides these compound presets in addition to the
existing depot, command-post and supply-yard sets:

| Preset | Contents and operational additions |
| --- | --- |
| `farp-staging` | Empty central pad area, ammunition/fuel scenery, command shelter, tent, windsock and guard tower. Add the actual pad at the centre using `dcs_miz_add_farp`; `support=true` adds coalition support vehicles. |
| `vehicle-staging` | Workshop, garages, container, staff tents and watchtower around an access lane. Add active parked/moving vehicles separately. |
| `scud-base` | Service shelters, command, communications, fuel/ammunition scenery and watchtower. Add active `Scud_B` vehicle groups and explicit firing tasks separately. |
| `sam-support` | Command, communications, generator, ammunition, tent and guard post. Place the active battery outside the support compound with clear radar/launcher sectors. |
| `military-base` | Command, communications, barracks, maintenance, warehouse, fuel/ammunition scenery and watchtower. Add combat groups, pads and supplier links explicitly. |
| `barracks` | Existing barracks/workshop/garage/tent grid. |

These presets include a rectangular boundary with a front entrance. `perimeter=false`
omits it; a `perimeter` object customizes the fortification type, nominal segment
dimensions, padding and gates. `dcs_miz_add_perimeter` also creates an independent
boundary. Entrances return inside/outside approach points for route authoring.
The new designed footprints keep their central access lane clear; the older
target sets retain their grid layouts. Returned `geometry` and `notes` explain
which arrangement was used.

Wall dimensions and footprints are layout conventions, not measured collision
meshes. Objects do not scale, a boundary creates no roads, and individual models
can obstruct access. Check the actual placement in the intended terrain. An
unobstructed central lane and a traversable sample gate were tested in DCS; this
does not establish every model, rotation, gate width or terrain combination.

## Road transit and combat deployment

`dcs_miz_create_ground_plan` defaults to road travel for `role="convoy"`.
`role="assault"` and `role="defensive"` default to a parallel spawn line;
moving assault routes use DCS's native `Rank` action (Line Abreast). A defensive
group has no movement route. Explicit `onRoad=false` allows off-road transit.

Each route point can select `movement`: `road`, `offroad`, `line_abreast`, `wedge`,
`diamond`, `echelon_left` or `echelon_right`. Following points inherit that choice.
For example, a plan can express road transit followed by combat deployment:

```json
{
  "role": "convoy",
  "speedMps": 8,
  "route": [
    { "x": -282500, "y": 686200, "movement": "road" },
    { "x": -281800, "y": 686200, "movement": "line_abreast", "speedMps": 5 },
    { "x": -281000, "y": 686200 }
  ]
}
```

Coordinates above illustrate the API, not a verified route. Use
`dcs_terrain_roads` to get native road-graph points for the running theatre, allow
room for deployment before contact and verify the actual journey. `formation`
and `spacingMetres` control initial unit placement; subsequent road/formation
spacing is managed by DCS. A line-shaped spawn alone does not make a group move
line abreast. Road intent cannot create a missing road or force passage through
a blocked bridge. These settings do not add automatic enemy detection or a
scripted reaction that deploys a convoy whenever it is attacked.

Scenario JSON supports `groundPlan` on vehicle forces, with the same plan settings
except its route is the force's existing `route` array. Aircraft and site-template
forces reject `groundPlan`. The convoy examples use road transit; advancing
combat vehicle groups use line-abreast assault plans. Static target vehicles
remain stationary.

## Existing terrain installations

Cold War Germany includes prepared SAM/AAA infrastructure, as described by
[Eagle Dynamics](https://www.digitalcombatsimulator.com/en/news/2025-04-18/).
`dcs_list_terrain_sites` currently provides four sourced candidate centres:
Rostock, Parchim, Wismar and northern Rügen. Their coordinates were reported by
[Essah on the ED forum](https://forum.dcs.world/topic/372225-updated-version-on-page-3-marked-up-map-with-sam-sites-air-and-helo-bases-etc/).
Native DCS checks confirmed dry terrain, coordinate conversion and nearby military
infrastructure at all four. Each record separates that observation from its
reported SA-3 layout and still reports `equipmentFit="unverified"`.

Pass a candidate's `lat`/`lon` to placement tools, inspect the existing buildings,
gates and revetments, and position each radar/launcher to fit. Do not place another
generic compound over terrain infrastructure or assume a generic SAM column fits
its prepared pads. Editor-authored and imported battery footprints retain their
individual offsets/headings. Use `dcs_terrain_clear_spot` and
`dcs_miz_move_ground_on_terrain` for advisory clearance and footprint checks.

This is an initial candidate catalogue, not all Germany sites or a global site
database. On other maps, the same placement and import tools accept explicit
coordinates and mission footprints; no match in this catalogue says nothing about
whether infrastructure exists on that terrain. Locations and historical identities
are not interchangeable, and imported mission geometry is not historical proof.

Native results and remaining limits are in [verification.md](verification.md).
