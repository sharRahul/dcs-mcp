#!/usr/bin/env python3
"""
Build data/real-world-inventory.json: what each country ACTUALLY operates,
according to Wikipedia, matched against DCS unit types.

DCS's own per-country lists (data/countries.json, from pydcs) say what the
Mission Editor *allows* - Russia is offered an A-10C. This file says what the
country really flies, sails and drives, so a mission can be realistic, and it
names the real types DCS lacks, which is where third-party mods come in.

Sources, per country: "List of active <X> military aircraft", "List of
equipment of the <army>", and "List of active <navy> ships" (first title that
exists wins). Pages are read with ?action=raw (wikitext); nothing is executed.
Wikipedia content is CC BY-SA 4.0; only type names and links are kept.

Matching is HEURISTIC and labelled as such: a Wikipedia row matches a DCS type
when they share a designation (Su-30MKI -> family "su30" -> DCS 'Su-30') or, for
ships, a distinctive class word ("Ticonderoga"). `match` is "family" because a
DCS type is often a different variant of the real one.

Usage:
  python3 -I scripts/gen-real-world-inventory.py data            # fetch + write
  python3 -I scripts/gen-real-world-inventory.py data --cache DIR  # reuse fetched pages
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

UA = "dcs-mcp-reference-generator/0.2 (offline mission authoring data)"

OUT = sys.argv[1] if len(sys.argv) > 1 else "data"
CACHE = sys.argv[sys.argv.index("--cache") + 1] if "--cache" in sys.argv else None

# DCS country name -> (aircraft adjective titles, army titles, navy titles). First hit wins.
COUNTRIES = {
    "USA": (["List of active United States military aircraft"],
            ["List of equipment of the United States Army"],
            ["List of current ships of the United States Navy"]),
    "Russia": (["List of active Russian military aircraft"],
               ["List of equipment of the Russian Ground Forces"],
               ["List of active ships of the Russian Navy"]),
    "UK": (["List of active United Kingdom military aircraft"],
           ["List of equipment of the British Army"],
           ["List of active Royal Navy ships"]),
    "France": (["List of active French military aircraft"],
               ["List of equipment of the French Army"],
               ["List of active French Navy ships"]),
    "Germany": (["List of active German military aircraft", "List of military aircraft of Germany"],
                ["List of equipment of the German Army"],
                ["List of active German Navy ships"]),
    "India": (["List of active Indian military aircraft"],
              ["List of equipment of the Indian Army"],
              ["List of active Indian Navy ships"]),
    "China": (["List of active People's Liberation Army aircraft"],
              ["List of equipment of the People's Liberation Army Ground Force"],
              ["List of active People's Liberation Army Navy ships"]),
    "Pakistan": (["List of active Pakistan military aircraft", "List of active Pakistani military aircraft"],
                 ["List of equipment of the Pakistan Army"],
                 ["List of active ships of the Pakistan Navy"]),
    "Iran": (["List of aircraft of the Iranian Air Force", "List of active Iranian military aircraft"],
             ["List of equipment of the Islamic Republic of Iran Army"],
             ["List of current ships of the Islamic Republic of Iran Navy"]),
    "Israel": (["List of active Israeli military aircraft", "List of Israeli Air Force aircraft"],
               ["List of equipment of the Israel Defense Forces"],
               ["List of ships of the Israeli Navy"]),
    "Turkey": (["List of active Turkish military aircraft"],
               ["List of equipment of the Turkish Land Forces"],
               ["List of active ships of the Turkish Navy"]),
    "Saudi Arabia": (["List of active Saudi Arabian military aircraft"],
                     ["List of equipment of the Royal Saudi Land Forces"],
                     ["List of active Royal Saudi Navy ships"]),
    "Japan": (["List of active Japanese military aircraft"],
              ["List of equipment of the Japan Ground Self-Defense Force"],
              ["List of active Japan Maritime Self-Defense Force ships"]),
    "South Korea": (["List of active South Korean military aircraft"],
                    ["List of equipment of the Republic of Korea Army"],
                    ["List of active Republic of Korea Navy ships"]),
    "North Korea": (["List of active North Korean military aircraft"],
                    ["List of equipment of the Korean People's Army Ground Force"],
                    ["List of active Korean People's Navy ships"]),
    "Ukraine": (["List of active Ukrainian military aircraft"],
                ["List of equipment of the Ukrainian Ground Forces"],
                ["List of active ships of the Ukrainian Navy"]),
    "Syria": (["List of active Syrian military aircraft"],
              ["List of equipment of the Syrian Arab Army"],
              []),
    "Egypt": (["List of active Egyptian military aircraft"],
              ["List of equipment of the Egyptian Army"],
              ["List of active ships of the Egyptian Navy"]),
    "Iraq": (["List of active Iraqi military aircraft"],
             ["List of equipment of the Iraqi Army"],
             []),
    "Georgia": (["List of active Georgian military aircraft"],
                ["List of equipment of the Georgian Armed Forces"],
                []),
    "Australia": (["List of active Australian military aircraft"],
                  ["List of equipment of the Australian Army"],
                  ["List of active Royal Australian Navy ships"]),
    "Canada": (["List of active Canadian military aircraft"],
               ["List of equipment of the Canadian Army"],
               ["List of active Royal Canadian Navy ships"]),
    "Italy": (["List of active Italian military aircraft"],
              ["List of equipment of the Italian Army"],
              ["List of active Italian Navy ships"]),
    "Spain": (["List of active Spanish military aircraft"],
              ["List of equipment of the Spanish Army"],
              ["List of active Spanish Navy ships"]),
    "Greece": (["List of active Hellenic military aircraft", "List of active Greek military aircraft"],
               ["List of equipment of the Hellenic Army"],
               ["List of active Hellenic Navy ships"]),
    "Poland": (["List of active Polish military aircraft"],
               ["List of equipment of the Polish Land Forces"],
               ["List of active Polish Navy ships"]),
    "Sweden": (["List of active Swedish military aircraft"],
               ["List of equipment of the Swedish Army"],
               ["List of active Swedish Navy ships"]),
    "Norway": (["List of active Norwegian military aircraft"],
               ["List of equipment of the Norwegian Army"],
               ["List of active Royal Norwegian Navy ships"]),
    "United Arab Emirates": (["List of active United Arab Emirates military aircraft"],
                             ["List of equipment of the United Arab Emirates Army"],
                             []),
    "Qatar": (["List of active Qatari military aircraft"], [], []),
    "Kuwait": (["List of active Kuwaiti military aircraft"], [], []),
    "Belarus": (["List of active Belarusian military aircraft"], ["List of equipment of the Belarusian Ground Forces"], []),
    "Kazakhstan": (["List of active Kazakh military aircraft"], [], []),
    "Argentina": (["List of active Argentine military aircraft"], ["List of equipment of the Argentine Army"],
                  ["List of active Argentine Navy ships"]),
    "Brazil": (["List of active Brazilian military aircraft"], ["List of equipment of the Brazilian Army"],
               ["List of active Brazilian Navy ships"]),
}

STOP = set("""
aircraft fighter fighters bomber trainer transport helicopter helicopters attack utility
multirole class cruiser destroyer frigate corvette submarine carrier ship ships vessel
patrol boat landing tank vehicle system missile launcher radar air force navy army
sukhoi mikoyan gurevich boeing lockheed martin general dynamics northrop grumman dassault
airbus eurocopter mcdonnell douglas bell sikorsky textron leonardo agusta westland
hindustan aeronautics limited embraer antonov ilyushin tupolev beriev kamov mil yakovlev
the and with type variant series block active service united states royal
sam tel ewr str spaag spg ifv apc mbt atgm mlrs luv srbm tr ln sr cp c2 mod new old
""".split())

DESIG = re.compile(r"\b([A-Za-z]{1,5})[- ]?(\d{1,4})")

# Where DCS's type id spells a family differently from the real designation.
ALIASES = [
    (r"\bMirage\s*(\d{4})", r"M-\1"),     # Mirage 2000 -> M-2000C
    (r"\bF/A-?", "FA-"),                    # F/A-18 -> FA-18C_hornet
    (r"\bAV-8B", "AV8BNA"),                 # AV-8B Harrier II -> AV8BNA
    (r"\bMi-17\b", "Mi-8"),                 # Mi-17 is the export Mi-8
    # Navy lists name hulls ("USS Lake Erie (CG-70)"); DCS models classes.
    (r"\bCG-\d+", "Ticonderoga"),
    (r"\bDDG-(5[1-9]|[6-9]\d|1[0-3]\d)\b", "Arleigh Burke"),
    (r"\bFFG-([7-9]|[1-5]\d|6[01])\b", "Oliver Hazard Perry"),
    # DCS has the Nimitz class as individual hulls (CVN-70 ... CVN-75).
    (r"\bNimitz\b", "Nimitz CVN-70 CVN-71 CVN-72 CVN-73 CVN-74 CVN-75"),
]


def normalize(text):
    for pat, rep in ALIASES:
        text = re.sub(pat, rep, text)
    return text


def words(text, minlen=4):
    return {w.lower() for w in re.findall(r"[A-Za-z]{%d,}" % minlen, text) if w.lower() not in STOP}


# British service marks written without a hyphen ("Wildcat AH1", "Typhoon FGR4",
# "Voyager KC2") look like designations but are not; a real designation that
# uses these letters is hyphenated (KC-135, C-17, AH-64).
UK_MARKS = {"ah", "hm", "hc", "ht", "hu", "fgr", "gr", "kc", "cc", "asac", "mra", "rg", "aew", "t", "c", "r", "f", "w"}
MARK = re.compile(r"\b([A-Za-z]{1,5})(\d{1,4})\b")


def keys(text, ships=False):
    """Designation families (su30, f16, mig29, t72, bmp2) and, for ships, class words."""
    t = normalize(text)
    marks = {f"{a.lower()}{b}" for a, b in MARK.findall(t) if a.lower() in UK_MARKS}
    hyphenated = {f"{a.lower()}{b}" for a, b in re.findall(r"\b([A-Za-z]{1,5})-(\d{1,4})", t)}
    out = {f"{a.lower()}{b}" for a, b in DESIG.findall(t)} - (marks - hyphenated)
    if "AV8BNA" in t:
        out.add("av8")
    if ships:
        out |= {w for w in words(t) if len(w) >= 5}
    return out


def search_title(query):
    """Wikipedia's title search, for list pages whose exact name differs from our guess."""
    url = "https://en.wikipedia.org/w/rest.php/v1/search/title?limit=5&q=" + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            pages = json.load(r).get("pages", [])
    except (urllib.error.URLError, ValueError):
        return None
    finally:
        time.sleep(2)
    for p in pages:
        if p["title"].lower().startswith("list of"):
            return p["title"]
    return None


