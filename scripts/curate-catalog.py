#!/usr/bin/env python3
"""Cuts the module catalog down to what people actually need: maps, survival, water filtration, cooking, electronics,
coding, a dictionary, and the local AI. Everything else is dropped. Run after scripts/import-nomad.py (which brings in
the full Project NOMAD lists); it is idempotent. Also rewrites categories, the quick-setup tiers and the topics."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); CAT = os.path.join(HERE, "..", "app", "shared", "site", "catalog.json")
raw = open(CAT, encoding="utf-8").read(); cat = json.loads(raw); by = {m["id"]: m for m in cat["modules"]}

GROUPS = [   # (category, [module ids])
  ("survival",    ["medicine", "nhs-uk-en-medicines", "post-disaster", "www-ready-gov-en", "urban-prepper-en-all", "canadian-prepper-en-bugoutroll", "zimgit-knots-en", "outdoors-se"]),
  ("water",       ["water"]),
  ("cooking",     ["food", "cooking", "foss-cooking-en-all", "based-cooking-en-all"]),
  ("electronics", ["electronics", "arduino-stackexchange-com-en-all", "raspberrypi-stackexchange-com-en-all", "ham-stackexchange-com-en-all"]),
  ("coding",      ["freecodecamp-en-all", "devdocs-en-python", "devdocs-en-javascript", "devdocs-en-html", "devdocs-en-css", "devdocs-en-bash", "devdocs-en-git"]),
  ("dictionary",  ["wiktionary"]),
  ("ai",          ["ai-engine", "qwen25-05b", "qwen25-15b", "llama32-3b", "qwen25-7b"]),
  ("tools",       ["reader", "notes"]),
  ("apps",        ["app-android", "app-windows", "app-pi64", "app-pi32", "app-linux"]),
]
MAPS = ["map-world"] + [m["id"] for m in cat["modules"] if m["install"]["kind"] == "pmtiles-file"]
KEEP = {i: c for c, ids in GROUPS for i in ids}; KEEP.update({i: "maps" for i in MAPS})
missing = [i for i in KEEP if i not in by]
if missing: sys.exit("missing from the catalog: " + ", ".join(missing))
cat["modules"] = [dict(by[m["id"]], category=KEEP[m["id"]]) for m in cat["modules"] if m["id"] in KEEP]
ids = {m["id"] for m in cat["modules"]}
# friendlier names for a few NOMAD ones
RENAME = {"www-ready-gov-en": "Ready.gov", "urban-prepper-en-all": "Urban Prepper", "canadian-prepper-en-bugoutroll": "Bug-Out Roll", "foss-cooking-en-all": "Cooking Recipes", "based-cooking-en-all": "Based Cooking",
          "arduino-stackexchange-com-en-all": "Arduino Q&A", "raspberrypi-stackexchange-com-en-all": "Raspberry Pi Q&A", "ham-stackexchange-com-en-all": "Ham Radio Q&A", "devdocs-en-bash": "Linux & Bash Documentation"}
for m in cat["modules"]:
    if m["id"] in RENAME: m["name"] = RENAME[m["id"]]

def tier(tid, name, mods, desc, rec=False): return {"id": tid, "name": name, "recommended": rec, "description": desc, "modules": [i for i in mods if i in ids]}
AI_ESS = ["ai-engine", "qwen25-05b"]
TOPICS = [
  {"id": "survival", "name": "Survival", "description": "First aid, medicines, emergency planning, knots and wilderness skills.", "icon": "cross", "tiers": [
    tier("survival-essential", "Essential", ["medicine", "post-disaster", "www-ready-gov-en", "zimgit-knots-en"], "First aid, disaster guides, Ready.gov and knots. Start here.", True),
    tier("survival-standard", "Standard", ["medicine", "post-disaster", "www-ready-gov-en", "zimgit-knots-en", "nhs-uk-en-medicines", "urban-prepper-en-all", "canadian-prepper-en-bugoutroll"], "Adds medicines A to Z and bug-out planning."),
    tier("survival-all", "Everything", ["medicine", "post-disaster", "www-ready-gov-en", "zimgit-knots-en", "nhs-uk-en-medicines", "urban-prepper-en-all", "canadian-prepper-en-bugoutroll", "outdoors-se"], "Adds outdoors questions and answers.")]},
  {"id": "water", "name": "Water filtration", "description": "How to find, filter, purify and store drinking water.", "icon": "droplet", "tiers": [tier("water-all", "Water guides", ["water"], "Small download.", True)]},
  {"id": "cooking", "name": "Cooking", "description": "Recipes, food preparation and preserving.", "icon": "chef", "tiers": [
    tier("cooking-essential", "Essential", ["food", "foss-cooking-en-all"], "Food preparation and a recipe collection.", True),
    tier("cooking-all", "Everything", ["food", "foss-cooking-en-all", "based-cooking-en-all", "cooking"], "Adds more recipes and cooking Q&A.")]},
  {"id": "electronics", "name": "Electronics", "description": "Circuits, Arduino, Raspberry Pi and ham radio.", "icon": "chip", "tiers": [
    tier("electronics-essential", "Essential", ["arduino-stackexchange-com-en-all", "raspberrypi-stackexchange-com-en-all", "ham-stackexchange-com-en-all"], "Arduino, Raspberry Pi and ham radio Q&A.", True),
    tier("electronics-all", "Everything", ["electronics", "arduino-stackexchange-com-en-all", "raspberrypi-stackexchange-com-en-all", "ham-stackexchange-com-en-all"], "Adds the large electronics Q&A (about 4 GB).")]},
  {"id": "coding", "name": "Coding", "description": "Learn to program and look things up: Python, JavaScript, HTML, CSS, Linux and Git.", "icon": "code", "tiers": [
    tier("coding-essential", "Essential", ["devdocs-en-python", "devdocs-en-javascript", "devdocs-en-html", "devdocs-en-css", "devdocs-en-bash", "devdocs-en-git"], "Documentation for the main languages and tools. Small.", True),
    tier("coding-all", "Everything", ["freecodecamp-en-all", "devdocs-en-python", "devdocs-en-javascript", "devdocs-en-html", "devdocs-en-css", "devdocs-en-bash", "devdocs-en-git"], "Adds freeCodeCamp's interactive tutorials.")]},
  {"id": "dictionary", "name": "Dictionary", "description": "Meanings, word origins and translations (Wiktionary).", "icon": "book", "tiers": [tier("dictionary-all", "Wiktionary", ["wiktionary"], "Large download (several GB).", True)]},
  {"id": "ai", "name": "Local AI", "description": "An assistant that runs on this computer, reads your installed library and answers in plain language. No internet needed.", "icon": "bot", "tiers": [
    tier("ai-small", "Small", AI_ESS, "Runs on almost anything (about 0.5 GB).", True),
    tier("ai-balanced", "Balanced", ["ai-engine", "qwen25-15b"], "Better answers; needs about 2 GB of memory."),
    tier("ai-better", "Better", ["ai-engine", "llama32-3b"], "Needs a real computer (about 4 GB of memory)."),
    tier("ai-best", "Best", ["ai-engine", "qwen25-7b"], "The most capable; needs about 8 GB of memory.")]},
]
# maps: one topic, a tier per NOMAD region
old_topics = {t["id"]: t for t in cat.get("topics", [])}
regions = [t for k, t in old_topics.items() if k.startswith("maps-")] or [t for t in cat.get("_regions", [])]
if regions: cat["_regions"] = regions
mt = [tier("maps-world", "World overview", ["map-world"], "A small map of the whole world (zoom 0-7).", True)]
for r in regions:
    mt.append(tier(r["id"], r["name"].replace(" (maps)", ""), r["tiers"][0]["modules"], "State maps for this region."))
TOPICS.append({"id": "maps", "name": "Offline maps", "description": "Street maps that work with no signal. Pick your region.", "icon": "map", "tiers": mt})
cat["topics"] = [t for t in TOPICS if t["tiers"] and all(t2["modules"] for t2 in t["tiers"])]
cat["tiers"] = [
  {"id": "essential", "name": "Essential", "blurb": "The basics: first aid, water, disaster guides, a world map and a small AI.", "modules": [i for i in ["reader", "water", "medicine", "post-disaster", "www-ready-gov-en", "zimgit-knots-en", "map-world", "ai-engine", "qwen25-05b"] if i in ids]},
  {"id": "standard", "name": "Standard", "blurb": "Adds cooking, coding documentation, more survival guides and a better AI.", "modules": [i for i in ["reader", "water", "medicine", "post-disaster", "www-ready-gov-en", "zimgit-knots-en", "map-world", "nhs-uk-en-medicines", "urban-prepper-en-all", "canadian-prepper-en-bugoutroll", "food", "foss-cooking-en-all", "based-cooking-en-all", "devdocs-en-python", "devdocs-en-javascript", "devdocs-en-html", "devdocs-en-css", "devdocs-en-bash", "devdocs-en-git", "ai-engine", "qwen25-15b"] if i in ids]},
  {"id": "comprehensive", "name": "Comprehensive", "blurb": "Adds electronics, the dictionary, freeCodeCamp and a strong AI. Large downloads.", "modules": [i for i in ["reader", "water", "medicine", "post-disaster", "www-ready-gov-en", "zimgit-knots-en", "map-world", "nhs-uk-en-medicines", "urban-prepper-en-all", "canadian-prepper-en-bugoutroll", "outdoors-se", "food", "cooking", "foss-cooking-en-all", "based-cooking-en-all", "devdocs-en-python", "devdocs-en-javascript", "devdocs-en-html", "devdocs-en-css", "devdocs-en-bash", "devdocs-en-git", "freecodecamp-en-all", "electronics", "arduino-stackexchange-com-en-all", "raspberrypi-stackexchange-com-en-all", "ham-stackexchange-com-en-all", "wiktionary", "ai-engine", "llama32-3b"] if i in ids]},
]
json.dump(cat, open(CAT, "w", encoding="utf-8"), ensure_ascii=False, indent=2 if "\n  " in raw[:80] else None); open(CAT, "a").write("\n")
print("kept %d modules: %s" % (len(cat["modules"]), ", ".join("%s %d" % (c, sum(1 for m in cat["modules"] if m["category"] == c)) for c in dict.fromkeys(m["category"] for m in cat["modules"]))))
print("topics:", ", ".join(t["id"] for t in cat["topics"]))
