#!/usr/bin/env python3
"""Build data/hoggit.json from the Hoggit DCS scripting wiki, as DATA only.

    python3 -I scripts/data/gen-hoggit-data.py --fetch <cache-dir> data/hoggit.json
    python3 -I scripts/data/gen-hoggit-data.py <cache-dir> data/hoggit.json   # reuse cache

Source: https://wiki.hoggitworld.com (raw wikitext via ?action=raw, one request at a time,
with back-off; the wiki answers 503 to bursts). The wiki states no content licence, so only
FACTS are kept: action ids, parameter names and declared types, required parameters,
applicability, option ids and enum values, callsign numbers. No prose is copied. Every page's
revision id is recorded so a regeneration shows what changed.

The wiki documents the scripting API (Controller:setTask/setCommand/setOption). Mission-file
waypoint tasks use the same {id, params} tables (commands/options wrapped in WrappedAction),
but the Mission Editor can write extra fields. Nothing here is Mission-Editor verified.
"""
import json
import os
import pathlib
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request

WIKI = "https://wiki.hoggitworld.com"
CATEGORY_FOR = {"Aircraft Task": "plane", "Helicopter Task": "helicopter", "Ground Task": "vehicle", "Naval Task": "ship"}
FOR_WORDS = {"airplane": "plane", "aircraft": "plane", "helicopter": "helicopter", "ground veh": "vehicle", "ship": "ship"}
STRUCTURAL = {"DCS task comboTask", "DCS task controlledTask", "DCS task wrappedAction", "DCS task mission"}
CALLSIGN_TEMPLATES = ["aircraft", "a10", "ah64", "f16", "f18", "f15e", "b1b", "b52", "transport", "awacs", "tanker", "jtac"]
ENUM_TEMPLATES = ["DCS_enum_air_options", "DCS_enum_ground_options", "DCS_enum_naval_options",
                  "DCS_enum_Air_val_ROE", "DCS_enum_Air_val_ReactionToThreat", "DCS_enum_Air_val_RadarUsing",
                  "DCS_enum_Air_val_FlareUsing", "DCS_enum_Air_val_ECM", "DCS_enum_Air_val_missileAttack",
                  "DCS_enum_ground_val_AlarmState", "DCS_enum_ground_val_ROE", "DCS_enum_naval_val_ROE",
                  "DCS_enum_AI_orbitPattern", "DCS_enum_AI_turnMethod", "DCS_enum_AI_vehicleFormation",
                  "DCS_enum_AI_altitudeType", "DCS_enum_AI_waypointType", "DCS_enum_AI_expend_list",
                  "DCS_enum_AI_designate_list", "DCS_enum_formation_table"]


def ctx():
    return ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)


def get(url):
    for attempt in range(7):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "dcs-mcp-data-generator/1"})
            with urllib.request.urlopen(req, context=ctx(), timeout=60) as r:
                body = r.read().decode("utf-8")
            if "503 Service Temporarily" not in body:
                time.sleep(1.5)
                return body
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        time.sleep(4 * (attempt + 1))
    raise RuntimeError(f"giving up on {url}")


def fname(title):
    return re.sub(r"[ :/]", "_", title) + ".txt"


def fetch(cache):
    cache.mkdir(parents=True, exist_ok=True)
    members = json.loads(get(f"{WIKI}/api.php?action=query&list=categorymembers&cmtitle=Category:Tasks&cmlimit=500&format=json"))
    titles = sorted(m["title"] for m in members["query"]["categorymembers"]) + ["DCS enum callsigns"]
    titles += [f"Template:DCS_enum_callsigns_{t}" for t in CALLSIGN_TEMPLATES] + [f"Template:{t}" for t in ENUM_TEMPLATES]
    for t in titles:
        body = get(f"{WIKI}/view/{urllib.parse.quote(t.replace(' ', '_'))}?action=raw")
        if body is not None:
            (cache / fname(t)).write_text(body, encoding="utf-8")
    revs = {}
    for i in range(0, len(titles), 40):
        q = urllib.parse.quote("|".join(titles[i:i + 40]))
        data = json.loads(get(f"{WIKI}/api.php?action=query&prop=revisions&rvprop=ids|timestamp&format=json&titles={q}"))
        for page in data["query"]["pages"].values():
            if "revisions" in page:
                revs[page["title"].replace("_", " ")] = {"revid": page["revisions"][0]["revid"], "timestamp": page["revisions"][0]["timestamp"]}
    (cache / "_revisions.json").write_text(json.dumps(revs, indent=1, sort_keys=True))


def field(text, name):
    m = re.search(r"^\|\s*" + name + r"\s*=(.*?)(?=^\|\s*[a-zA-Z]+\s*=|\Z)", text, re.S | re.M)
    return m.group(1).strip() if m else ""


