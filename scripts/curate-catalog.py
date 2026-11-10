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
  ("reference",   ["wikipedia-top-mini", "wikipedia-top-nopic", "wikipedia-all-mini"]),
  ("tools",       ["notes", "checklists", "emergency-card", "signals"]),
  ("ai",          ["ai-engine", "qwen25-05b", "qwen25-15b", "llama32-3b", "qwen25-7b", "ollama-engine", "ollama-qwen25-05b", "ollama-qwen25-15b", "ollama-llama32-3b", "ollama-qwen25-7b", "ollama-gemma3-4b", "speech-en"]),
  ("tools",       ["reader", "notes"]),
  ("apps",        ["app-android", "app-windows", "app-pi64", "app-pi32", "app-linux"]),
]
# Ollama as a second engine: the engine itself plus the same four models pulled from Ollama's own library (added here so the script stays the single source)
def _ollama(i, name, tag, tagline, desc, mb, ram, size, by_):
    return {"id": i, "type": "model", "category": "ai", "name": name, "tagline": tagline, "description": desc, "by": by_, "source": "https://ollama.com/library/" + tag.split(":")[0],
            "icon": "chip", "color": "#2b8fd9", "sizeClass": size, "approxMB": mb, "install": dict({"kind": "ollama-model", "name": tag}, **({"minRamGB": ram} if ram else {})),
            "platforms": ["windows", "linux", "darwin"], "hosts": ["app"], "open": "/ai/"}
OLLAMA_MODS = [
  {"id": "ollama-engine", "type": "tool", "category": "ai", "name": "Ollama", "tagline": "A popular way to run AI models on your own computer",
   "description": "Ollama runs AI language models with no internet and no account. The app keeps its own private copy and its models in your library folder, and it is installed automatically with your first Ollama model. Models you add here can read your installed library, just like the others.",
   "by": "OLLAMA", "source": "https://github.com/ollama/ollama", "icon": "chip", "color": "#2b8fd9", "sizeClass": "m", "install": {"kind": "ollama", "repo": "ollama/ollama"}, "platforms": ["windows", "linux", "darwin"], "hosts": ["app"]},
  _ollama("ollama-qwen25-05b", "Qwen 2.5 0.5B (Ollama)", "qwen2.5:0.5b", "Tiny and quick, for old computers", "Alibaba's smallest Qwen model through Ollama. Runs on almost anything; answers are short and simple. About 0.5 GB of memory.", 400, None, "s", "ALIBABA"),
  _ollama("ollama-qwen25-15b", "Qwen 2.5 1.5B (Ollama)", "qwen2.5:1.5b", "Good answers on an ordinary laptop", "Alibaba's 1.5 billion parameter model through Ollama. A good balance for most computers. About 2 GB of memory.", 990, 2, "m", "ALIBABA"),
  _ollama("ollama-llama32-3b", "Llama 3.2 3B (Ollama)", "llama3.2:3b", "Better answers, needs a real computer", "Meta's 3 billion parameter model through Ollama. Clearly stronger; wants a laptop with 8 GB of memory or a Raspberry Pi 5. About 4 GB of memory.", 2000, 4, "m", "META"),
  _ollama("ollama-gemma3-4b", "Gemma 3 4B (Ollama, sees pictures)", "gemma3:4b", "Ask about a photo: a plant, a wound, a part", "Google's 4 billion parameter model through Ollama. It can look at a picture you attach in the chat (a plant, a rash, a broken part) as well as answer questions. Wants a laptop with 8 GB of memory.", 3350, 6, "m", "GOOGLE"),
  _ollama("ollama-qwen25-7b", "Qwen 2.5 7B (Ollama)", "qwen2.5:7b", "The most capable; needs a strong computer", "Alibaba's 7 billion parameter model through Ollama. Best answers; wants 16 GB of memory for comfort, 8 GB at least.", 4700, 8, "l", "ALIBABA"),
]
for _m in OLLAMA_MODS: by[_m["id"]] = _m
cat["modules"] = [m for m in cat["modules"] if m["id"] not in {x["id"] for x in OLLAMA_MODS}] + [by[x["id"]] for x in OLLAMA_MODS]
# Wikipedia (the same three sizes Project NOMAD offers) and the small built-in tools
def _wiki(i, name, prefix, tag, mb, sc):
    return {"id": i, "type": "content", "category": "reference", "topic": "wikipedia", "name": name, "tagline": tag, "description": tag + " The Wikipedia pack from Kiwix; the AI can read it when \"Use my library\" is on.", "by": "KIWIX", "source": "https://library.kiwix.org/",
            "icon": "book", "color": "#8b92a3", "sizeClass": sc, "install": {"kind": "zim", "subdir": "wikipedia", "prefix": prefix}, "platforms": ["windows", "linux", "darwin", "android"], "origin": "project-nomad", "approxMB": mb}
