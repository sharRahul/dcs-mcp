#!/usr/bin/env python3
"""Build data/airfield-navaids.json from DimOn's "Aerodrome Data and Frequencies" kneeboards
(Dima Kozyrev; freeware, unlimited distribution), by OCR of the DAY table pages, gated by
pydcs's own airfield ATC frequencies.

    # one-off: python3 -m venv ocrenv && ocrenv/bin/pip install rapidocr-onnxruntime
    ocrenv/bin/python -I scripts/gen-airfield-navaids.py "docs/aerodrome data_01-feb-2026" data/airfield-radio.json data/airfield-navaids.json
(the 32 pinned DAY table images are tracked; the output records each source image's sha256).

A row is ACCEPTED only when:
  1. its OCR'd ATC block (VHF high + HF on line 1, UHF + VHF low on line 2) equals the four
     pydcs atc_radio frequencies of exactly ONE airfield of that theatre, and
  2. that airfield's pydcs name shares a word with the row's printed name.
That proves the row was read and aligned correctly. Values on an accepted row are kept only
when they pass their own checks:
  - elevation: feet and metres agree (|ft - m*3.28084| <= 4),
  - TACAN: "<1-126><X|Y>",
  - VOR: magenta ink, 108.00-117.95 MHz,
  - NDB: orange ink, 190-1750 kHz, no runway prefix,
  - ILS: green ink, 108.10-111.95 MHz with an odd tenth (ILS localiser channels).
ILS frequencies are listed per airfield, not tied to a runway: the runway block layout varies
by theatre and OCR does not keep it reliably. Rows that fail the gate are reported, not guessed.
The image directory's file names and sha256 hashes are recorded.
"""
import colorsys
import hashlib
import json
import pathlib
import re
import sys


THEATRES = {"Afghanistan": "Afghanistan", "Caucasus": "Caucasus", "Cold_War_Germany": "GermanyCW", "Kola": "Kola",
            "Mariana_Islands": "MarianaIslands", "Nevada": "Nevada", "Normandy": "Normandy", "Persian_Gulf": "PersianGulf",
            "Sinai": "SinaiMap", "South_Atlantic": "Falklands", "Syria": "Syria", "The_Channel": "TheChannel"}
COORD = re.compile(r"[NS]\d{1,2}°\d")
FREQ2 = re.compile(r"^(\d{2,3}\.\d{2,3})\s+(\d{1,2}\.\d{2,3})$")


def ocr(png):
    out = png.with_suffix(".json")
    if not out.exists():
        from rapidocr_onnxruntime import RapidOCR
        res, _ = RapidOCR()(str(png))
        json.dump([{"x": round(b[0][0]), "y": round(b[0][1]), "x2": round(b[2][0]), "y2": round(b[2][1]), "t": t,
                    "c": round(float(c), 3)} for b, t, c in (res or [])], open(out, "w"))
    return json.load(open(out))


def ink(img, box):
    """Dominant ink colour of a text box: hue name from its non-background pixels."""
    crop = img.crop((box["x"], box["y"], max(box["x2"], box["x"] + 1), max(box["y2"], box["y"] + 1))).convert("RGB")
    px = [p for p in list(crop.getdata()) if min(p) < 190]
    if not px:
        return "none"
    r, g, b = (sum(c[i] for c in px) / len(px) for i in range(3))
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    if s < 0.25:
        return "grey"
    deg = h * 360
    if deg < 20 or deg >= 300:
        return "magenta" if deg >= 300 or b > g else "red"
    if deg < 50:
        return "orange"
    if deg < 170:
        return "green"
    return "blue"


def to_lines(boxes, tol=12):
    """Cluster OCR boxes into text lines by vertical centre; each line sorted left to right."""
    lines = []
    for b in sorted(boxes, key=lambda b: (b["y"] + b["y2"]) / 2):
        c = (b["y"] + b["y2"]) / 2
        if lines and abs(lines[-1][0] - c) <= tol:
            lines[-1][1].append(b)
        else:
            lines.append([c, [b]])
    return [sorted(ln, key=lambda b: b["x"]) for _, ln in lines]