def page_rows(title, kind, depth=0):
    """Rows of a list page; a hub page with no tables is followed to its sub-lists."""
    text = fetch(title)
    if not text:
        return None, []
    rows = table_rows(text, kind)
    if rows or depth > 0:
        return title, rows
    subs = []
    for target in re.findall(r"\[\[(List of (?:active|current)[^\]|#]+)", text):
        if target not in subs and target != title:
            subs.append(target)
    for sub in subs[:6]:
        _t, sub_rows = page_rows(sub, kind, depth + 1)
        rows.extend(sub_rows)
    return title, rows


def fetch(title):
    if CACHE:
        path = os.path.join(CACHE, re.sub(r"[^A-Za-z0-9]+", "_", title) + ".wiki")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                text = f.read()
            return text or None
    url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")) + "?action=raw"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    text = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                text = r.read().decode("utf-8")
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                break
            time.sleep(10 * (attempt + 1))
        except urllib.error.URLError:
            time.sleep(10 * (attempt + 1))
    time.sleep(2)
    redirect = re.match(r"#REDIRECT\s*\[\[([^\]|#]+)", text or "", re.I)
    if redirect:
        return fetch(redirect.group(1).strip())
    if CACHE:
        os.makedirs(CACHE, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text or "")
    return text


SKIP_LINK = re.compile(r"^(File|Image|Category|Template|Wikipedia|Help):|^List of|air force$|navy$|army$|^[A-Z][a-z]+$", re.I)