def _tool(i, name, tag, desc, icon, color, d):
    return {"id": i, "type": "tool", "category": "tools", "name": name, "tagline": tag, "description": desc, "by": "NORWINPREP", "source": "https://github.com/NorwinLabs/NorwinPrepDisk", "icon": icon, "color": color, "sizeClass": "s",
            "install": {"kind": "bundled", "dir": d}, "platforms": ["windows", "linux", "darwin"], "hosts": ["app"], "open": "/tools/%s/" % d}
EXTRA = [
  _wiki("wikipedia-top-mini", "Wikipedia: Quick Reference", "wikipedia_en_top_mini", "The 100,000 most-read articles, with few images.", 283, "s"),
  _wiki("wikipedia-top-nopic", "Wikipedia: Popular Articles", "wikipedia_en_top_nopic", "The most-read articles without images. A good balance.", 2619, "m"),
  _wiki("wikipedia-all-mini", "Wikipedia: Complete (compact)", "wikipedia_en_all_mini", "All 6 million+ articles in a condensed form (about 13 GB).", 13720, "xl"),
  _tool("checklists", "Checklists", "72-hour kit, bug-out bag, first aid and more", "Ready-made preparedness checklists you can tick off, change and print. They stay on this device.", "shield", "#3ecf8e", "checklists"),
  _tool("emergency-card", "Emergency card", "A printable page with your medical info and plan", "Fill in your blood type, allergies, contacts and meeting places, then print a page and a wallet card. Includes your saved map places and the Wi-Fi share details.", "cross", "#ff5a6e", "card"),
  _tool("signals", "Signals and radio", "Morse, spelling alphabet, distress signals, frequencies", "Morse with sound and light, the NATO spelling alphabet, ground-to-air signals, emergency radio frequencies and how to make a radio call.", "globe", "#f0b429", "signals"),
]
# voice typing: a small offline English speech model for the in-page recogniser (vosk-browser, Apache-2.0; model from Alpha Cephei's Vosk models)
EXTRA.append({"id": "speech-en", "type": "tool", "category": "ai", "name": "Voice typing (English)", "tagline": "Dictate into the AI chat, offline",
  "description": "A small English speech recogniser that runs inside the app, so you can talk instead of type in the AI chat with no internet. It needs a microphone and works on this device only. Press the microphone button in the chat.",
  "by": "ALPHA CEPHEI", "source": "https://alphacephei.com/vosk/", "icon": "chip", "color": "#2b8fd9", "sizeClass": "s", "approxMB": 40,
  "install": {"kind": "speech-model", "url": "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz", "file": "vosk-model-small-en-us-0.15.tar.gz"},
  "platforms": ["windows", "linux", "darwin"], "hosts": ["app"], "open": "/ai/"})
for _m in EXTRA: by[_m["id"]] = _m
cat["modules"] = [m for m in cat["modules"] if m["id"] not in {x["id"] for x in EXTRA}] + [by[x["id"]] for x in EXTRA]
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
WIKI_T = {"id": "wikipedia", "name": "Wikipedia", "description": "The encyclopedia, offline. Pick a size.", "icon": "book", "tiers": [
    tier("wiki-quick", "Quick reference", ["wikipedia-top-mini"], "100,000 top articles (about 0.3 GB).", True),
    tier("wiki-popular", "Popular articles", ["wikipedia-top-nopic"], "The most-read articles, no images (about 2 GB)."),
    tier("wiki-all", "Everything", ["wikipedia-all-mini"], "All articles, condensed (about 13 GB).")]}
