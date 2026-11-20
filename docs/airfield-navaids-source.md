# Airfield navigation data sources

DCS MCP includes the generated `data/airfield-navaids.json`. Users do not need
the original chart images to install the server or create missions.

The source charts are **Aerodrome Data and Frequencies**, dated 01 February 2026,
by **Dima Kozyrev (DimOn)**. The author's DCS user-files listing describes the
licence as “Freeware — free version, unlimited distribution”. See the
[author's forum topic](https://forum.dcs.world/topic/269908-aerodrome-data-and-frequencies/)
for the source. The original chart images are kept outside GitHub and the npm package.

Only contributors regenerating this dataset need a separate copy of that release.
Extract the DAY PNG pages to a directory outside the repository. The generated
JSON retains the SHA-256 hashes of the table images used, under `_images_sha256`,
so contributors can compare their source copy with the original inputs.

With Python, Pillow and `rapidocr-onnxruntime` installed in an OCR virtual environment, run:

```sh
ocrenv/bin/python -I scripts/gen-airfield-navaids.py "<external PNG directory>" data/airfield-radio.json data/airfield-navaids.json
```

On Windows, use `ocrenv\Scripts\python.exe` instead. Replace the directory
placeholder with the location of the extracted images. Missing or empty source
directories cause an error without changing the existing dataset.

The generator uses DAY table pages and checks their OCR radio frequencies against
the existing radio dataset. NIGHT pages are not required. See
[verification notes](verification.md) for coverage and validation details.
