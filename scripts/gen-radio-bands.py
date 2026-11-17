#!/usr/bin/env python3
"""Build data/radio-bands.json: documented radio frequency bands per aircraft, as DATA.

    python3 -I scripts/gen-radio-bands.py data/authoring.json data/radio-bands.json

Source: Hoggit DCS wiki pages titled "<type> Radios" (raw wikitext + revision id). Today only
"A-10C Radios" exists; it states "a VHF FM radio (30-88MHz), a VHF AM radio (118-150MHz), and a
UHF radio (225-400MHz)". Rules, so nothing is guessed:
  - a page applies to a DCS type only when its title prefix is LITERALLY a pydcs type id;
  - a pydcs preset radio (panel_radio index) gets a band only when EVERY one of its default
    channel frequencies lies inside exactly one of the page's bands. Otherwise it stays unmapped.
"""
import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request

WIKI = "https://wiki.hoggitworld.com"


def get(url):
    ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)
    req = urllib.request.Request(url, headers={"User-Agent": "dcs-mcp-data-generator/1"})
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        return r.read().decode("utf-8")


def main():
    authoring, out = sys.argv[1], sys.argv[2]
    aircraft = json.load(open(authoring, encoding="utf-8"))["aircraft"]
    # The wiki's search API returns nothing; walk the full page list instead.
    titles, cont = [], None
    while True:
        q = f"{WIKI}/api.php?action=query&list=allpages&aplimit=500&format=json"
        data = json.loads(get(q + (f"&apcontinue={urllib.parse.quote(cont)}" if cont else "")))
        titles += [p["title"] for p in data["query"]["allpages"] if p["title"].endswith(" Radios")]
        cont = data.get("continue", {}).get("apcontinue")
        if not cont:
            break
    result, skipped = {}, []
    for title in sorted(set(titles)):
        dcs_type = title[: -len(" Radios")]
        if dcs_type not in aircraft:
            skipped.append(f"{title}: '{dcs_type}' is not a pydcs type id")
            continue
        raw = get(f"{WIKI}/view/{urllib.parse.quote(title.replace(' ', '_'))}?action=raw")
        rev = json.loads(get(f"{WIKI}/api.php?action=query&prop=revisions&rvprop=ids|timestamp&format=json&titles={urllib.parse.quote(title)}"))
        revid = next(iter(rev["query"]["pages"].values()))["revisions"][0]["revid"]
        bands = [{"name": n, "minMHz": float(a), "maxMHz": float(b)}
                 for n, a, b in re.findall(r"(VHF FM|VHF AM|UHF|HF)\s+radio\s*\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*MHz\)", raw)]
        radios = {}
        for radio, cfg in (aircraft[dcs_type].get("panelRadio") or {}).items():
            freqs = list(cfg["channels"].values())
            fits = [b for b in bands if freqs and all(b["minMHz"] <= f <= b["maxMHz"] for f in freqs)]
            radios[radio] = {"band": fits[0]["name"], "minMHz": fits[0]["minMHz"], "maxMHz": fits[0]["maxMHz"]} if len(fits) == 1 else None
            if len(fits) != 1:
                skipped.append(f"{dcs_type} radio {radio}: defaults {min(freqs)}-{max(freqs)} MHz fit {len(fits)} bands; unmapped")
        result[dcs_type] = {"page": f"{WIKI}/view/{title.replace(' ', '_')}", "revid": revid, "bands": bands, "radios": radios}
    payload = {"_source": "Hoggit DCS wiki '<type> Radios' pages (facts only); radios mapped to a band only when all pydcs "
                          "default channels fit exactly one documented band.", "_skipped": skipped, "aircraft": result}
    open(out, "w", encoding="utf-8").write(json.dumps(payload, indent=1) + "\n")
    print(json.dumps(payload, indent=1)[:1500])


if __name__ == "__main__":
    main()
