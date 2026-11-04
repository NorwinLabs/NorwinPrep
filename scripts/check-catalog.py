#!/usr/bin/env python3
"""Check every module in the catalog against the REAL download servers (needs internet). Exit 1 if any module would fail.
   python3 scripts/check-catalog.py [catalog.json]"""
import json, os, re, sys, functools, urllib.parse, urllib.request, urllib.error
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
    elif k == "static-site":
        try:
            rel = json.loads(get("%s/repos/%s/releases/latest" % (GH, i["repo"]))[2])
            print("     latest release of %s: tag=%r name=%r assets=%s" % (i["repo"], rel.get("tag_name"), rel.get("name"), [(x["name"], x.get("size"), x.get("digest")) for x in rel["assets"]]))
            for r2 in json.loads(get("%s/repos/%s/releases?per_page=6" % (GH, i["repo"]))[2]):
                print("     release %r prerelease=%s assets=%s" % (r2.get("tag_name"), r2.get("prerelease"), [x["name"] for x in r2["assets"]]))
            a = [x for x in rel["assets"] if re.match(i["asset"], x["name"])]
            if not a: report(m, False, "no release asset matches %s (assets: %s)" % (i["asset"], ", ".join(x["name"] for x in rel["assets"][:8]))); continue
            import io, zipfile
            req = urllib.request.Request(a[0]["browser_download_url"], headers=UA)
            data = urllib.request.urlopen(req, timeout=120).read()
            names = zipfile.ZipFile(io.BytesIO(data)).namelist()
            tops = {n.split("/")[0] for n in names}; root = [n for n in names if n.count("/") == (1 if len(tops) == 1 and not any("." in t for t in tops) else 0)]
            pages = [n for n in names if re.search(r"\.html?$", n) and n.count("/") <= 1]
            report(m, bool(pages), "%s %d bytes, digest=%s, pages=%s, entries=%d" % (rel["tag_name"], len(data), a[0].get("digest", "none"), pages[:3], len(names)))
        except Exception as e: report(m, False, str(e))
    elif k == "bundled":
        report(m, os.path.isdir("app/shared/site/" + i["dir"]) if "os" in globals() else True, "ships inside the app: " + i["dir"])
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
# ---- every other link in the repo: catalog "source" pages, README, install/fetch scripts, CDN files ----
import glob, os
SKIP = re.compile(r"(127\.0\.0\.1|localhost|^http://10\.|example\.|norwinprep\.local|evil\.example|0\.0\.0\.0|schemas\.android|^http://x$|github\.com/x/y|github\.com/bot|\.\.\.|\$|^http://$|/releases/download/)")
found = {}
BASES = {"https://api.github.com/repos", "https://download.kiwix.org/release", "https://download.kiwix.org/zim", "https://build.protomaps.com",
         "https://build-metadata.protomaps.dev", "https://cdn.jsdelivr.net/npm"}
def add(u, where):
    u = u.rstrip(".,;:)'\"`>]"); u = re.sub(r"\.git$", "", u)
    if u.rstrip("/") in BASES: return                     # a base the code appends paths to; those real paths are checked above
    if len(u) > 12 and not SKIP.search(u): found.setdefault(u, where)
for m in mods: add(m.get("source", ""), "catalog:" + m["id"]) if m.get("source", "").startswith("http") else None
files = ["README.md", "install.sh", "get.sh", "uninstall.sh"] + glob.glob("scripts/*.sh") + glob.glob("scripts/*.py") + glob.glob("app/desktop/scripts/*.js") + glob.glob("app/shared/site/*.html") + glob.glob("app/shared/site/*.js") + glob.glob("app/desktop/*.js")
for f in files:
    if os.path.basename(f) == "check-catalog.py": continue
    for u in re.findall(r"https?://[A-Za-z0-9._~:/?#@!&*+,;=%-]+", open(f, encoding="utf-8", errors="replace").read()): add(u, f)
for p in ("maplibre-gl@4.7.1/dist/maplibre-gl.js", "maplibre-gl@4.7.1/dist/maplibre-gl.css", "pmtiles@3.2.1/dist/pmtiles.js", "@protomaps/basemaps@5.0.0/dist/basemaps.js"):
    add("https://cdn.jsdelivr.net/npm/" + p, "scripts/fetch-web-assets.sh")
