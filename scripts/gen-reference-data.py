#!/usr/bin/env python3
"""
Regenerate data/*.json from a pydcs source tree.

pydcs (https://github.com/pydcs/dcs, LGPL-3.0-or-later) generates its unit,
country and airfield tables from DCS itself via `pydcs_export.lua`. We read
those generated files as TEXT - nothing is imported or executed - and keep only
the facts the authoring tools need:

  data/countries.json   DCS country ids and names
  data/theatres.json    per-theatre transverse-Mercator projection + airfields
                        (id, name, position, parking slots)
  data/unit-types.json  type ids per category (+ static-object shape/category,
                        aircraft tasks/fuel/countermeasures)

Usage (pydcs is not a dependency; download the wheel and unzip it):

  pip download --no-deps pydcs -d /tmp/pydcs && cd /tmp/pydcs && unzip -q *.whl
  python3 -I scripts/gen-reference-data.py /tmp/pydcs data

Run with -I so nothing from the pydcs tree can shadow a stdlib module.
"""
import json
import os
import re
import sys

if len(sys.argv) != 3:
    sys.exit(__doc__)

SRC = os.path.join(sys.argv[1], "dcs")
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)


def read(*parts):
    with open(os.path.join(SRC, *parts), encoding="utf-8") as f:
        return f.read()


def literal(raw):
    raw = raw.strip()
    if raw in ("True", "False"):
        return raw == "True"
    if raw == "None":
        return None
    if raw.startswith('"') or raw.startswith("'"):
        return json.loads('"' + raw[1:-1].replace('\\"', '"').replace('"', '\\"') + '"')
    try:
        return float(raw) if "." in raw else int(raw)
    except ValueError:
        return raw


def class_blocks(text, indent):
    """Yield (class_name, body) for classes at a given indent."""
    pat = re.compile(r"^" + " " * indent + r"class (\w+)(?:\(([^)]*)\))?:\n", re.M)
    matches = list(pat.finditer(text))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        yield m.group(1), m.group(2) or "", text[m.end():end]


def attrs(body, indent):
    out = {}
    for m in re.finditer(r"^" + " " * indent + r"(\w+) = (.+?)\s*(#.*)?$", body, re.M):
        out.setdefault(m.group(1), m.group(2))
    return out


# --- class name -> DCS type id, per pydcs module ---------------------------------
def class_ids(file, nested_level):
    out = {}
    for name, _b, body in class_blocks(read(file), 0):
        if nested_level == 0:
            a = attrs(body, 4)
            if "id" in a:
                out[name] = literal(a["id"])
        else:
            for inner, _ib, ibody in class_blocks(body, 4):
                a = attrs(ibody, 8)
                if "id" in a:
                    out[f"{name}.{inner}"] = literal(a["id"])
    return out


MODULE_IDS = {
    "planes": class_ids("planes.py", 0),
    "helicopters": class_ids("helicopters.py", 0),
    "ships": class_ids("ships.py", 0),
    "vehicles": class_ids("vehicles.py", 1),
}

# --- countries ----------------------------------------------------------------
# Each country also lists the unit types the Mission Editor offers for it. This
# is DCS's own (permissive) list, not a real-world order of battle: Russia is
# offered an A-10C. Real-world inventories come from data/real-world-inventory.json.
REF = re.compile(r"= (planes|helicopters|ships|vehicles)\.([\w.]+)")
countries = []
for name, _base, body in class_blocks(read("countries.py"), 0):
    a = attrs(body, 4)
    if "id" not in a or "name" not in a:
        continue
    units = {"plane": [], "helicopter": [], "ship": [], "vehicle": []}
    key = {"planes": "plane", "helicopters": "helicopter", "ships": "ship", "vehicles": "vehicle"}
    for mod, ref in REF.findall(body):
        type_id = MODULE_IDS[mod].get(ref)
        if type_id is not None and type_id not in units[key[mod]]:
            units[key[mod]].append(type_id)
    countries.append({
        "id": literal(a["id"]),
        "name": literal(a["name"]),
        "short": literal(a.get("shortname", '""')),
        "units": units,
    })
countries.sort(key=lambda c: c["id"])

# --- tasks: class name -> DCS task string --------------------------------------
task_names = {}
for name, _base, body in class_blocks(read("task.py"), 0):
    a = attrs(body, 4)
    if "name" in a and "MainTask" in _base:
        task_names[name] = literal(a["name"])

# --- unit types -----------------------------------------------------------------
def flying(file):
    out = []
    for name, base, body in class_blocks(read(file), 0):
        if "PlaneType" not in base and "HelicopterType" not in base:
            continue
        a = attrs(body, 4)
        if "id" not in a:
            continue
        tasks = re.findall(r"task\.(\w+)", a.get("tasks", ""))
        default = re.findall(r"task\.(\w+)", a.get("task_default", ""))
        out.append({
            "type": literal(a["id"]),
            "fuelMax": literal(a["fuel_max"]) if "fuel_max" in a else None,
            "width": literal(a["width"]) if "width" in a else None,
            "length": literal(a["length"]) if "length" in a else None,
            "height": literal(a["height"]) if "height" in a else None,
            "chaff": literal(a["chaff"]) if "chaff" in a else None,
            "flare": literal(a["flare"]) if "flare" in a else None,
            "tasks": [task_names[t] for t in tasks if t in task_names],
            "defaultTask": task_names.get(default[0]) if default else None,
        })
    return out


