# DCS site-template audit

Read-only audit of the current repository and installed Mission Editor library.
This records software content and provenance, not real-world deployment guidance
or an independently verified military establishment.

## Findings

Neither a historically verified shape nor full-battalion completeness is
guaranteed by the current template interface.

The current machine exposes 65 entries: 14 built-ins and 51 from its installed
Mission Editor library. No imported entries contributed to this snapshot.

Of the built-ins, 12 have `skynetRole: sam` and two are single-radar EWR entries.
Among those 12 SAM entries:

- SA-5 and Rapier contain explicit per-unit offsets copied from a DCS framework
  test mission. They have source-file/hash records, but no per-unit facing offsets.
- SA-2, SA-3, SA-6, SA-8, SA-10, SA-11, SA-15, Hawk, Patriot and NASAMS contain
  no explicit offsets. Authoring uses the generic column and configured spacing.
- A live engagement or successful loading provenance does not prove realistic
  geometry, historical accuracy, or organizational completeness.

All 51 editor-library entries contain explicit offsets and per-unit heading
offsets, with source-file/hash records. These prove an editor-authored layout;
they do not establish independently verified real-world deployment shapes.
Offset and heading-array lengths match each entry's flattened unit count.

## Composition and naming limitations

`SiteTemplate` stores a flat unit composition, spacing, optional offsets and
headings, source and DCS verification provenance. It has no organizational
echelon field, establishment reference, completeness criteria or battalion-level
hierarchy. Nothing validates that the generated group is a complete battalion.
Several entries are explicitly small sets or pairs. EWR entries are not SAM
formations. DCS functionality and organizational completeness are separate claims.

The `catalogue` provenance documentation currently calls its mix a standard
battery without attaching establishment evidence for that assertion. That wording
should not be interpreted as proof of real-world composition.

## Additional classification defect

`meSiteTemplates()` maps every imported editor group template to
`skynetRole: sam`. The returned list includes gun batteries, searchlights,
radar sites, a mortar crew and a V1 launch-site template. Consequently, the
combined site catalogue is not a SAM-only catalogue, and its role label cannot
be treated as verified Skynet compatibility.

## Appropriate software follow-up

- Expose geometry provenance separately from DCS execution provenance.
- Label layouts as generic, editor-authored or imported; never silently promote
  a working DCS group to a historically verified deployment.
- Separate SAM, radar, gun and other editor templates in the catalogue.
- Report flat group composition and DCS capability checks; keep organizational
  echelon/completeness unknown unless separately established.
- Prefer an explicitly selected editor-authored layout where available when the
  user requests DCS scenery fidelity, while preserving existing IDs and missions.

Files inspected: `src/miz/templates.ts`, `src/dcs/me-templates.ts`, and the current
installed `MissionEditor/data/scripts/templates.lua` through the existing parser.
No runtime code, compositions or layouts were changed by this audit.

## User-supplied historical references

Two attached PDFs were inspected for document identity and historical scope:

- `CIA-RDP80T01471R001200090002-9`: *New SAM Sites, North Vietnam*, five
  scanned PDF pages. It concerns historical SA-2 observations in North Vietnam.
  Its briefing notes explicitly limit their use to their reporting period and
  warn against treating them as detailed analytical work.
- `CIA-RDP78T05439A000500210055-7`: *The Soviet SA-3 Missile System*, scientific
  intelligence report OSI-SR/TCS/65-10, dated 8 July 1965 on its title page
  (PDF page 2). The attached PDF contains 37 pages and includes an exemption sheet.

These are relevant historical references, rather than DCS-authored evidence.
Their existence corrects any implication that historical source material is
unavailable. However, a dated intelligence assessment or observed site's imagery
does not by itself validate every system, operator, era or full battalion's
organizational completeness. Original analysis dates must remain distinct from
declassification dates and PDF creation metadata. Redactions, scan/OCR quality,
and the assessment's own uncertainty remain material limitations.

No deployment coordinates, spacing, geometry or battalion compositions were
extracted into templates. The prior software audit conclusions are unchanged.