def enum_lines(text):
    """NAME = value lines (value int or quoted string). Comments after -- are dropped."""
    out = {}
    for line in text.splitlines():
        line = line.split("--")[0]
        m = re.match(r'^\s*"?([A-Za-z_][A-Za-z0-9_ ]*?)"?\s*=\s*("?)([^",]+)\2\s*,?\s*$', line)
        if m:
            raw = m.group(3).strip()
            out[m.group(1).strip()] = int(raw) if re.fullmatch(r"-?\d+", raw) else raw
    return out


def parse_formation(text):
    """Fixed-wing and helicopter formation codes from Template:DCS_enum_formation_table."""
    result = {}
    for section, body in re.findall(r"'''(Fixed Wing|Helicopter)'''\s*\{\|(.*?)\|\}", text, re.S):
        rows = [[c.strip() for c in re.split(r"\n\|", "\n" + r)[1:]] for r in body.split("|-")[1:]]
        header = [c for c in rows[0][1:]]
        values = {}
        for row in rows[1:]:
            label = re.sub(r'style="[^"]*"\|', "", row[0])
            for name, cell in zip(header, row[1:]):
                if re.fullmatch(r"\d+", cell):
                    values[f"{name} {label}".strip()] = int(cell)
        result["plane" if section == "Fixed Wing" else "helicopter"] = values
    return result


def params_of(form):
    block = re.search(r"params\s*=\s*\{(.*)\}\s*\}", form, re.S)
    params = {}
    if block:
        depth = 0
        for line in block.group(1).splitlines():
            if depth == 0:
                m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=+\s*(.*?)\s*,?\s*$", line)
                if m:
                    params[m.group(1)] = re.sub(r"^=\s*", "", m.group(2)).rstrip(",").strip() or "table"
            depth += line.count("{") - line.count("}")
    return params


def required_of(form, params):
    m = re.search(r"'''Required parameters'''\s*:?(.*?)(?:'''Optional Parameters'''|\Z)", form, re.S | re.I)
    if not m:
        return []
    # "name: text", "name = ..." or a bare "name" line; matched to the form's params case-insensitively.
    names = re.findall(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:[:=]|$)", m.group(1), re.M)
    by_lower = {p.lower(): p for p in params}
    return [by_lower[n.lower()] for n in dict.fromkeys(names) if n.lower() in by_lower]


def option_values(form, enum, templates):
    text = form + "\n" + enum
    for ref in re.findall(r"\{\{\s*(?:Template:)?(DCS_enum_[A-Za-z_]+?val[A-Za-z_]*)\s*\}\}", enum):
        if ref in templates:
            return {"kind": "enum", "values": templates[ref]}
    if "DCS_enum_formation_table" in enum:
        return {"kind": "formation", "values": templates["DCS_enum_formation_table"]}
    values = form.split("Option Values", 1)[-1]
    if re.search(r"^\s*true\s*$", values, re.M) and re.search(r"^\s*false\s*$", values, re.M):
        return {"kind": "boolean"}
    m = re.search(r"(\d+)\s*(?:to|-)\s*(\d+)", values)
    if m:
        return {"kind": "range", "min": int(m.group(1)), "max": int(m.group(2))}
    listed = dict((int(n), label.strip()) for n, label in re.findall(r"^\s*(\d+)\s*:\s*(.+)$", values, re.M))
    if listed:
        return {"kind": "enum", "values": {v: k for k, v in listed.items()}}
    if "attribute" in values.lower():
        return {"kind": "attributes"}
    if "dispersal time" in values.lower():
        return {"kind": "number_or_false"}
    if "weapons.flag" in values.lower() or "weapon" in text.lower() and "flag" in text.lower():
        return {"kind": "weapon_flag"}
    if "number" in values.lower():
        return {"kind": "number"}
    return {"kind": "unknown"}


def option_ids(form, enum, id_tables):
    """Numeric option id per domain: id-table lookups first, then the page's own number."""
    ids = {}
    # The page's own "NAME = n" enum line wins when the id table confirms that exact pair
    # (DCS option forcedAttack names JETT_TANKS_IF_EMPTY in its form but FORCED_ATTACK = 26).
    for name, num in re.findall(r"(?:AI\.Option\.(?:Air|Ground|Naval)\.id\.)?([A-Z][A-Z_]+)\s*=\s*(\d+)", enum):
        for domain, table in id_tables.items():
            if table.get(name) == int(num):
                ids[domain] = int(num)
    if ids:
        page_num = re.search(r"=\s*(\d+)", enum)
        return ids, int(page_num.group(1)) if page_num else None
    for domain, name in re.findall(r"AI\.Option\.(Air|Ground|GROUND|Naval)\.id\.([A-Z_]+)", form):
        domain = domain.capitalize()
        table = {k.upper(): v for k, v in id_tables.get(domain, {}).items()}
        if name.upper() in table:
            ids[domain] = table[name.upper()]
    page_num = re.search(r"=\s*(\d+)", enum) or re.search(r"^\s*(\d+)\s*$", enum, re.M) or re.search(r"Option Identifier:\s*(\d+)", form)
    return ids, int(page_num.group(1)) if page_num else None


