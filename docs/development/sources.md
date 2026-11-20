# Source documents for generated data

The DCS User Manual is downloaded separately from Eagle Dynamics and is not distributed
in this repository. Keep a local copy at the ignored path below when regenerating data.
The pinned SHA-256 identifies the exact source used by the generator.

## `DCS_User_Manual_EN_2020.pdf`

| | |
|---|---|
| source | <https://www.digitalcombatsimulator.com/upload/iblock/ed6/87v22jwd1xh51i3rgki944xsf503istq/DCS_User_Manual_EN_2020.pdf> |
| sha256 | `449d733375bed6e599db703fe6e18527bfab403c0d6a080e03948b2b683408ce` |
| size | 40,387,907 bytes |
| manual created | 2022-07-27 (the file name says 2020; the document's own date is later) |
| consumed by | `scripts/data/gen-me-manual-actions.py` -> `data/me-manual-actions.json` |

What is taken from it: the Mission Editor's own **menu labels** for advanced waypoint actions, per
group type, from the Advanced Actions chapters' tables of contents. Labels only, linked to
`data/hoggit.json` by LITERAL name match — no prose is copied into the repo, and the manual's
aircraft chapter covers planes and helicopters together, so it never splits them.

Download the PDF from the source link above to `docs/DCS_User_Manual_EN_2020.pdf`,
verify its SHA-256 against the pinned value, then regenerate with:

```
pdftotext -layout docs/DCS_User_Manual_EN_2020.pdf manual.txt
python3 -I scripts/data/gen-me-manual-actions.py manual.txt \
  449d733375bed6e599db703fe6e18527bfab403c0d6a080e03948b2b683408ce \
  data/hoggit.json data/me-manual-actions.json
```

Two caveats that have not changed:

- The manual documents the editor's **menus**, not the mission file format. A label here is not
  evidence of how DCS stores or runs the action; that still comes from editor-saved missions
  (`tests/fixtures/trig-oracle.json`) or from Hoggit's scripting-API pages (`data/hoggit.json`).
- `files.digitalcombatsimulator.com` sits behind a Cloudflare browser challenge, so some ED
  downloads cannot be scripted at all. Use the official source link to obtain a local copy.
