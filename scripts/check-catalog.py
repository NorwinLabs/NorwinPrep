#!/usr/bin/env python3
"""Check every module in the catalog against the REAL download servers (needs internet). Exit 1 if any module would fail.
   python3 scripts/check-catalog.py [catalog.json]"""
import json, re, sys, functools, urllib.request, urllib.error
print = functools.partial(print, flush=True)

CAT = sys.argv[1] if len(sys.argv) > 1 else "app/shared/site/catalog.json"
KIWIX, PM, GH = "https://download.kiwix.org", "https://build.protomaps.com", "https://api.github.com"
PM_META = "https://build-metadata.protomaps.dev"
UA = {"User-Agent": "norwinprep-catalog-check"}

def get(url, method="GET", n=None):
    req = urllib.request.Request(url, headers=UA, method=method)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, dict(r.headers), (r.read(n).decode("utf-8", "replace") if method == "GET" else "")

def probe(url):
    try:
        s, h, _ = get(url, "HEAD"); return int(h.get("Content-Length", 0)) or True
    except urllib.error.HTTPError as e: return "HTTP %d" % e.code
    except Exception as e: return "%s" % e

bad, listings = [], {}
def listing(url):
    if url not in listings:
        try: listings[url] = get(url)[2]
        except Exception as e: listings[url] = "ERR %s" % e
    return listings[url]

def report(m, ok, msg):
    if not ok and m.get("install", {}).get("kind") == "zim": msg += "\n       CANDIDATES: " + (", ".join(candidates(m)) or "none")
    print(("ok   " if ok else "FAIL ") + "%-26s %s" % (m["id"], msg))
    if not ok: bad.append(m["id"])

def candidates(m):
    """Real file names that look like this module, searched in its folder, other/ and stack_exchange/."""
    key = m["install"]["prefix"].split("_")[0].split(".")[0].lower(); out = set()
    for sub in {m["install"]["subdir"], "other", "stack_exchange"}:
        for f in re.findall(r'href="([^"/]+\.zim)"', listing("%s/zim/%s/" % (KIWIX, sub))):
            if key in f.lower() and re.search(r"_(en|all)", f): out.add(sub + "/" + re.sub(r"_\d{4}-\d{2}\.zim$", "", f))
    return sorted(out)[:12]

mods = json.load(open(CAT, encoding="utf-8"))["modules"]
for m in mods:
    i = m["install"]; k = i["kind"]
    if k == "zim":
        base = "%s/zim/%s/" % (KIWIX, i["subdir"]); html = listing(base)
        if html.startswith("ERR"): report(m, False, "cannot read %s (%s)" % (base, html)); continue
        vs = sorted(set(re.findall(r"%s_(\d{4}-\d{2})\.zim(?![\w])" % re.escape(i["prefix"]), html)))
        if not vs:
            near = sorted(set(re.findall(r'href="(%s[^"]*)\.zim"' % re.escape(i["prefix"].split("_")[0][:8]), html)))[:3]
            report(m, False, "no file %s_YYYY-MM.zim in %s (similar: %s)" % (i["prefix"], base, ", ".join(near) or "none")); continue
        r = probe("%s%s_%s.zim" % (base, i["prefix"], vs[-1])); report(m, r is not None and not isinstance(r, str), "%s %s" % (vs[-1], r))
    elif k == "maps":
        t = listing(PM_META + "/builds.json")
        if not re.search(r"\d{8}(?=\.pmtiles)", t):
            for alt in ("https://build-metadata.protomaps.dev/builds.json",):
                t2 = listing(alt); print("     builds.json head:", t[:200].replace("\n", " "), "| alt", alt, "->", t2[:200].replace("\n", " "))
                if re.search(r"\d{8}", t2): t = t2
        b = sorted(re.findall(r"\d{8}(?=\.pmtiles)", t))
        if b:
            r = probe("%s/%s.pmtiles" % (PM, b[-1])); report(m, r is not None and not isinstance(r, str), "build %s file %s" % (b[-1], r))
        else: report(m, False, "no build list readable")
    elif k == "app":
        try:
            rel = json.loads(get("%s/repos/NorwinLabs/NorwinPrepDisk/releases/latest" % GH)[2]); names = [a["name"] for a in rel["assets"]]
            miss = [s for s in i["suffixes"] if not any(n.endswith("-" + s) for n in names)]
            report(m, not miss, "release %s%s" % (rel["tag_name"], " missing " + ",".join(miss) if miss else ""))
        except Exception as e: report(m, False, str(e))
    elif k == "kiwix-tools":
        base = KIWIX + "/release/kiwix-tools/"; html = listing(base)
        for pat in ("linux-x86_64", "linux-aarch64", "linux-armhf", "win-i686", "macos-x86_64"):
            f = sorted(set(re.findall(r"kiwix-tools_%s-(\d+\.\d+\.\d+)\.(?:tar\.gz|zip)(?![\w.])" % pat, html)))
            report(dict(id="reader/" + pat), bool(f), f[-1] if f else "no archive found in %s" % base)
        if html.startswith("ERR"): report(m, False, html)
# pmtiles tool for map installs
try:
    j = json.loads(get("%s/repos/protomaps/go-pmtiles/releases/latest" % GH)[2]); names = [a["name"] for a in j["assets"]]
    for need in ("Linux_x86_64.tar.gz", "Linux_arm64.tar.gz", "Windows_x86_64.zip"):   # no 32-bit ARM build exists
        report(dict(id="pmtiles/" + need), any(n.endswith(need) for n in names), j["tag_name"])
    print("pmtiles assets:", ", ".join(names))
except Exception as e: report(dict(id="pmtiles"), False, str(e))
top = re.findall(r'href="([^"/]+)/\"', listing(KIWIX + "/zim/")); print("zim folders:", ", ".join(top))
print("\n%d problem(s)" % len(bad)); sys.exit(1 if bad else 0)