def nested(file, base_name):
    out = []
    for group, _b, gbody in class_blocks(read(file), 0):
        for name, base, body in class_blocks(gbody, 4):
            if base_name not in base:
                continue
            a = attrs(body, 8)
            if "id" not in a:
                continue
            entry = {"type": literal(a["id"]), "name": literal(a.get("name", a["id"])), "group": group}
            if base_name == "StaticType":
                entry["shape"] = literal(a["shape_name"]) if "shape_name" in a else None
                entry["category"] = literal(a["category"]) if "category" in a else "Fortifications"
                entry["rate"] = literal(a["rate"]) if "rate" in a else 0
                entry["canCargo"] = literal(a["can_cargo"]) if "can_cargo" in a else False
            out.append(entry)
    return out


ships = []
for name, base, body in class_blocks(read("ships.py"), 0):
    a = attrs(body, 4)
    if "ShipType" in base and "id" in a:
        ships.append({"type": literal(a["id"]), "name": literal(a.get("name", a["id"]))})

unit_types = {
    "plane": flying("planes.py"),
    "helicopter": flying("helicopters.py"),
    "vehicle": nested("vehicles.py", "VehicleType"),
    "ship": ships,
    "static": nested("statics.py", "StaticType"),
}

# --- theatres --------------------------------------------------------------------
THEATRE_DIRS = {
    "afghanistan": "Afghanistan", "caucasus": "Caucasus", "falklands": "Falklands",
    "germany": "GermanyCW", "kola": "Kola", "marianaislands": "MarianaIslands",
    "nevada": "Nevada", "normandy": "Normandy", "persiangulf": "PersianGulf",
    "sinai": "SinaiMap", "syria": "Syria", "thechannel": "TheChannel",
}

POINT = r"mapping\.Point\(([-\d.e]+), ([-\d.e]+)"
SLOT = re.compile(
    r"ParkingSlot\(\s*crossroad_idx=(\d+), position=" + POINT + r"[^)]*\), large=(\w+), heli=(\w+),\s*"
    r"airplanes=(\w+), slot_name='([^']*)', length=([-\d.e]+), width=([-\d.e]+), height=([-\d.e]+), shelter=(\w+)"
)

theatres = {}
for folder, theatre in THEATRE_DIRS.items():
    proj_src = read("terrain", folder, "projection.py")
    proj = {k: float(v) for k, v in re.findall(r"(\w+)=([-\d.e]+)", proj_src)}
    airports = []
    for name, base, body in class_blocks(read("terrain", folder, "airports.py"), 0):
        if "Airport" not in base:
            continue
        a = attrs(body, 4)
        pos = re.search(r"super\(\).__init__\(" + POINT, body)
        if "id" not in a or not pos:
            continue
        slots = []
        for s in SLOT.finditer(body):
            flags = (1 if s.group(4) == "True" else 0) | (2 if s.group(5) == "True" else 0) \
                | (4 if s.group(6) == "True" else 0) | (8 if s.group(11) == "True" else 0)
            # [parking (crossroad idx), parking_id (slot name), x, y, flags, width, length, height]
            slots.append([int(s.group(1)), s.group(7), round(float(s.group(2)), 1),
                          round(float(s.group(3)), 1), flags, round(float(s.group(9)), 1),
                          round(float(s.group(8)), 1), round(float(s.group(10)), 1)])
        airports.append({
            "id": literal(a["id"]),
            "name": literal(a["name"]),
            "x": round(float(pos.group(1)), 1),
            "y": round(float(pos.group(2)), 1),
            "slots": slots,
        })
    airports.sort(key=lambda ap: ap["id"])
    theatres[theatre] = {
        "projection": {
            "centralMeridian": proj["central_meridian"],
            "falseEasting": proj["false_easting"],
            "falseNorthing": proj["false_northing"],
            "scaleFactor": proj["scale_factor"],
        },
        "airports": airports,
    }

SOURCE = "Generated by scripts/gen-reference-data.py from pydcs (LGPL-3.0-or-later), which exports it from DCS."


def dump(name, payload):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump({"_source": SOURCE, **payload}, f, separators=(",", ":"), ensure_ascii=False)
        f.write("\n")


dump("countries.json", {"countries": countries})
dump("unit-types.json", unit_types)
dump("theatres.json", {"theatres": theatres})

print(f"countries={len(countries)} " + " ".join(f"{k}={len(v)}" for k, v in unit_types.items()))
for t, d in theatres.items():
    print(f"  {t}: airports={len(d['airports'])} slots={sum(len(a['slots']) for a in d['airports'])}")