PREP_T = {"id": "prep", "name": "Preparedness tools", "description": "Checklists, an emergency card and signal references. Tiny, and they work with no internet.", "icon": "check", "tiers": [
    tier("prep-tools", "All three tools", ["checklists", "emergency-card", "signals", "notes"], "Under 1 MB together.", True)]}
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
    tier("ai-best", "Best", ["ai-engine", "qwen25-7b"], "The most capable; needs about 8 GB of memory."),
    tier("ai-ollama-small", "Ollama: Small", ["ollama-engine", "ollama-qwen25-05b"], "The same idea through Ollama (about 0.4 GB)."),
    tier("ai-ollama-balanced", "Ollama: Balanced", ["ollama-engine", "ollama-qwen25-15b"], "Ollama with a better model; needs about 2 GB of memory."),
    tier("ai-voice", "Voice typing", ["speech-en"], "Talk to the AI instead of typing (English, about 40 MB)."),
    tier("ai-ollama-vision", "Ollama: Sees pictures", ["ollama-engine", "ollama-gemma3-4b"], "Attach a photo in the chat and ask about it; needs about 6 GB of memory."),
    tier("ai-ollama-better", "Ollama: Better", ["ollama-engine", "ollama-llama32-3b"], "Ollama with a stronger model; needs about 4 GB of memory.")]},
]
# maps: one topic, a tier per NOMAD region
old_topics = {t["id"]: t for t in cat.get("topics", [])}
regions = [t for k, t in old_topics.items() if k.startswith("maps-")] or [t for t in cat.get("_regions", [])]
if regions: cat["_regions"] = regions
mt = [tier("maps-world", "World overview", ["map-world"], "A small map of the whole world (zoom 0-7).", True)]
for r in regions:
    mt.append(tier(r["id"], r["name"].replace(" (maps)", ""), r["tiers"][0]["modules"], "State maps for this region."))
TOPICS.append({"id": "maps", "name": "Offline maps", "description": "Street maps that work with no signal. Pick your region.", "icon": "map", "tiers": mt})
TOPICS.insert(len(TOPICS) - 1, WIKI_T); TOPICS.insert(len(TOPICS) - 1, PREP_T)
cat["topics"] = [t for t in TOPICS if t["tiers"] and all(t2["modules"] for t2 in t["tiers"])]
cat["tiers"] = [
  {"id": "essential", "name": "Essential", "blurb": "The basics: first aid, water, disaster guides, a world map and a small AI.", "modules": [i for i in ["reader", "water", "medicine", "post-disaster", "www-ready-gov-en", "zimgit-knots-en", "map-world", "ai-engine", "qwen25-05b"] if i in ids]},
  {"id": "standard", "name": "Standard", "blurb": "Adds cooking, coding documentation, more survival guides and a better AI.", "modules": [i for i in ["reader", "water", "medicine", "post-disaster", "www-ready-gov-en", "zimgit-knots-en", "map-world", "nhs-uk-en-medicines", "urban-prepper-en-all", "canadian-prepper-en-bugoutroll", "food", "foss-cooking-en-all", "based-cooking-en-all", "devdocs-en-python", "devdocs-en-javascript", "devdocs-en-html", "devdocs-en-css", "devdocs-en-bash", "devdocs-en-git", "ai-engine", "qwen25-15b"] if i in ids]},
  {"id": "comprehensive", "name": "Comprehensive", "blurb": "Adds electronics, the dictionary, freeCodeCamp and a strong AI. Large downloads.", "modules": [i for i in ["reader", "water", "medicine", "post-disaster", "www-ready-gov-en", "zimgit-knots-en", "map-world", "nhs-uk-en-medicines", "urban-prepper-en-all", "canadian-prepper-en-bugoutroll", "outdoors-se", "food", "cooking", "foss-cooking-en-all", "based-cooking-en-all", "devdocs-en-python", "devdocs-en-javascript", "devdocs-en-html", "devdocs-en-css", "devdocs-en-bash", "devdocs-en-git", "freecodecamp-en-all", "electronics", "arduino-stackexchange-com-en-all", "raspberrypi-stackexchange-com-en-all", "ham-stackexchange-com-en-all", "wiktionary", "ai-engine", "llama32-3b"] if i in ids]},
]
json.dump(cat, open(CAT, "w", encoding="utf-8"), ensure_ascii=False, indent=2 if "\n  " in raw[:80] else None); open(CAT, "a").write("\n")
print("kept %d modules: %s" % (len(cat["modules"]), ", ".join("%s %d" % (c, sum(1 for m in cat["modules"] if m["category"] == c)) for c in dict.fromkeys(m["category"] for m in cat["modules"]))))
print("topics:", ", ".join(t["id"] for t in cat["topics"]))