# Role headings ("Military aircraft#Combat", "Aerial refueling") and citations
# ("The Economic Times") also arrive as the first link of a row. An equipment
# article has a proper name in it; these are made only of generic words.
GENERIC = set("""
military aircraft aerial refueling refuelling airborne early warning and control reconnaissance
transport trainer training utility helicopter helicopters cargo surveillance unmanned vehicle
vehicles combat maritime patrol swarm drone drones grenade launcher launchers main battle tank tanks
assault rifle rifles gun guns machine howitzer artillery self-propelled mortar mortars missile
missiles surface-to-air anti-tank guided infantry fighting armoured armored personnel carrier
carriers destroyer frigate corvette submarine submarines cruiser ship ships boat boats vessel
vessels landing multiple rocket rockets light heavy truck trucks engineering recovery
anti-aircraft warfare electronic radar radars system systems air defense defence ballistic
cruise attack fighter bomber multirole interceptor aerial of the a an tactical strategic
amphibious offshore fast craft mine countermeasures minesweeper survey support auxiliary
tanker oiler tug tugs research vip executive jet business airliner aircraft-carrier
air-to-air air-to-surface anti-ship sniper pistol submachine shotgun weapon weapons
special operations forces unit vehicle-mounted self-propelled-gun command post
""".split())
CITATION = re.compile(
    r"\b(times|news|services|post|journal|magazine|press|tribune|herald|gazette|express|daily|week|"
    r"weekly|reuters|janes|institute|ministry|government|agency|review|monitor|online|blog|"
    r"international|corporation|company|aerospace industries)\b",
    re.I,
)


