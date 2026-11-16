# Aerodrome Data and Frequencies — 01 February 2026

Kneeboard pages by **Dima Kozyrev (DimOn)**, "Aerodrome Data and Frequencies", updated
01 February 2026. Licence as published on the DCS user files page: *Freeware — free version,
unlimited distribution*. Unmodified copies; the author's own notes are in `Readme.txt`.
Feedback and updates: https://forum.dcs.world/topic/269908-aerodrome-data-and-frequencies/
(the author's site dimon.one has expired, so these copies were added here).

- `04_AD_Day_*.png` / `04_AD_Night_*.png` — the same pages in day and night colours, per
  theatre (table pages first, then maps), plus `Xtras` pages.
- `scripts/gen-airfield-navaids.py` OCRs the **day table pages** to build
  `data/airfield-navaids.json`, keeping a row only when its ATC frequencies match pydcs's
  for that airfield. Regenerate with:

  ```
  ocrenv/bin/python -I scripts/gen-airfield-navaids.py "docs/aerodrome data_01-feb-2026" data/airfield-radio.json data/airfield-navaids.json
  ```

  (`ocrenv` is a virtualenv with `rapidocr-onnxruntime`.) The generator records each image's
  sha256 in the output, so a regeneration from these files is checkable.
