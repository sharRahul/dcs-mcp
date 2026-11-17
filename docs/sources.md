# First-party source documents kept in this repo

Generated data under `data/` is only as trustworthy as the document it came from, and several of
those documents are hard to fetch again later. The ones vendored here are the ones a generator
reads directly, so `npm run`-ing a regeneration does not depend on a download that may have moved.

Every file here is Eagle Dynamics' own published material, kept unmodified and byte-for-byte
identical to what the generator was run against. The sha256 below is the one pinned in the
generated JSON's `_sha256`, so a mismatch means the document changed and the data needs
regenerating — not that the data is wrong.

## `DCS_User_Manual_EN_2020.pdf`

| | |
|---|---|
| source | <https://www.digitalcombatsimulator.com/upload/iblock/ed6/87v22jwd1xh51i3rgki944xsf503istq/DCS_User_Manual_EN_2020.pdf> |
| sha256 | `449d733375bed6e599db703fe6e18527bfab403c0d6a080e03948b2b683408ce` |
| size | 40,387,907 bytes |
| manual created | 2022-07-27 (the file name says 2020; the document's own date is later) |
| consumed by | `scripts/gen-me-manual-actions.py` -> `data/me-manual-actions.json` |

What is taken from it: the Mission Editor's own **menu labels** for advanced waypoint actions, per
group type, from the Advanced Actions chapters' tables of contents. Labels only, linked to
`data/hoggit.json` by LITERAL name match — no prose is copied into the repo, and the manual's
aircraft chapter covers planes and helicopters together, so it never splits them.

Regenerate with:

```
pdftotext -layout docs/DCS_User_Manual_EN_2020.pdf manual.txt
python3 -I scripts/gen-me-manual-actions.py manual.txt \
  449d733375bed6e599db703fe6e18527bfab403c0d6a080e03948b2b683408ce \
  data/hoggit.json data/me-manual-actions.json
```

Two caveats that have not changed:

- The manual documents the editor's **menus**, not the mission file format. A label here is not
  evidence of how DCS stores or runs the action; that still comes from editor-saved missions
  (`tests/fixtures/trig-oracle.json`) or from Hoggit's scripting-API pages (`data/hoggit.json`).
- `files.digitalcombatsimulator.com` sits behind a Cloudflare browser challenge, so some ED
  downloads cannot be scripted at all. This one is served from `www.` and fetches normally —
  which is why it is here rather than described as unavailable.