def is_equipment(name, target):
    if CITATION.search(target):
        return False
    tokens = re.findall(r"[A-Za-z][A-Za-z\-]*", target.lower())
    if DESIG.search(target) or DESIG.search(name):
        return True
    return any(t not in GENERIC for t in tokens)


PORT = re.compile(r"naval (station|base)|navy yard|fleet activities|dockyard|harbou?r\b|,", re.I)
GENERIC |= set("""
dock tender littoral hospital replenishment prepositioning expeditionary ocean cable research
environmental trials torpedo mobile base fleet station sealift salvage rescue hydrographic
oceanographic command transport ship-to-shore connector
""".split())

TABLE = re.compile(r"(?:\{\||\{\{\s*[Aa]vilisthead[^}]*\}\})(.*?)\n\|\}", re.S)


SHIP_LINK = re.compile(
    r"-class\b|\bclass\b|^(USS|USNS|HMS|INS|HMAS|HMCS|HMNZS|FS|ITS|ESPS|TCG|ROKS|JS|PNS|ARA|NRP|HNLMS|KD|BNS|"
    r"CNS|RFS|HDMS|KNM|HSwMS|ORP|HS|ENS|IRIS|INS|NAeL|BAP)\b"
)


def table_rows(wikitext, kind="aircraft"):
    """First meaningful wikilink of each table row: the equipment name.

    Ship tables put a generic type or a home port in the first column, so for
    ships the row's class (or named-ship) link is used, and a row without one
    is skipped.
    """
    rows = []
    for table in TABLE.findall(wikitext):
        for row in re.split(r"\n\|-[^\n]*", table)[1:]:
            links = re.findall(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]", row)
            if kind == "naval":
                classy = [l for l in links if SHIP_LINK.search(l[0].strip())]
                links = classy[:1] or [l for l in links if not PORT.search(l[0])]
            for target, label in links:
                target = target.strip()
                if SKIP_LINK.search(target):
                    continue
                name = (label or target).strip()
                if not is_equipment(name, target):
                    break  # a heading or citation row: skip the row, not just the link
                rows.append({"name": name, "wiki": target})
                break
    seen, out = set(), []
    for r in rows:
        if r["wiki"] not in seen:
            seen.add(r["wiki"])
            out.append(r)
    return out


def load(name):
    with open(os.path.join(OUT, name), encoding="utf-8") as f:
        return json.load(f)


unit_types = load("unit-types.json")
dcs_countries = {c["name"]: c for c in load("countries.json")["countries"]}


def dcs_index(categories, ships=False):
    idx = []
    for cat in categories:
        for t in unit_types[cat]:
            k = keys(t["type"] + " " + t.get("name", ""), ships)
            # A one-word type id ('Hawk') can only be matched by name; a compound
            # one ('Falcon_Gyrocopter') must not match every "Falcon".
            if not ships and re.fullmatch(r"[A-Za-z]{4,}", t["type"]):
                k |= {"w:" + t["type"].lower()}
            if cat == "vehicle":
                # Ground systems are often listed by name alone ("Buk", "Patriot",
                # "Abrams"): the distinctive words of DCS's display name.
                k |= {"w:" + w for w in words(t.get("name", ""), 3) if w not in GENERIC}
            idx.append((cat, t["type"], k))
    return idx


INDEX = {
    "aircraft": dcs_index(["plane", "helicopter"]),
    "ground": dcs_index(["vehicle"]),
    "naval": dcs_index(["ship"], ships=True),
}


