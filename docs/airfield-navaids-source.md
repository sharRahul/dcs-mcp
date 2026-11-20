# Airfield navigation data sources

DCS MCP includes the generated `data/airfield-navaids.json`. Users do not need
the original chart images to install the server or create missions.

The source charts are **Aerodrome Data and Frequencies**, dated 01 February 2026,
by **Dima Kozyrev (DimOn)**. The author's DCS user-files listing describes the
licence as “Freeware — free version, unlimited distribution”. See the
[author's forum topic](https://forum.dcs.world/topic/269908-aerodrome-data-and-frequencies/)
for the source. GitHub retains only the 32 DAY table PNGs used to generate the
dataset, plus the author's original `Readme.txt`, in `docs/aerodrome data_01-feb-2026/`.
These source images are excluded from the npm package. NIGHT, map and unused pages
are excluded from Git.

Contributors can regenerate from the retained images in a clone. The generated
JSON retains the SHA-256 hashes of the table images used, under `_images_sha256`,
so contributors can compare their source copy with the original inputs.

With Python, Pillow and `rapidocr-onnxruntime` installed in an OCR virtual environment, run:

```sh
ocrenv/bin/python -I scripts/gen-airfield-navaids.py "docs/aerodrome data_01-feb-2026" data/airfield-radio.json data/airfield-navaids.json
```

On Windows, use `ocrenv\Scripts\python.exe` instead. Missing or empty source
directories cause an error without changing the existing dataset.

The source hashes can be checked without OCR dependencies. Full OCR regeneration
requires the optional dependencies above; output can vary with OCR engine/model
versions. The committed dataset remains the version used by the server.

The generator uses DAY table pages and checks their OCR radio frequencies against
the existing radio dataset. NIGHT pages are not required. See
[verification notes](verification.md) for coverage and validation details.
