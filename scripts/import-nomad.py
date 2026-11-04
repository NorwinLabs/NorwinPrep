#!/usr/bin/env python3
"""Merge Project NOMAD's curated content lists (Apache-2.0, vendored in third_party/project-nomad) into app/shared/site/catalog.json.
Idempotent: entries it adds carry "origin": "project-nomad" and are replaced on every run. Existing NorwinPrep modules are never changed;
a NOMAD item that matches one of ours (same Kiwix folder + file name) is mapped to ours instead of duplicated.
   python3 scripts/import-nomad.py"""
import json, re, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V = os.path.join(ROOT, "third_party", "project-nomad", "collections")
CAT = os.path.join(ROOT, "app", "shared", "site", "catalog.json")
cat = json.load(open(CAT, encoding="utf-8")); raw = open(CAT, encoding="utf-8").read()
mods = [m for m in cat["modules"] if m.get("origin") != "project-nomad"]
by_spec = {(m["install"].get("subdir"), m["install"].get("prefix")): m["id"] for m in mods if m["install"]["kind"] == "zim"}
ids = {m["id"] for m in mods}
TOPIC = {"medicine": ("Medicine", "cross", "#d9534f"), "survival": ("Survival & preparedness", "compass", "#c9a227"), "education": ("Education", "book", "#58a05a"),
         "diy": ("Repair & DIY", "wrench", "#d9822b"), "agriculture": ("Food & growing", "leaf", "#3a9d8f"), "computing": ("Computing", "chip", "#7c6bd9")}
def size_class(mb): return "s" if mb < 1000 else "m" if mb < 10000 else "l" if mb < 50000 else "xl"
def slug_id(s):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:41].rstrip("-")
def uniq(base):
    i, n = base, 2
    while i in ids: i = (base[:38] + "-" + str(n)); n += 1
    return i
added, topics, skipped = [], [], []

# ---- Kiwix categories -> zim modules + topics (each tier lists everything it includes) ----
kw = json.load(open(os.path.join(V, "kiwix-categories.json"), encoding="utf-8"))
for c in kw["categories"]:
    name, icon, color = TOPIC.get(c["slug"], (c["name"], "book", "#3a9d8f"))
    tiers, resolved = [], {}
    for t in c["tiers"]:
        mine = []
        for r in t["resources"]:
            if r.get("type") == "dataset": skipped.append((r["id"], "dataset, not a Kiwix pack")); continue
            m = re.match(r"^https://download\.kiwix\.org/zim/([a-z0-9_]+)/([A-Za-z0-9_.-]+)_(\d{4}-\d{2})\.zim$", r["url"])
            if not m: skipped.append((r["id"], "unrecognised url " + r["url"])); continue
            sub, prefix = m.group(1), m.group(2)
            if (sub, prefix) in by_spec: mid = by_spec[(sub, prefix)]
            else:
                mid = uniq(slug_id(prefix)); ids.add(mid); by_spec[(sub, prefix)] = mid
                desc = r.get("description", "").strip()
                added.append({"id": mid, "type": "content", "category": "education" if c["slug"] == "education" else "library", "topic": c["slug"], "name": r["title"],
                              "tagline": desc[:80] or r["title"], "description": (desc + " (Curated by Project NOMAD.)").strip(), "by": "KIWIX", "source": "https://library.kiwix.org/",
                              "icon": icon, "color": color, "sizeClass": size_class(r.get("size_mb", 0)), "install": {"kind": "zim", "subdir": sub, "prefix": prefix},
                              "platforms": ["windows", "linux", "darwin", "android"], "origin": "project-nomad", "approxMB": r.get("size_mb", 0)})
            mine.append(mid)
        inc = resolved.get(t.get("includesTier"), [])
        resolved[t["slug"]] = list(dict.fromkeys(inc + mine))
        tiers.append({"id": t["slug"], "name": t["name"], "recommended": bool(t.get("recommended")), "description": t.get("description", ""), "modules": resolved[t["slug"]]})
    topics.append({"id": c["slug"], "name": name, "description": c["description"], "icon": icon, "tiers": tiers})

