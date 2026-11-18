# Check terrain before ground placement

Before finalizing ground vehicles, EWRs, SAM components, parked aircraft,
helicopters or scenery, check elevation and slope over each object's footprint.
A centre point being on land and at the correct elevation does not establish
that the object can sit correctly across the surrounding ground.

## Finding from Iron Veil, 18 November 2026

Live DCS queries showed that the 55G6 EWR and Ural-375 PBU origins matched
the terrain height at their centres. However, nine terrain samples across each
30 m footprint spanned approximately 10.5 m and 5.5 m of elevation respectively.
This supports steep terrain as a placement problem; it does not prove a model
origin or rendering defect. Nearby replacements were selected using a 25 m
clearance query and a 2 degree slope limit. Their reported sampled slopes were
0.99 and 0.47 degrees. The revised model contact still needs visual confirmation.

## Placement workflow

1. Use terrain data for the mission's exact theatre: a matching live DCS session,
   a sourced elevation/surface grid, or a sufficiently detailed terrain pack.
   Record the source and sampling resolution. Coordinate conversion and parking
   coordinates alone do not supply elevation data.
2. Sample the centre and surrounding footprint of **every** object, including
   individual units within a formation. Choose a footprint and sampling interval
   appropriate to the model's length, width and supports; do not apply a small
   truck footprint to a large radar or aircraft. Check surface, elevation range
   and slope. Reject water and unknown samples; report unavailable data explicitly.
3. Use `dcs_terrain_analyze` with `operation: "suitability"` for assessment.
   `dcs_terrain_clear_spot` can find nearby land with acceptable sampled slope
   and scenery clearance in live DCS. Recheck candidate footprints at suitable
   resolution: coarse search samples can miss small terrain changes.
4. For existing vehicle groups, `dcs_miz_move_ground_on_terrain` checks every
   unit footprint before moving the group and preserves formation offsets.
   It currently accepts a live source or an explicit offline grid; it does not
   automatically consume installed packs. Other object categories need their
   own assessment before authoring their final coordinates.
5. Prefer nearby level ground when a footprint fails. Do not force ground-unit
   altitude to conceal a slope problem. A 2 degree limit was used for this scene;
   it is a conservative scenery choice, not a universal equipment requirement.
6. Inspect the saved mission in DCS for floating or buried models, wheel/support
   contact, buildings, vegetation, apron clearance and taxi access. Terrain
   sampling alone cannot establish collision-free or visually correct placement.

When terrain is unavailable, retain the candidate as **unverified**, not as a
terrain-approved placement. Report offline validation, sampled terrain checks
and rendered DCS inspection separately. The authoring APIs do not universally
enforce this workflow automatically.
