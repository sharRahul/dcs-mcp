#!/usr/bin/env python3
"""Build data/airfield-radio.json: per-airfield ATC radio frequencies and runways, read from
pydcs's terrain/*/airports.py as AST DATA (never imported or executed).

    python3 -I scripts/gen-airfield-radio.py <pydcs-source-root> data/airfield-radio.json

pydcs 1.0.0 (LGPL-3.0-or-later) exports these from DCS. What it does and does NOT carry:
  - atc_radio: the tower's four radios (HF, VHF low, VHF high, UHF), in Hz.
  - runways: designators per end. pydcs derives each end's `heading` from the designator
    (RunwayApproach.from_lua: int(name) * 10), so it is a DESIGNATOR heading, not measured.
  - beacons: only ids (e.g. "airfield22_0"); pydcs has no TACAN/ILS/VOR/NDB frequencies,
    channels, elevation or magnetic variation. Those are not in this file.
"""
import ast
import hashlib
import json
import pathlib
import sys

THEATRE_DIRS = {
    "afghanistan": "Afghanistan", "caucasus": "Caucasus", "falklands": "Falklands",
    "germany": "GermanyCW", "kola": "Kola", "marianaislands": "MarianaIslands",
    "nevada": "Nevada", "normandy": "Normandy", "persiangulf": "PersianGulf",
    "sinai": "SinaiMap", "syria": "Syria", "thechannel": "TheChannel",
}


def lit(node, default=None):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError):
        return default


def kwargs(call):
    return {k.arg: k.value for k in call.keywords} if isinstance(call, ast.Call) else {}


def approach(call):
    kw = kwargs(call)
    return {"name": lit(kw.get("name")), "designatorHeading": lit(kw.get("heading")),
            "beaconIds": [lit(kwargs(b).get("id")) for b in getattr(kw.get("beacons"), "elts", [])]}


def main():
    root = pathlib.Path(sys.argv[1]) / "dcs" / "terrain"
    out = {}
    hashes = {}
    for folder, theatre in THEATRE_DIRS.items():
        path = root / folder / "airports.py"
        raw = path.read_bytes()
        hashes[f"terrain/{folder}/airports.py"] = hashlib.sha256(raw).hexdigest()
        airports = {}
        for node in ast.parse(raw).body:
            if not isinstance(node, ast.ClassDef) or not any(getattr(b, "id", None) == "Airport" for b in node.bases):
                continue
            attrs = {n.targets[0].id: n.value for n in node.body if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)}
            ap_id = lit(attrs.get("id"))
            if ap_id is None:
                continue
            entry = {"name": lit(attrs.get("name")), "civilian": lit(attrs.get("civilian"), True)}
            atc = kwargs(attrs.get("atc_radio"))
            if atc:
                entry["atcMHz"] = {k: round(lit(atc[f"{k}_hz"]) / 1e6, 6) for k in ("hf", "vhf_low", "vhf_high", "uhf")
                                   if lit(atc.get(f"{k}_hz")) is not None}
                entry["atcMHz"] = {{"vhf_low": "vhfLow", "vhf_high": "vhfHigh"}.get(k, k): v for k, v in entry["atcMHz"].items()}
            runways, beacons = [], []
            init = next((n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == "__init__"), None)
            for stmt in getattr(init, "body", []):
                call = getattr(stmt, "value", None)
                if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.args):
                    continue
                target = getattr(call.func.value, "attr", None)
                arg = call.args[0]
                if target == "runways" and call.func.attr == "append":
                    kw = kwargs(arg)
                    runways.append({"name": lit(kw.get("name")), "ends": [approach(kw.get("main")), approach(kw.get("opposite"))]})
                elif target == "beacons" and call.func.attr == "append":
                    beacons.append(lit(kwargs(arg).get("id")))
            entry["runways"] = runways
            entry["beaconIds"] = beacons
            airports[str(ap_id)] = entry
        out[theatre] = dict(sorted(airports.items(), key=lambda kv: int(kv[0])))
    payload = {
        "_source": "pydcs 1.0.0 terrain/*/airports.py (LGPL-3.0-or-later), exported by pydcs from DCS; generated as data. "
                   "Runway headings are designator x 10, not measured. No navaid frequencies, elevation or magnetic variation.",
        "_sha256": hashes,
        "theatres": out,
    }
    pathlib.Path(sys.argv[2]).write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    for t, a in out.items():
        print(f"{t}: airfields={len(a)} withATC={sum('atcMHz' in v for v in a.values())} runways={sum(len(v['runways']) for v in a.values())}")


if __name__ == "__main__":
    main()