def atc_pair(text):
    """Two decimals from an ATC cell, ignoring stray integers; also splits '250.1538.55'."""
    text = re.sub(r"(\d{3}\.\d{2})(\d{2}\.\d{2,3})", r"\1 \2", text)
    nums = re.findall(r"\d{1,3}\.\d{2,3}", text)
    return (float(nums[0]), float(nums[1])) if len(nums) == 2 else None


def same_name(a, b):
    """Shared word, or close spelling once case/spaces/punctuation are removed (OCR confuses l/I)."""
    import difflib
    if words(a) & words(b):
        return True
    na = re.sub(r"[^a-z]", "", a.lower().replace("i", "l"))
    nb = re.sub(r"[^a-z]", "", b.lower().replace("i", "l"))
    if len(nb) >= 4 and (nb in na or na in nb):
        return True
    return difflib.SequenceMatcher(None, na[:len(nb) + 4], nb).ratio() >= 0.8


def words(s):
    return {w for w in re.findall(r"[a-z]{4,}", s.lower())}


def main():
    if len(sys.argv) != 4:
        raise SystemExit("Usage: gen-airfield-navaids.py docs/aerodrome data_01-feb-2026 <radio.json> <output.json>")
    src, radio_path, out = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    pages = sorted(src.glob("04_AD_Day_*.png")) if src.is_dir() else []
    if not pages:
        raise SystemExit(f"No day-page PNG images found in {src}; supply an external PNG directory. Existing output was not changed.")
    from PIL import Image

    radio = json.load(open(radio_path, encoding="utf-8"))["theatres"]
    result, report, hashes = {}, {}, {}
    for png in pages:
        m = re.match(r"04_AD_Day_(.+)_\d+$", png.stem)
        theatre = THEATRES.get(m.group(1)) if m else None
        if not theatre:
            continue
        boxes = ocr(png)
        if sum(1 for b in boxes if COORD.search(b["t"])) < 3:
            continue  # map / extras page, not a table
        hashes[png.name] = hashlib.sha256(png.read_bytes()).hexdigest()
        img = Image.open(png)
        lines = to_lines(boxes)
        # Row anchor: the coordinate line ("GE N41°36'..."); the name line is the line just above it.
        coord_idx = [i for i, ln in enumerate(lines) if ln[0]["x"] < 120 and COORD.search(" ".join(b["t"] for b in ln))]
        pyd = radio.get(theatre, {})
        rep = report.setdefault(theatre, {"rows": 0, "accepted": 0, "rejected": []})
        for n, ci in enumerate(coord_idx):
            if ci == 0:
                continue
            name_line, coord_line = lines[ci - 1], lines[ci]
            # The row ends at the next line that starts in the name column (the next airfield, even
            # when OCR missed that airfield's coordinate line) or at the next coordinate line.
            end = ci + 1
            while end < len(lines) and not (lines[end][0]["x"] < 120 and lines[end][0]["t"].strip()):
                end += 1
            row = [b for ln in lines[ci - 1:end] for b in ln]
            rep["rows"] += 1
            name = re.sub(r"^(\d{1,3}|--)\s+", "", " ".join(b["t"] for b in name_line if b["x"] < 470)).strip()
            cell = lambda ln, lo, hi: " ".join(b["t"].strip() for b in ln if lo <= b["x"] <= hi)
            l1, l2 = atc_pair(cell(name_line, 640, 860)), atc_pair(cell(coord_line, 640, 860))
            if not (l1 and l2 and 100 <= l1[0] <= 160 and 2 <= l1[1] <= 30 and 220 <= l2[0] <= 400 and 30 <= l2[1] <= 88):
                rep["rejected"].append(f"{name}: ATC block not read cleanly ({cell(name_line, 640, 860)!r} / {cell(coord_line, 640, 860)!r})")
                continue
            (vh, hf), (uhf, vl) = l1, l2
            hits = [k for k, v in pyd.items() if v.get("atcMHz") and
                    [round(v["atcMHz"].get(f, -1), 3) for f in ("vhfHigh", "hf", "uhf", "vhfLow")] == [vh, hf, uhf, vl]]
            # The name only chooses AMONG exact ATC matches (OCR misreads letters: "AIta" for Alta).
            named = [k for k in hits if same_name(name, pyd[k]["name"])]
            if not hits:
                rep["rejected"].append(f"{name}: ATC {vh}/{hf}/{uhf}/{vl} differs from every pydcs airfield")
                continue
            if len(named) != 1:
                rep["rejected"].append(f"{name}: ATC matches {[pyd[k]['name'] for k in hits]} but the name does not single one out")
                continue
            ap_id = named[0]
            entry = {"dimonName": name, "sourcePage": png.name}
            icao = re.search(r"\b([A-Z]{2}[A-Z0-9]{2})\b", name)
            if icao and icao.group(1) != "HELI":
                entry["icao"] = icao.group(1)
            # Elevation: two integers stacked in the 480..570 column.
            elev = sorted((b for b in name_line + coord_line if 470 <= b["x"] <= 570 and re.fullmatch(r"-?\d{1,5}", b["t"].strip())), key=lambda b: b["y"])
            if len(elev) >= 2:
                ft, mt = int(elev[0]["t"]), int(elev[1]["t"])
                if abs(ft - mt * 3.28084) <= 4:
                    entry["elevation"] = {"ft": ft, "m": mt}
            nav = [b for b in row if 550 <= (b["x"] + b["x2"]) / 2 <= 700]  # centre: VORs start at x≈557
            for b in nav:
                t = b["t"].strip()
                if re.fullmatch(r"(\d{1,3})([XY])", t) and 1 <= int(t[:-1]) <= 126:
                    entry.setdefault("tacan", []).append(t)
                elif re.fullmatch(r"1[01]\d\.\d{2}", t) and 108.0 <= float(t) <= 117.95 and ink(img, b) == "magenta":
                    entry.setdefault("vorMHz", []).append(float(t))
                elif re.fullmatch(r"\d{3,4}", t) and 190 <= int(t) <= 1750 and ink(img, b) == "orange":
                    entry.setdefault("ndbKHz", []).append(int(t))
            for b in row:
                if b["x"] < 860:
                    continue
                for f in re.findall(r"1(?:0[89]|1[01])\.\d0|1(?:0[89]|1[01])\.\d5", b["t"]):
                    v = float(f)
                    tenth = int(round(v * 10)) % 10
                    if 108.1 <= v <= 111.95 and tenth % 2 == 1 and ink(img, b) == "green":
                        entry.setdefault("ilsMHz", [])
                        if v not in entry["ilsMHz"]:
                            entry["ilsMHz"].append(v)
            result.setdefault(theatre, {})[ap_id] = entry
            rep["accepted"] += 1
    payload = {
        "_source": "DimOn 'Aerodrome Data and Frequencies' kneeboards (Dima Kozyrev, updated 01 February 2026; freeware, "
                   "unlimited distribution), DAY table pages, by OCR. Rows kept only where the OCR'd ATC frequencies match "
                   "exactly one pydcs airfield; each value passes its own format/colour check. Not ME- or flight-verified.",
        "_images_sha256": hashes,
        "_inputs": "DAY table pages (04_AD_Day_<theatre>_NN.png) of the 01 February 2026 release, from a user-provided copy; "
                   "Iraq and Marianas WWII are skipped (no pydcs ATC data to gate them).",
        "_report": report,
        "theatres": {t: dict(sorted(v.items(), key=lambda kv: int(kv[0]))) for t, v in sorted(result.items())},
    }
    pathlib.Path(out).write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    for t, r in sorted(report.items()):
        print(f"{t}: rows={r['rows']} accepted={r['accepted']} pydcsWithATC={sum(1 for v in radio[t].values() if v.get('atcMHz'))}")


if __name__ == "__main__":
    main()
