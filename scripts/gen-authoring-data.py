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
        aircraft[type_id] = {"pylons": {k: sorted(v) for k, v in pylons.items()}}

ships = {}
for node in tree("ships.py").body:
    if isinstance(node, ast.ClassDef):
        attrs = assignments(node)
        type_id = literal(attrs.get("id"))
        if type_id:
            ships[type_id] = {"parking": literal(attrs.get("parking"), 0)}

payload = {"_source": "pydcs 1.0.0, LGPL-3.0-or-later; generated as data, not DCS-verified",
           "_sha256": sources, "aircraft": aircraft, "ships": ships}
pathlib.Path(sys.argv[2]).write_text(json.dumps(payload, separators=(",", ":")) + "\n")
print(f"aircraft={len(aircraft)} ships={len(ships)}")
