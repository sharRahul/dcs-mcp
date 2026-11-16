# Native mission fixtures

Missions saved by the DCS **Mission Editor** (not by this project), kept as regression
fixtures. `tests/native.test.ts` runs every check below over each one:

1. the file's sha256 matches this manifest (the fixture is exactly what was supplied);
2. opening and saving it unmodified keeps every archive entry other than `mission`,
   `l10n/DEFAULT/dictionary` and `l10n/DEFAULT/mapResource` **byte for byte**, and those three
   reparse to exactly the same data;
3. every Lua data entry survives parse -> serialize -> reparse unchanged;
4. the validator reports no ERROR codes beyond `expectedErrors` (editor files are the
   reference: a new error code here is a validator bug, not a mission bug);
5. a small edit (adding a trigger zone) changes only `triggers.zones` and `maxDictId`-free data.

## Adding one

Save a mission in the Mission Editor, copy it here, and add an entry:

```json
{ "file": "caucasus-sam-sites.miz", "sha256": "<sha256sum>", "dcsVersion": "2.9.x.y",
  "savedBy": "Mission Editor", "theatre": "Caucasus", "expectedErrors": [], "notes": "SA-5 and Rapier sites" }
```

Missions with a warehouse inventory also exercise `dcs_import_warehouse_donor`.

To run the same suite over a whole folder without committing anything (for example your
`Saved Games/DCS/Missions`), set `DCS_NATIVE_MIZ_DIR` before `npm test`.

No fixtures are committed yet: no Mission-Editor-saved mission was available to this project.