# ---- Wikipedia choices ----
wp = json.load(open(os.path.join(V, "wikipedia.json"), encoding="utf-8"))
wopts = []
for o in wp["options"]:
    if not o.get("url"): continue
    m = re.match(r"^https://download\.kiwix\.org/zim/wikipedia/([A-Za-z0-9_.-]+)_(\d{4}-\d{2})\.zim$", o["url"])
    if not m: skipped.append((o["id"], "unrecognised wikipedia url")); continue
    key = ("wikipedia", m.group(1))
    if key not in by_spec:
        mid = uniq(slug_id(m.group(1))); ids.add(mid); by_spec[key] = mid
        added.append({"id": mid, "type": "content", "category": "library", "topic": "wikipedia", "name": o["name"], "tagline": o["description"][:80], "description": o["description"] + " (Curated by Project NOMAD.)",
                      "by": "KIWIX", "source": "https://en.wikipedia.org/", "icon": "globe", "color": "#4a8fd9", "sizeClass": size_class(o["size_mb"]),
                      "install": {"kind": "zim", "subdir": "wikipedia", "prefix": m.group(1)}, "platforms": ["windows", "linux", "darwin", "android"], "origin": "project-nomad", "approxMB": o["size_mb"]})
    wopts.append({"id": o["id"], "name": o["name"], "module": by_spec[key]})
topics.append({"id": "wikipedia", "name": "Wikipedia", "description": "Pick how much of Wikipedia to carry.", "icon": "globe", "tiers": [{"id": "wikipedia-" + o["id"], "name": o["name"], "recommended": False, "description": "", "modules": [o["module"]]} for o in wopts]})

# ---- US regional maps: ready-made files downloaded as they are (no map tool needed, so they also work on 32-bit Raspberry Pi) ----
mp = json.load(open(os.path.join(V, "maps.json"), encoding="utf-8"))
for col in mp["collections"]:
    mine = []
    for r in col["resources"]:
        m = re.match(r"^https://github\.com/Crosstalk-Solutions/project-nomad-maps/raw/refs/heads/master/pmtiles/([a-z0-9_.-]+)_(\d{4}-\d{2})\.pmtiles$", r["url"])
        if not m: skipped.append((r["id"], "unrecognised map url")); continue
        mid = uniq("map-" + slug_id(r["id"])); ids.add(mid)
        added.append({"id": mid, "type": "maps", "category": "maps", "topic": "maps-" + col["slug"], "name": r["title"] + " map", "tagline": r["description"][:80], "description": r["description"] + " Ready-made file from Project NOMAD, so no map tool is needed.",
                      "by": "PROJECT NOMAD", "source": "https://github.com/Crosstalk-Solutions/project-nomad-maps", "icon": "map", "color": "#3a9d8f", "sizeClass": size_class(r.get("size_mb", 0)),
                      "install": {"kind": "pmtiles-file", "url": r["url"], "file": m.group(1).replace("_", "-") + ".pmtiles"}, "platforms": ["windows", "linux", "darwin"], "hosts": ["app"], "origin": "project-nomad", "approxMB": r.get("size_mb", 0)})
        mine.append(mid)
    topics.append({"id": "maps-" + col["slug"], "name": col["name"] + " (maps)", "description": col["description"], "icon": "map", "tiers": [{"id": "maps-" + col["slug"] + "-all", "name": "All of " + col["name"], "recommended": False, "description": "", "modules": mine}]})

cat["modules"] = mods + added
cat["topics"] = topics
cat["credits"] = [{"name": "Project NOMAD", "by": "Crosstalk Solutions, LLC", "license": "Apache-2.0", "url": "https://github.com/Crosstalk-Solutions/project-nomad", "what": "curated content lists (Kiwix packs by topic and tier, Wikipedia choices, US regional maps)"}]
json.dump(cat, open(CAT, "w", encoding="utf-8"), ensure_ascii=False, indent=2 if "\n  " in raw[:80] else None); open(CAT, "a").write("\n")
print("added %d modules (%d zim, %d maps), %d topics; skipped %d: %s" % (len(added), sum(1 for a in added if a["install"]["kind"] == "zim"), sum(1 for a in added if a["install"]["kind"] == "pmtiles-file"), len(topics), len(skipped), skipped))