def match(entry, kind):
    text = entry["name"] + " " + entry["wiki"]
    k = keys(text, ships=(kind == "naval"))
    # A row with a designation matches on it alone ('RQ-4 Global Hawk' is not the 'Hawk');
    # only a row without one ('BAE Systems Hawk') falls back to name words.
    if kind != "naval" and not DESIG.search(normalize(text)):
        k |= {"w:" + w for w in words(text, 3 if kind == "ground" else 4) if w not in GENERIC}
    hits = sorted({t for _c, t, tk in INDEX[kind] if k & tk})
    if not hits and kind == "ground":
        # "MIM-104 Patriot": the designation matches nothing in DCS, the name does.
        w = {"w:" + x for x in words(text, 3) if x not in GENERIC}
        hits = sorted({t for _c, t, tk in INDEX[kind] if w & tk})
    return hits


result = {}
for country, (air_titles, army_titles, navy_titles) in COUNTRIES.items():
    allowed = dcs_countries.get(country, {}).get("units", {})
    allowed_all = {t for v in allowed.values() for t in v}
    data = {"pages": {}}
    for kind, titles in (("aircraft", air_titles), ("ground", army_titles), ("naval", navy_titles)):
        entries = []
        candidates = list(titles)
        for title in candidates + [None]:
            if title is None:
                if not titles:
                    break
                title = search_title(titles[0])
                if not title or title in candidates:
                    break
            found, rows = page_rows(title, kind)
            if not found or not rows:
                continue
            data["pages"][kind] = found
            for row in rows:
                dcs = match(row, kind)
                entries.append({
                    **row,
                    "dcs": dcs,
                    # Every matched DCS type the Mission Editor offers this country.
                    "dcsForCountry": [t for t in dcs if t in allowed_all],
                })
            break
        data[kind] = entries
    result[country] = data
    n = {k: len(data[k]) for k in ("aircraft", "ground", "naval")}
    missing = sum(1 for k in ("aircraft", "ground", "naval") for e in data[k] if not e["dcs"])
    print(f"{country:22} {n}  no DCS match: {missing}", flush=True)

with open(os.path.join(OUT, "real-world-inventory.json"), "w", encoding="utf-8") as f:
    json.dump(
        {
            "_source": "Generated by scripts/gen-real-world-inventory.py from English Wikipedia (CC BY-SA 4.0) "
            "equipment lists; DCS matching is heuristic (shared designation family).",
            "generated": date.today().isoformat(),
            "countries": result,
        },
        f,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    f.write("\n")

# --- human-readable report --------------------------------------------------------
LABEL = {"aircraft": "Aircraft", "ground": "Ground forces", "naval": "Ships"}
lines = [
    "# Real-world inventories vs DCS",
    "",
    f"Generated {date.today().isoformat()} by `scripts/gen-real-world-inventory.py` from English Wikipedia",
    "(CC BY-SA 4.0). For each country: what it operates that DCS can place for it (family match,",
    "often a different variant), what DCS has only under other countries, and what DCS lacks — the",
    "types a third-party mod would have to supply. `dcs_country_inventory` gives the same per",
    "country, plus matches against the mods installed on your machine.",
    "",
    "Matching is heuristic (shared designation or name). Ship coverage is weak: most navy pages",
    "list their major classes outside tables.",
    "",
]
for country, data in result.items():
    if not any(data[k] for k in LABEL):
        lines += [f"## {country}", "", "No Wikipedia equipment list found.", ""]
        continue
    lines += [f"## {country}", ""]
    for kind, label in LABEL.items():
        rows = data[kind]
        if not rows:
            lines.append(f"- **{label}:** no list found")
            continue
        here = sorted({t for r in rows for t in r["dcsForCountry"]})
        other = sorted({r["name"] for r in rows if r["dcs"] and not r["dcsForCountry"]})
        missing = [r["name"] for r in rows if not r["dcs"]]
        lines.append(
            f"- **{label}** ({len(rows)} listed, from *{data['pages'][kind]}*): "
            f"{len(here)} DCS types offered to {country}; {len(other)} in DCS for other countries only; "
            f"{len(missing)} not in DCS."
        )
        if kind == "aircraft":
            if here:
                lines.append(f"  - In DCS for {country}: " + ", ".join(f"`{t}`" for t in here))
            if missing:
                lines.append("  - Not in DCS (mod candidates): " + ", ".join(dict.fromkeys(missing)))
    lines.append("")

os.makedirs("docs", exist_ok=True)
with open(os.path.join("docs", "real-world-inventory.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
