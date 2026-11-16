#!/usr/bin/env python3
"""Build data/me-manual-actions.json: the Mission Editor's own waypoint-action menus per
group type, from the table of contents of the DCS User Manual (Eagle Dynamics), as DATA.

    pdftotext -layout DCS_User_Manual_EN_2020.pdf manual.txt
    python3 -I scripts/gen-me-manual-actions.py manual.txt <sha256-of-pdf> data/hoggit.json data/me-manual-actions.json

Source PDF: https://www.digitalcombatsimulator.com/upload/iblock/ed6/87v22jwd1xh51i3rgki944xsf503istq/DCS_User_Manual_EN_2020.pdf
(title "DCS user manual", created 2022-07-27). Only menu LABELS and their grouping are kept.

An editor label is linked to a Hoggit catalogue action ONLY by literal name match after
normalising case, spaces, punctuation and a "(...)" suffix, optionally with a "Set" prefix
("Invisible" -> SetInvisible). Anything else (e.g. "Search Then Engage", "Chaff - Flare
Using") stays unmapped: mapping it would be a guess.
"""
import json
import re
import sys

# The manual has ONE chapter for aeroplanes and helicopters together: it cannot tell them apart.
SECTIONS = {"ADVANCED ACTIONS MODE (AIRCRAFT GROUPS)": ["aircraft"],
            "ADVANCED ACTIONS MODE (NAVAL GROUPS)": ["ship"],
            "ADVANCED ACTIONS MODE (GROUND GROUPS)": ["vehicle"]}
MENUS = {"Perform Task": "task", "Start Enroute Task": "enroute", "Perform Command": "command", "Set Option": "option"}
STOP = re.compile(r"^(PLACE |CREATE |AREA |UNIT LIST|DELETE |MAP OPTIONS|DISTANCE TOOL|EXIT |CAMPAIGN)")


def norm(s):
    s = re.sub(r"\(.*?\)", "", s)
    return re.sub(r"[^a-z0-9]", "", s.lower())


def toc_lines(text):
    """Table-of-contents entries: 'Label ........ 123' -> 'Label'."""
    toc = text[: text.find("MAIN MENU\n", text.find("EXIT"))]
    for raw in toc.splitlines():
        m = re.match(r"^\s*(.+?)\s*\.{3,}\s*\d+\s*$", raw) or re.match(r"^\s*(.+?)\s{2,}\d+\s*$", raw)
        if m:
            yield m.group(1).strip()


def main():
    manual, sha, hoggit, out = sys.argv[1:5]
    text = open(manual, encoding="utf-8", errors="replace").read()
    actions = json.load(open(hoggit, encoding="utf-8"))["actions"]
    index = {}
    for key, a in actions.items():
        name = key[len("option:"):] if key.startswith("option:") else a["id"]
        index.setdefault(norm(name), key)
    groups, section, menu = {}, None, None
    for label in toc_lines(text):
        if label in SECTIONS:
            section, menu = label, None
            continue
        if section and STOP.match(label):
            section = None
        if not section:
            continue
        if label in MENUS:
            menu = MENUS[label]
            continue
        if not menu or label.lower().startswith(("no task", "no enroute", "no action", "no option")):
            continue
        if menu == "task" and label in ("Panel Interface Controls",):
            continue
        n = norm(label)
        key = index.get(n) or index.get("set" + n)
        if key and actions[key]["kind"] == "option" and menu != "option":
            key = None
        if key and actions[key]["kind"] != "option" and menu == "option":
            key = None
        for cat in SECTIONS[section]:
            groups.setdefault(cat, []).append({"label": re.sub(r"\s+", " ", label), "menu": menu, "key": key})
    payload = {
        "_source": "DCS User Manual (Eagle Dynamics), table of contents of the Advanced Actions chapters; labels only, "
                   "linked to data/hoggit.json by literal name match. Manual created 2022-07-27; DCS has changed since.",
        "_url": "https://www.digitalcombatsimulator.com/upload/iblock/ed6/87v22jwd1xh51i3rgki944xsf503istq/DCS_User_Manual_EN_2020.pdf",
        "_sha256": sha,
        "groups": groups,
    }
    open(out, "w", encoding="utf-8").write(json.dumps(payload, indent=1, ensure_ascii=False) + "\n")
    for cat, items in groups.items():
        mapped = sum(1 for i in items if i["key"])
        print(f"{cat}: {len(items)} editor actions, {mapped} linked, unmapped: {[i['label'] for i in items if not i['key']]}")


if __name__ == "__main__":
    main()