def main():
    args = sys.argv[1:]
    do_fetch = args and args[0] == "--fetch"
    if do_fetch:
        args = args[1:]
    cache, out = pathlib.Path(args[0]), pathlib.Path(args[1])
    if do_fetch:
        fetch(cache)
    raw = {p.name: p.read_text(encoding="utf-8") for p in cache.glob("*.txt")}
    revs = json.loads((cache / "_revisions.json").read_text())
    tpl = {}
    for t in ENUM_TEMPLATES:
        body = raw.get(fname(f"Template:{t}"))
        if body is not None:
            tpl[t] = parse_formation(body) if t == "DCS_enum_formation_table" else enum_lines(body)
    id_tables = {"Air": tpl["DCS_enum_air_options"], "Ground": tpl["DCS_enum_ground_options"], "Naval": tpl["DCS_enum_naval_options"]}
    domain_of = {"plane": "Air", "helicopter": "Air", "vehicle": "Ground", "ship": "Naval"}

    actions, warnings = {}, []
    for name, text in sorted(raw.items()):
        title = name[:-4].replace("_", " ")
        if not title.startswith(("DCS task", "DCS command", "DCS option")) or title in STRUCTURAL:
            continue
        kind = "option" if title.startswith("DCS option") else "command" if title.startswith("DCS command") else "task"
        cats = sorted({CATEGORY_FOR[c] for c in re.findall(r"\[\[Category:([^|\]]+)", text) if c in CATEGORY_FOR})
        words = field(text, "for").lower()
        declared = sorted({c for k, c in FOR_WORDS.items() if k in words})
        if not cats and declared:
            # No category tags: fall back to the page's own "for" field (recorded as such).
            cats = declared
            warnings.append(f"{title}: categories from |for= ({', '.join(cats)})")
        elif cats and declared and not set(cats) & set(declared):
            # Tags contradict the page text (copied tags); the page's own "for" wins.
            warnings.append(f"{title}: category tags {cats} contradict |for= {declared}; |for= kept")
            cats = declared
        form, enum = field(text, "form"), field(text, "enum")
        entry = {"page": f"{WIKI}/view/{title.replace(' ', '_')}", "revid": revs.get(title, {}).get("revid"),
                 "kind": kind, "taskType": re.sub(r"\[\[[^|\]]*\|([^\]]+)\]\]", r"\1", field(text, "type")),
                 "categories": cats, "since": field(text, "vNum")}
        if kind == "option":
            ids, page_num = option_ids(form, enum, id_tables)
            for cat in cats:
                d = domain_of[cat]
                if d not in ids and page_num is not None:
                    ids[d] = page_num
            if page_num is not None and any(v != page_num for v in ids.values()) and len(set(ids.values())) == 1:
                warnings.append(f"{title}: page number {page_num} disagrees with id table {ids}; id table kept")
            entry["optionIds"] = ids
            entry["values"] = option_values(form, enum, tpl)
            # ROE values differ per domain.
            if title == "DCS option roe":
                entry["valuesByDomain"] = {"Air": tpl["DCS_enum_Air_val_ROE"], "Ground": tpl["DCS_enum_ground_val_ROE"], "Naval": tpl["DCS_enum_naval_val_ROE"]}
            key = "option:" + title[len("DCS option "):].replace(" ", "_")
        else:
            m = re.search(r"id\s*=\s*['\"]\s*([A-Za-z0-9_]+)\s*['\"]", form)
            if not m:
                warnings.append(f"{title}: no id in form, skipped")
                continue
            entry["id"] = m.group(1)
            entry["params"] = params_of(form)
            entry["required"] = required_of(form, entry["params"])
            key = entry["id"] if entry["id"] not in actions else f"{entry['id']}:{title.split()[-1]}"
        if not cats:
            warnings.append(f"{title}: no category tags")
        actions[key] = entry

    def callsigns(t):
        body = raw.get(fname(f"Template:DCS_enum_callsigns_{t}"), "")
        lines = body.splitlines()
        return {"label": lines[0].strip() if lines else t,
                "names": {int(n): label.strip() for n, label in re.findall(r"^\s*(\d+)\s+(.+?)\s*$", body, re.M)}}

    payload = {
        "_source": "Hoggit DCS wiki (wiki.hoggitworld.com) raw pages; facts only (ids, parameter names/types, enums, numbers). "
                   "Scripting-API documentation, not Mission-Editor or flight verified.",
        "_revisions": {k: v for k, v in sorted(revs.items())},
        "_warnings": warnings,
        "enums": {k: v for k, v in tpl.items() if k != "DCS_enum_formation_table"},
        "formations": tpl.get("DCS_enum_formation_table", {}),
        "actions": dict(sorted(actions.items())),
        "callsigns": {t: callsigns(t) for t in CALLSIGN_TEMPLATES},
    }
    out.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"actions={len(actions)} options={sum(a['kind'] == 'option' for a in actions.values())} warnings={len(warnings)}")
    for w in warnings:
        print("  warn:", w)


if __name__ == "__main__":
    main()