add("https://github.com/protomaps/go-pmtiles/releases/latest", "scripts/install-pmtiles.sh")
print("\n--- %d other links ---" % len(found))
other_bad = []
for u, where in sorted(found.items()):
    code = None
    for method in ("HEAD", "GET"):
        try:
            req = urllib.request.Request(u, method=method, headers={"User-Agent": "Mozilla/5.0 (norwinprep-link-check)", "Range": "bytes=0-0"} if method == "GET" else UA)
            with urllib.request.urlopen(req, timeout=20) as r: code = r.status
            break
        except urllib.error.HTTPError as e:
            code = e.code
            if method == "HEAD" and e.code in (400, 403, 405, 501): continue
            break
        except Exception as e:
            code = str(e)[:60]; break
    good = isinstance(code, int) and code < 400
    blocked = code in (401, 403, 429, 999)
    print(("ok   " if good else "WARN " if blocked else "FAIL ") + "%s  [%s]  (%s)" % (u, code, where))
    if not good and not blocked: other_bad.append(u)
bad += other_bad

# ---- facts for the offline AI assistant (Ollama): release assets and real model sizes from the registry (informational) ----
try:
    rel = json.loads(get("%s/repos/ollama/ollama/releases/latest" % GH)[2])
    print("\n--- ollama %s ---" % rel.get("tag_name"))
    for x in rel["assets"]: print("  asset %-44s %12d  %s" % (x["name"], x["size"], x.get("digest")))
except Exception as e: print("ollama release probe failed:", e)
for mdl in ("llama3.2:1b", "llama3.2:3b", "qwen2.5:0.5b", "qwen2.5:1.5b", "qwen2.5:3b", "qwen2.5:7b", "gemma3:1b", "gemma3:4b", "smollm2:1.7b", "phi3.5:3.8b", "llama3.1:8b", "qwen3:1.7b", "qwen3:4b"):
    name, tag = mdl.split(":")
    try:
        req = urllib.request.Request("https://registry.ollama.ai/v2/library/%s/manifests/%s" % (name, tag), headers=dict(UA, Accept="application/vnd.docker.distribution.manifest.v2+json"))
        mf = json.loads(urllib.request.urlopen(req, timeout=20).read())
        print("  model %-14s layers=%d total=%d bytes media=%s" % (mdl, len(mf["layers"]), sum(l["size"] for l in mf["layers"]) + mf["config"]["size"], sorted({l["mediaType"].split(".")[-1] for l in mf["layers"]})))
    except Exception as e: print("  model %-14s MISSING (%s)" % (mdl, e))

# ---- facts for a leaner AI engine: llama.cpp's llama-server + GGUF models straight from Hugging Face (informational) ----
try:
    rel = json.loads(get("%s/repos/ggml-org/llama.cpp/releases/latest" % GH)[2])
    print("\n--- llama.cpp %s ---" % rel.get("tag_name"))
    for x in rel["assets"]: print("  asset %-60s %11d  %s" % (x["name"], x["size"], x.get("digest")))
except Exception as e: print("llama.cpp release probe failed:", e)
for repo, pat in (("bartowski/Llama-3.2-1B-Instruct-GGUF", "Q4_K_M"), ("bartowski/Llama-3.2-3B-Instruct-GGUF", "Q4_K_M"), ("Qwen/Qwen2.5-0.5B-Instruct-GGUF", "q4_k_m"), ("Qwen/Qwen2.5-1.5B-Instruct-GGUF", "q4_k_m"), ("Qwen/Qwen2.5-3B-Instruct-GGUF", "q4_k_m"),
                  ("bartowski/Qwen2.5-7B-Instruct-GGUF", "Q4_K_M"), ("ggml-org/gemma-3-1b-it-GGUF", "Q4_K_M"), ("ggml-org/gemma-3-4b-it-GGUF", "Q4_K_M"), ("bartowski/Phi-3.5-mini-instruct-GGUF", "Q4_K_M"), ("bartowski/SmolLM2-1.7B-Instruct-GGUF", "Q4_K_M")):
    try:
        info = json.loads(get("https://huggingface.co/api/models/%s" % repo)[2]); tree = json.loads(get("https://huggingface.co/api/models/%s/tree/main" % repo)[2])
        hits = [t for t in tree if pat in t["path"] and t["path"].endswith(".gguf")]
        print("  hf %-40s gated=%s license=%s files=%s" % (repo, info.get("gated"), (info.get("cardData") or {}).get("license"), [(t["path"], t.get("size"), (t.get("lfs") or {}).get("oid")) for t in hits]))
        if hits:
            r = probe("https://huggingface.co/%s/resolve/main/%s" % (repo, hits[0]["path"])); print("     resolve ->", r)
    except Exception as e: print("  hf %-40s MISSING (%s)" % (repo, e))
print("\n%d problem(s)" % len(bad)); sys.exit(1 if bad else 0)
