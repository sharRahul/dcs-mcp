#!/usr/bin/env python3
"""Pin the Wikipedia revisions behind data/real-world-inventory.json (metadata only).

    python3 -I scripts/data/pin-wikipedia-revisions.py data/real-world-inventory.json

The inventory generator records page titles and a generation DATE, not revision ids. This
adds `_revisions`: each page's current revision, fetched in batches of 50 titles (the API is
rate-limited; per-page rvstart queries trip it). A revision timestamped ON or after the
generation date may be newer than the text actually read and is flagged
`mayPostdateGeneration`. Inventory content is not touched.
"""
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://en.wikipedia.org/w/api.php"
UA = "dcs-mcp-data-generator/1 (offline mission tooling)"


def get(params):
    ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    path = sys.argv[1]
    data = json.load(open(path, encoding="utf-8"))
    date = str(data["generated"])[:10]
    titles = sorted({t for c in data["countries"].values() for t in c.get("pages", {}).values() if t})
    pins = {}
    for i in range(0, len(titles), 50):
        batch = titles[i:i + 50]
        for attempt in range(5):
            try:
                r = get({"action": "query", "prop": "revisions", "titles": "|".join(batch), "redirects": 1,
                         "rvprop": "ids|timestamp", "format": "json", "formatversion": 2})
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 4:
                    raise
                time.sleep(30 * (attempt + 1))
        q = r["query"]
        back = {}
        for n in q.get("normalized", []) + q.get("redirects", []):
            back.setdefault(n["to"], []).append(n["from"])
        for page in q["pages"]:
            rev = (page.get("revisions") or [None])[0]
            entry = {"resolvedTitle": page["title"], "revid": rev["revid"] if rev else None, "timestamp": rev["timestamp"] if rev else None}
            if rev and rev["timestamp"][:10] >= date:
                entry["mayPostdateGeneration"] = True
            # Map back through normalisation/redirect chains to the titles the inventory used.
            stack, seen = [page["title"]], set()
            while stack:
                t = stack.pop()
                if t in seen:
                    continue
                seen.add(t)
                if t in batch:
                    pins[t] = entry
                stack.extend(back.get(t, []))
        time.sleep(5)
    out = {k: v for k, v in data.items() if not k.startswith("_")}
    meta = {k: v for k, v in data.items() if k.startswith("_") and k != "_revisions"}
    meta["_revisions"] = {"asOfDate": date, "pages": pins}
    with open(path, "w", encoding="utf-8") as f:
        json.dump({**meta, **out}, f, separators=(",", ":"), ensure_ascii=False)
        f.write("\n")
    missing = [t for t in titles if t not in pins]
    print(f"pinned {sum(1 for p in pins.values() if p['revid'])}/{len(titles)} pages; unresolved: {missing}; "
          f"edited on/after {date}: {sum(1 for p in pins.values() if p.get('mayPostdateGeneration'))}")


if __name__ == "__main__":
    main()
