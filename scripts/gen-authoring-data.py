#!/usr/bin/env python3
"""Read pydcs as AST data only; never import or execute it.

python3 -I scripts/gen-authoring-data.py /tmp/dcs-reference data/authoring.json
Source: pydcs 1.0.0 (LGPL-3.0-or-later). Regenerate after catalogue updates.
"""
import ast
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]) / "dcs"
sources = {}

def tree(name):
    content = (root / name).read_bytes()
    sources[name] = hashlib.sha256(content).hexdigest()
    return ast.parse(content)

def assignments(node):
    return {n.targets[0].id: n.value for n in node.body
            if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)}

def literal(value, default=None):
    try:
        return ast.literal_eval(value)
    except (ValueError, TypeError):
        return default

weapons = {}
for node in tree("weapons_data.py").body:
    if isinstance(node, ast.ClassDef) and node.name == "Weapons":
        weapons = {k: literal(v) for k, v in assignments(node).items()}

aircraft = {}
for name in ("planes.py", "helicopters.py"):
    for node in tree(name).body:
        if not isinstance(node, ast.ClassDef):
            continue
        attrs = assignments(node)
        type_id = literal(attrs.get("id"))
        if not type_id:
            continue
        pylons = {}
        for pylon in node.body:
            if not isinstance(pylon, ast.ClassDef) or not pylon.name.startswith("Pylon"):
                continue
            for value in assignments(pylon).values():
                if not isinstance(value, ast.Tuple) or len(value.elts) != 2:
                    continue
                index, weapon = value.elts
                if isinstance(weapon, ast.Attribute) and isinstance(weapon.value, ast.Name) and weapon.value.id == "Weapons":
                    data = weapons.get(weapon.attr)
                    if data and "clsid" in data:
                        pylons.setdefault(str(literal(index)), set()).add(data["clsid"])
        entry = {"pylons": {k: sorted(v) for k, v in pylons.items()}}
        # flyingunit.py set_radio_preset copies panel_radio verbatim into unit["Radio"].
        frequency = literal(attrs.get("radio_frequency"))
        if isinstance(frequency, (int, float)):
            entry["radioFrequency"] = frequency
        panel = literal(attrs.get("panel_radio"))
        if isinstance(panel, dict) and panel:
            entry["panelRadio"] = {str(r): {"channels": {str(c): f for c, f in sorted(cfg.get("channels", {}).items())},
                                            **({"modulations": {str(c): m for c, m in sorted(cfg["modulations"].items())}} if "modulations" in cfg else {})}
                                   for r, cfg in sorted(panel.items())}
        # The Liveries/<folder> name pydcs's LiveryScanner matches (case-insensitively) for this type.
        # pydcs callnames: {country: [type-specific callsign names]}; used only to cross-check the
        # Hoggit wiki's numbered callsign lists (src/miz/callsigns.ts).
        annotated = {n.target.id: n.value for n in node.body
                     if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.value is not None}
        callnames = literal(annotated.get("callnames"))
        if isinstance(callnames, dict) and any(callnames.values()):
            entry["callnames"] = {k: v for k, v in callnames.items() if v}
        livery_name = literal(attrs.get("livery_name"))
        if isinstance(livery_name, str):
            entry["liveryName"] = livery_name
        aircraft[type_id] = entry

ships = {}
for node in tree("ships.py").body:
    if isinstance(node, ast.ClassDef):
        attrs = assignments(node)
        type_id = literal(attrs.get("id"))
        if type_id:
            ships[type_id] = {"parking": literal(attrs.get("parking"), 0)}

# cloud_presets.py: Clouds members are CloudPreset(name=, ui_name=, description=, min_base=, max_base=).
cloud_presets = {}
for node in tree("cloud_presets.py").body:
    if isinstance(node, ast.ClassDef) and node.name == "Clouds":
        for member, call in assignments(node).items():
            if isinstance(call, ast.Call):
                kw = {k.arg: literal(k.value) for k in call.keywords}
                if kw.get("name"):
                    cloud_presets[kw["name"]] = {"member": member, "uiName": kw.get("ui_name"), "description": kw.get("description"),
                                                 "minBase": kw.get("min_base"), "maxBase": kw.get("max_base")}

# task.py MainTask subclasses: internal_name -> numeric id. DCS UnitPayloads files name their
# tasks with these bare identifiers (pydcs FlyingType._UnitPayloadGlobals).
main_tasks = {}
for node in tree("task.py").body:
    if isinstance(node, ast.ClassDef) and any(getattr(b, "id", None) == "MainTask" for b in node.bases):
        attrs = assignments(node)
        internal, task_id, label = literal(attrs.get("internal_name")), literal(attrs.get("id")), literal(attrs.get("name"))
        if isinstance(internal, str) and isinstance(task_id, int):
            main_tasks[internal] = {"id": task_id, "name": label}

payload = {"_source": "pydcs 1.0.0, LGPL-3.0-or-later; generated as data, not DCS-verified",
           "_sha256": sources, "aircraft": aircraft, "ships": ships, "cloudPresets": cloud_presets, "mainTasks": main_tasks}
pathlib.Path(sys.argv[2]).write_text(json.dumps(payload, separators=(",", ":")) + "\n")
print(f"aircraft={len(aircraft)} ships={len(ships)} radios={sum(1 for a in aircraft.values() if 'panelRadio' in a)} cloudPresets={len(cloud_presets)}")
