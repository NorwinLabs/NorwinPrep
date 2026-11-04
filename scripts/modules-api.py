#!/usr/bin/env python3
"""NorwinPrep module manager: lists, installs, updates and removes modules (Kiwix content, map regions, client apps).

Runs as the unprivileged `norwinprep` user behind nginx (/api/modules/). Python standard library only.
Reads are public; anything that changes the device needs the admin PIN (header X-NorwinPrep-PIN).
Nothing here runs shell text from the catalog: install kinds are a fixed allowlist with validated fields.
"""
import concurrent.futures
import hashlib
import hmac
import json
import os
import queue
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UA = {"User-Agent": "NorwinPrep-modules"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
SLUG_RE = re.compile(r"^[A-Za-z0-9._-]+$")
PIN_RE = re.compile(r"^[0-9]{4,12}$")
# The NorwinPrep apps serve their screen from a loopback address and call this API from there
LOOPBACK_ORIGIN = re.compile(r"^http://(127\.0\.0\.1|localhost):\d{2,5}$")
TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")
ASSET_RE = re.compile(r"^NorwinPrep-[A-Za-z0-9._-]+\.(apk|exe|AppImage|deb)$")


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


def read_conf(path):
    out = {}
    try:
        for line in open(path, encoding="utf-8"):
            m = re.match(r'^([A-Z_]+)=(?:"([^"]*)"|([^\s#]*))', line.strip())
            if m:
                out[m.group(1)] = m.group(2) if m.group(2) is not None else m.group(3)
    except OSError:
        pass
    return out


def make_config(env=None):
    env = env if env is not None else os.environ
    conf = read_conf(env.get("NORWINPREP_CONF", "/etc/norwinprep.conf"))
    content = env.get("NORWINPREP_CONTENT") or conf.get("CONTENT_DIR") or "/srv/norwinprep/content"
    return {
        "content": content,
        "catalog": env.get("NORWINPREP_CATALOG", "/opt/norwinprep/modules/catalog.json"),
        "admin_file": env.get("NORWINPREP_ADMIN_FILE", "/etc/norwinprep-admin"),
        "kiwix": env.get("NORWINPREP_KIWIX_BASE", "https://download.kiwix.org").rstrip("/"),
        "github_api": env.get("NORWINPREP_API_BASE", "https://api.github.com").rstrip("/"),
        "github_dl": env.get("NORWINPREP_DL_BASE", "https://github.com").rstrip("/"),
        "protomaps": env.get("NORWINPREP_PROTOMAPS_BASE", "https://build.protomaps.com").rstrip("/"),
        "protomaps_meta": env.get("NORWINPREP_PROTOMAPS_META") or ("https://build-metadata.protomaps.dev" if not env.get("NORWINPREP_PROTOMAPS_BASE") else env["NORWINPREP_PROTOMAPS_BASE"].rstrip("/")),
        "slug": env.get("NORWINPREP_SLUG", "NorwinLabs/NorwinPrepDisk"),
        "pmtiles": env.get("NORWINPREP_PMTILES", "/usr/local/bin/pmtiles"),
        "restart_cmd": env.get("NORWINPREP_RESTART_CMD", "sudo -n systemctl restart norwinprep-kiwix.service"),
        "timeout": float(env.get("NORWINPREP_HTTP_TIMEOUT", "30")),
    }


# ---------------------------------------------------------------- catalog

def load_catalog(path):
    data = json.load(open(path, encoding="utf-8"))
    seen, mods = set(), []
    for m in data["modules"]:
        i = m.get("install", {})
        if not ID_RE.match(m.get("id", "")) or m["id"] in seen:
            raise ValueError("bad or duplicate module id: %r" % m.get("id"))
        if m.get("type") not in ("content", "maps", "app", "tool", "model"):
            raise ValueError("bad type for %s" % m["id"])
        if m.get("sizeClass") not in ("s", "m", "l", "xl"):
            raise ValueError("bad sizeClass for %s" % m["id"])
        k = i.get("kind")
        if k == "zim":
            if not (re.match(r"^[a-z0-9_]+$", i.get("subdir", "")) and re.match(r"^[A-Za-z0-9_.-]+$", i.get("prefix", ""))):
                raise ValueError("bad zim spec for %s" % m["id"])
        elif k == "maps":
            if not re.match(r"^[a-z0-9-]+\.pmtiles$", i.get("file", "")) or not 0 <= int(i.get("maxzoom", -1)) <= 15:
                raise ValueError("bad maps spec for %s" % m["id"])
            if "bbox" in i:
                p = [float(x) for x in i["bbox"].split(",")]
                if len(p) != 4 or not (-180 <= p[0] < p[2] <= 180 and -90 <= p[1] < p[3] <= 90):
                    raise ValueError("bad bbox for %s" % m["id"])
        elif k in ("kiwix-tools", "static-site", "bundled", "python-wheel", "llama-cpp", "gguf", "pmtiles-file"):
            pass                         # the app downloads this reader itself; the headless Pi already has kiwix-serve
        elif k == "app":
            if not i.get("suffixes") or not all(re.match(r"^[A-Za-z0-9._-]+$", s) for s in i["suffixes"]):
                raise ValueError("bad app suffixes for %s" % m["id"])
        else:
            raise ValueError("unknown install kind for %s" % m["id"])
        seen.add(m["id"])
        if "pi" in m.get("hosts", ["app", "pi"]):      # modules that only make sense inside the app are not offered by the headless Pi
            mods.append(m)
    return mods


def human(n):
    n = float(n)
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return ("%d %s" % (n, u)) if u == "B" else ("%.1f %s" % (n, u))
        n /= 1024


def vkey(v):
    return [int(x) for x in re.findall(r"\d+", v or "")]


# ---------------------------------------------------------------- the manager

class Manager:
    def __init__(self, cfg):
        self.cfg = cfg
        self.mods = load_catalog(cfg["catalog"])
        self.byid = {m["id"]: m for m in self.mods}
        self.lock = threading.RLock()
        self.jobs = {}                      # id -> {state, percent, message, action, t}
        self.q = queue.Queue()
        self.cache = {}                     # key -> (time, value)
        self.fails = {}                     # ip -> [timestamps]
        self.last_refresh = 0
        self.sizes_running, self.sizes_ok, self.sizes_fail = False, 0, 0
        threading.Thread(target=self._worker, daemon=True, name="modules-worker").start()

    # ---------- dirs
    def d(self, kind):
        p = os.path.join(self.cfg["content"], kind)
        os.makedirs(p, exist_ok=True)
        return p

    # ---------- network helpers (cached listings)
    def http(self, url, method="GET", headers=None, timeout=None):
        req = urllib.request.Request(url, method=method, headers=dict(UA, **(headers or {})))
        return urllib.request.urlopen(req, timeout=timeout or self.cfg["timeout"])

    def text(self, url, maxlen=8_000_000):
        with self.http(url) as r:
            return r.read(maxlen).decode("utf-8", "replace")

    def cached(self, key, fn, ttl=3600, force=False):
        with self.lock:
            hit = self.cache.get(key)
        if hit and not force and time.time() - hit[0] < ttl:
            return hit[1]
        val = fn()
        with self.lock:
            self.cache[key] = (time.time(), val)
        return val

    def kiwix_versions(self, m, force=False):
        i = m["install"]
        url = "%s/zim/%s/" % (self.cfg["kiwix"], i["subdir"])
        try:
            html = self.cached(("list", url), lambda: self.text(url), force=force)
        except urllib.error.HTTPError as e:
            if e.code == 404:                      # no such folder on the server: the book isn't in the library
                return []
            raise
        vs = set(re.findall(r"%s_(\d{4}-\d{2})\.zim(?![\w])" % re.escape(i["prefix"]), html))
        return sorted(vs)

    def latest_release(self, force=False):
        url = "%s/repos/%s/releases/latest" % (self.cfg["github_api"], self.cfg["slug"])

        def fetch():
            j = json.loads(self.text(url))
            if not TAG_RE.match(j.get("tag_name", "")):
                raise ApiError(502, "unexpected release tag")
            return {"tag": j["tag_name"], "assets": {a["name"]: int(a.get("size", 0)) for a in j.get("assets", []) if ASSET_RE.match(a.get("name", "")) or a.get("name") == "SHA256SUMS"}}
        return self.cached(("release", url), fetch, force=force)

    def protomaps_build(self, force=False):
        url = "%s/builds.json" % self.cfg["protomaps_meta"]
        txt = self.cached(("pm", url), lambda: self.text(url), force=force)
        builds = re.findall(r"(\d{8})\.pmtiles", txt)
        if not builds:
            raise ApiError(502, "could not find a Protomaps build")
        return max(builds)

    def head_size(self, url):
        def fetch():
            with self.http(url, method="HEAD") as r:
                n = r.headers.get("Content-Length")
                return int(n) if n and n.isdigit() else None
        return self.cached(("size", url), fetch)

    # ---------- what's installed
    def installed(self, m):
        i = m["install"]
        if i["kind"] == "zim":
            zdir = self.d("zim")
            pat = re.compile(r"^%s_(\d{4}-\d{2})\.zim$" % re.escape(i["prefix"]))
            found = sorted((pat.match(f).group(1), f) for f in os.listdir(zdir) if pat.match(f))
            if not found:
                return None
            ver, f = found[-1]
            p = os.path.join(zdir, f)
            return {"version": ver.replace("-", "."), "files": [f], "bytes": os.path.getsize(p), "updated": os.path.getmtime(p)}
        if i["kind"] == "maps":
            p = os.path.join(self.d("maps"), i["file"])
            if not os.path.isfile(p):
                return None
            return {"version": time.strftime("%Y%m%d", time.gmtime(os.path.getmtime(p))), "files": [i["file"]], "bytes": os.path.getsize(p), "updated": os.path.getmtime(p)}
        adir = self.d("apps")
        files, ver, size, newest = [], None, 0, 0
        for s in i["suffixes"]:
            pat = re.compile(r"^NorwinPrep-(\d+\.\d+\.\d+)-%s$" % re.escape(s))
            hits = sorted(((vkey(pat.match(f).group(1)), f) for f in os.listdir(adir) if pat.match(f)))
            if not hits:
                return None
            v, f = hits[-1]
            files.append(f)
            p = os.path.join(adir, f)
            size += os.path.getsize(p)
            newest = max(newest, os.path.getmtime(p))
            ver = ".".join(map(str, v)) if ver is None or v < vkey(ver) else ver
        return {"version": ver, "files": files, "bytes": size, "updated": newest}

    def latest(self, m):
        """Latest remote version, from cache only (never blocks on the network). None if unknown."""
        i = m["install"]
        try:
            if i["kind"] == "zim":
                url = "%s/zim/%s/" % (self.cfg["kiwix"], i["subdir"])
                with self.lock:
                    hit = self.cache.get(("list", url))
                if not hit:
                    return None
                vs = sorted(set(re.findall(r"%s_(\d{4}-\d{2})\.zim(?![\w])" % re.escape(i["prefix"]), hit[1])))
                return vs[-1].replace("-", ".") if vs else None
            if i["kind"] == "app":
                with self.lock:
                    hit = self.cache.get(("release", "%s/repos/%s/releases/latest" % (self.cfg["github_api"], self.cfg["slug"])))
                return hit[1]["tag"][1:] if hit else None
        except Exception:
            return None
        return None

    def known_size(self, m):
        """Exact download size if the background lookup has found it (cache only; never touches the network)."""
        i = m["install"]
        try:
            if i["kind"] == "zim":
                base = "%s/zim/%s/" % (self.cfg["kiwix"], i["subdir"])
                with self.lock:
                    hit = self.cache.get(("list", base))
                if not hit:
                    return None
                vs = sorted(set(re.findall(r"%s_(\d{4}-\d{2})\.zim(?![\w])" % re.escape(i["prefix"]), hit[1])))
                if not vs:
                    return None
                with self.lock:
                    sz = self.cache.get(("size", "%s%s_%s.zim" % (base, i["prefix"], vs[-1])))
                return sz[1] if sz else None
            if i["kind"] == "app":
                with self.lock:
                    hit = self.cache.get(("release", "%s/repos/%s/releases/latest" % (self.cfg["github_api"], self.cfg["slug"])))
                if not hit:
                    return None
                assets = hit[1]["assets"]
                files = [n for s in i["suffixes"] for n in assets if n.endswith("-" + s)]
                return sum(assets[n] for n in files) if len(files) == len(i["suffixes"]) else None
        except Exception:
            return None
        return None            # maps: the size depends on the region, so there is no exact number up front

    def kick_sizes(self, force=False):
        """Look up exact sizes in the background: at most every 6 hours, and not again for 10 minutes after a failure (offline)."""
        with self.lock:
            now = time.time()
            if self.sizes_running or (not force and (now - self.sizes_ok < 6 * 3600 or now - self.sizes_fail < 600)):
                return
            self.sizes_running = True
        threading.Thread(target=self._resolve_sizes, daemon=True, name="modules-sizes").start()

    def _resolve_sizes(self):
        ok = True
        try:
            zims = [m for m in self.mods if m["install"]["kind"] == "zim"]
            subs = sorted({m["install"]["subdir"] for m in zims})
            failed = 0
            for sub in subs:
                try:
                    self.kiwix_versions(next(m for m in zims if m["install"]["subdir"] == sub), force=True)
                except Exception:
                    failed += 1                  # one bad listing must not hide the others
            if subs and failed == len(subs):
                raise urllib.error.URLError("no library listing reachable")   # offline -> give up, back off

            def one(m):
                try:
                    vs = self.kiwix_versions(m)
                    if not vs:
                        return
                    i = m["install"]
                    self.head_size("%s/zim/%s/%s_%s.zim" % (self.cfg["kiwix"], i["subdir"], i["prefix"], vs[-1]))
                except Exception:
                    pass                         # this one module just shows its estimate
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
                list(ex.map(one, zims))
            try:
                self.latest_release(force=True)
            except Exception:
                pass
        except Exception:
            ok = False
        finally:
            with self.lock:
                self.sizes_running = False
                if ok:
                    self.sizes_ok = time.time()
                else:
                    self.sizes_fail = time.time()

    def sizes_pending(self):
        with self.lock:
            return self.sizes_running

    def disk(self):
        u = shutil.disk_usage(self.d("zim"))
        return {"free": u.free, "total": u.total}

    # ---------- public views
    def catalog(self):
        self.kick_sizes()
        out = []
        for m in self.mods:
            ins = self.installed(m)
            lat = self.latest(m)
            item = {k: m[k] for k in ("id", "type", "name", "tagline", "description", "by", "source", "icon", "color")}
            item.update({k: m[k] for k in ("category", "open") if k in m})
            item["installed"] = bool(ins)
            item["sizeClass"] = m["sizeClass"]
            if not ins:
                ks = self.known_size(m)
                if ks:
                    item["size"] = ks
            if ins:
                item["version"] = ins["version"]
                item["bytes"] = ins["bytes"]
                item["updated"] = int(ins["updated"])
                item["files"] = ins["files"]
            if lat:
                item["latest"] = lat
                item["updateAvailable"] = bool(ins) and vkey(lat) > vkey(ins["version"])
                if not ins:
                    item["version"] = lat
            with self.lock:
                j = self.jobs.get(m["id"])
            if j:
                item["job"] = {k: j[k] for k in ("state", "percent", "message", "action")}
            out.append(item)
        return out

    def status(self):
        with self.lock:
            jobs = {k: {kk: v[kk] for kk in ("state", "percent", "message", "action")} for k, v in self.jobs.items()}
        return {"jobs": jobs, "disk": self.disk()}

    def info(self, mid):
        m = self.byid.get(mid)
        if not m:
            raise ApiError(404, "unknown module")
        i = m["install"]
        res = {"id": mid, "name": m["name"], "free": self.disk()["free"], "bytes": None, "file": None, "version": None}
        try:
            if i["kind"] == "zim":
                vs = self.kiwix_versions(m)
                if not vs:
                    raise ApiError(404, "%s was not found in the Kiwix library" % i["prefix"])
                name = "%s_%s.zim" % (i["prefix"], vs[-1])
                res.update(file=name, version=vs[-1].replace("-", "."), bytes=self.head_size("%s/zim/%s/%s" % (self.cfg["kiwix"], i["subdir"], name)))
            elif i["kind"] == "app":
                rel = self.latest_release()
                files = [n for s in i["suffixes"] for n in rel["assets"] if n.endswith("-" + s)]
                if len(files) != len(i["suffixes"]):
                    raise ApiError(404, "the latest release has no files for this module yet")
                res.update(file=", ".join(files), version=rel["tag"][1:], bytes=sum(rel["assets"][n] for n in files))
            else:
                res.update(file=i["file"], version=self.protomaps_build(), note="Size depends on the region; large regions can be tens of GB and take hours.")
        except urllib.error.HTTPError as e:
            raise ApiError(502, "The download server answered HTTP %d" % e.code)
        except urllib.error.URLError as e:
            raise ApiError(502, "Could not reach the download server (%s)" % getattr(e, "reason", e))
        return res

    def refresh(self):
        if time.time() - self.last_refresh < 15:
            raise ApiError(429, "Refreshed a moment ago")
        self.last_refresh = time.time()
        self.kick_sizes(force=True)
        errors = 0
        for sub in sorted({m["install"]["subdir"] for m in self.mods if m["install"]["kind"] == "zim"}):
            fake = next(m for m in self.mods if m["install"]["kind"] == "zim" and m["install"]["subdir"] == sub)
            try:
                self.kiwix_versions(fake, force=True)
            except Exception:
                errors += 1
        try:
            self.latest_release(force=True)
        except Exception:
            errors += 1
        return {"ok": True, "errors": errors}

    # ---------- admin PIN
    def check_pin(self, pin, ip):
        now = time.time()
        with self.lock:
            recent = [t for t in self.fails.get(ip, []) if now - t < 300]
            total = sum(len([t for t in v if now - t < 300]) for v in self.fails.values())
            if len(recent) >= 5 or total >= 30:
                raise ApiError(429, "Too many wrong PIN attempts. Try again in a few minutes.")
        try:
            salt, want = open(self.cfg["admin_file"], encoding="utf-8").read().strip().split(":")
        except (OSError, ValueError):
            raise ApiError(403, "No admin PIN is set. On the device run: sudo /opt/norwinprep/scripts/set-admin-pin.sh")
        got = hashlib.sha256((salt + (pin or "")).encode()).hexdigest()
        if not (PIN_RE.match(pin or "") and hmac.compare_digest(got, want)):
            with self.lock:
                self.fails.setdefault(ip, []).append(now)
            raise ApiError(403, "Wrong admin PIN")

    # ---------- jobs
    def enqueue(self, mid, action):
        m = self.byid.get(mid)
        if not m:
            raise ApiError(404, "unknown module")
        with self.lock:
            j = self.jobs.get(mid)
            if j and j["state"] in ("queued", "running"):
                raise ApiError(409, "%s is already in progress" % m["name"])
            self.jobs[mid] = {"state": "queued", "percent": 0, "message": "Waiting in line…", "action": action, "t": time.time()}
        self.q.put((mid, action))
        return self.jobs[mid]

    def _set(self, mid, **kw):
        with self.lock:
            self.jobs[mid].update(kw)

    def _worker(self):
        while True:
            mid, action = self.q.get()
            m = self.byid[mid]
            self._set(mid, state="running", message="Starting…")
            try:
                if action == "remove":
                    self._remove(m)
                else:
                    {"zim": self._install_zim, "maps": self._install_maps, "app": self._install_app}[m["install"]["kind"]](m)
                self._set(mid, state="done", percent=100, message="Removed" if action == "remove" else "Installed")
            except ApiError as e:
                self._set(mid, state="error", message=e.msg)
            except urllib.error.HTTPError as e:
                self._set(mid, state="error", message="The download server answered HTTP %d" % e.code)
            except urllib.error.URLError as e:
                self._set(mid, state="error", message="Could not reach the download server (%s)" % getattr(e, "reason", e))
            except Exception as e:      # never let one failure kill the worker
                self._set(mid, state="error", message="Failed: %s" % (str(e)[:200] or e.__class__.__name__))
            with self.lock:             # forget finished jobs after a while so the UI stays tidy
                for k in [k for k, v in self.jobs.items() if v["state"] in ("done", "error") and time.time() - v["t"] > 600]:
                    del self.jobs[k]
            self.jobs[mid]["t"] = time.time()

    def restart_library(self):
        try:
            subprocess.run(shlex.split(self.cfg["restart_cmd"]), timeout=30, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except Exception:
            return False

    # ---------- downloading with progress, resume and SHA-256
    def download(self, mid, url, dest_part, expect_sha=None, label=""):
        have = os.path.getsize(dest_part) if os.path.exists(dest_part) else 0
        h = hashlib.sha256()
        if have:
            with open(dest_part, "rb") as f:
                for blk in iter(lambda: f.read(1 << 20), b""):
                    h.update(blk)
        try:
            resp = self.http(url, headers={"Range": "bytes=%d-" % have} if have else None, timeout=60)
        except urllib.error.HTTPError as e:
            if e.code == 416 and have:             # already complete
                resp = None
            else:
                raise ApiError(502, "Download failed (HTTP %d)" % e.code)
        except urllib.error.URLError as e:
            raise ApiError(502, "Could not reach the download server (%s)" % getattr(e, "reason", e))
        if resp is not None:
            if have and resp.status != 206:       # server ignored Range: start over
                have, h = 0, hashlib.sha256()
            clen = resp.headers.get("Content-Length")
            total = have + int(clen) if clen and clen.isdigit() else 0
            done = have
            with resp, open(dest_part, "ab" if have else "wb") as out:
                while True:
                    blk = resp.read(1 << 20)
                    if not blk:
                        break
                    h.update(blk)
                    out.write(blk)
                    done += len(blk)
                    if total:
                        self._set(mid, state="running", percent=min(99, int(done * 100 / total)),
                                  message="%s%s of %s" % (label, human(done), human(total)))
            if total and done != total:
                raise ApiError(502, "Download was cut short; press Install to resume")
        if expect_sha and h.hexdigest() != expect_sha:
            try:
                os.unlink(dest_part)
            except OSError:
                pass
            raise ApiError(502, "Checksum mismatch. The download was discarded and not installed.")
        return h.hexdigest()

    def kiwix_sha(self, url):
        try:
            tok = self.text(url + ".sha256", 4096).split()
            return tok[0].lower() if tok and re.match(r"^[0-9a-fA-F]{64}$", tok[0]) else None
        except Exception:
            return None

    # ---------- installers
    def _check_space(self, need):
        free = self.disk()["free"]
        if need and free < need * 1.05 + (50 << 20):
            raise ApiError(507, "Not enough free space: needs %s, only %s free" % (human(need), human(free)))

    def _install_zim(self, m):
        i, zdir = m["install"], self.d("zim")
        vs = self.kiwix_versions(m, force=True)
        if not vs:
            raise ApiError(404, "%s was not found in the Kiwix library" % i["prefix"])
        name = "%s_%s.zim" % (i["prefix"], vs[-1])
        url = "%s/zim/%s/%s" % (self.cfg["kiwix"], i["subdir"], name)
        size = None
        try:
            size = self.head_size(url)
        except Exception:
            pass
        self._check_space(size)
        part = os.path.join(zdir, "." + name + ".part")
        sha = self.kiwix_sha(url)
        self.download(m["id"], url, part, sha, label="")
        self._set(m["id"], percent=99, message="Finishing…")
        os.replace(part, os.path.join(zdir, name))
        for f in os.listdir(zdir):                  # drop older editions of the same title
            mm = re.match(r"^%s_(\d{4}-\d{2})\.zim$" % re.escape(i["prefix"]), f)
            if mm and f != name:
                os.unlink(os.path.join(zdir, f))
        if not self.restart_library():
            self._set(m["id"], message="Installed (restart the library service to see it)")

    def _install_maps(self, m):
        i, mdir = m["install"], self.d("maps")
        pm = self.cfg["pmtiles"]
        if not (os.path.isfile(pm) and os.access(pm, os.X_OK)):
            raise ApiError(500, "The pmtiles tool is missing. Run: sudo /opt/norwinprep/scripts/install-pmtiles.sh")
        try:
            build = self.protomaps_build(force=True)
        except urllib.error.URLError as e:
            raise ApiError(502, "Could not reach the map server (%s)" % getattr(e, "reason", e))
        self._check_space(1 << 30)
        tmp = os.path.join(mdir, "." + i["file"] + ".part")
        if os.path.exists(tmp):
            os.unlink(tmp)
        cmd = [pm, "extract", "%s/%s.pmtiles" % (self.cfg["protomaps"], build), tmp, "--maxzoom=%d" % int(i["maxzoom"])]
        if "bbox" in i:
            cmd.append("--bbox=" + i["bbox"])
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        t0 = time.time()
        while proc.poll() is None:
            sz = os.path.getsize(tmp) if os.path.exists(tmp) else 0
            self._set(m["id"], state="running", percent=0, message="Downloading map tiles… %s so far (%d min)" % (human(sz), int((time.time() - t0) / 60)))
            time.sleep(1)
        if proc.returncode != 0:
            err = (proc.stderr.read() or b"").decode("utf-8", "replace").strip().splitlines()[-1:] or ["pmtiles failed"]
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise ApiError(502, "Map download failed: %s" % err[0][:150])
        os.replace(tmp, os.path.join(mdir, i["file"]))

    def _install_app(self, m):
        i, adir = m["install"], self.d("apps")
        try:
            rel = self.latest_release(force=True)
        except urllib.error.URLError as e:
            raise ApiError(502, "Could not reach GitHub (%s)" % getattr(e, "reason", e))
        base = "%s/%s/releases/download/%s/" % (self.cfg["github_dl"], self.cfg["slug"], rel["tag"])
        names = []
        for s in i["suffixes"]:
            hit = [n for n in rel["assets"] if n.endswith("-" + s) and ASSET_RE.match(n)]
            if not hit:
                raise ApiError(404, "The latest release has no %s file yet" % s)
            names.append((s, hit[0]))
        self._check_space(sum(rel["assets"][n] for _, n in names))
        sums = {}
        for line in self.text(base + "SHA256SUMS", 1_000_000).splitlines():
            p = line.split()
            if len(p) >= 2:
                sums[p[1].lstrip("*")] = p[0].lower()
        for k, (s, n) in enumerate(names):
            if not re.match(r"^[0-9a-f]{64}$", sums.get(n, "")):
                raise ApiError(502, "No checksum published for %s" % n)
            part = os.path.join(adir, "." + n + ".part")
            self.download(m["id"], base + n, part, sums[n], label="%s: " % n)
            os.replace(part, os.path.join(adir, n))
            for f in os.listdir(adir):              # drop older versions of the same file
                if f != n and re.match(r"^NorwinPrep-\d+\.\d+\.\d+-%s$" % re.escape(s), f):
                    os.unlink(os.path.join(adir, f))

    def _remove(self, m):
        ins = self.installed(m)
        if not ins:
            raise ApiError(404, "Not installed")
        folder = {"zim": "zim", "maps": "maps", "app": "apps"}[m["install"]["kind"]]
        for f in ins["files"]:
            os.unlink(os.path.join(self.d(folder), f))
        if m["install"]["kind"] == "zim":
            self.restart_library()


# ---------------------------------------------------------------- HTTP

def make_handler(mgr):
    class H(BaseHTTPRequestHandler):
        server_version = "NorwinPrepModules"
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def ip(self):
            peer = self.client_address[0]
            return (self.headers.get("X-Real-IP") or peer) if peer in ("127.0.0.1", "::1") else peer

        def origin_ok(self):
            """Browsers send Origin on cross-site requests. Accept our own pages and the apps' loopback pages only."""
            o = self.headers.get("Origin")
            if not o:
                return True
            if LOOPBACK_ORIGIN.match(o):
                return True
            host = (self.headers.get("Host") or "").split(":")[0]
            return urllib.parse.urlparse(o).hostname == host and bool(host)

        def cors(self):
            o = self.headers.get("Origin")
            if o and LOOPBACK_ORIGIN.match(o):
                self.send_header("Access-Control-Allow-Origin", o)
                self.send_header("Vary", "Origin")

        def do_OPTIONS(self):              # CORS preflight from the apps
            o = self.headers.get("Origin")
            self.send_response(204 if (o and LOOPBACK_ORIGIN.match(o)) else 403)
            if o and LOOPBACK_ORIGIN.match(o):
                self.cors()
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-NorwinPrep, X-NorwinPrep-PIN")
                self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def send_json(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 4096:
                raise ApiError(413, "Request too large")
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                raise ApiError(400, "Invalid JSON")

        def handle_any(self, method):
            try:
                u = urllib.parse.urlparse(self.path)
                path, q = u.path.rstrip("/"), urllib.parse.parse_qs(u.query)
                if not path.startswith("/api/modules"):
                    raise ApiError(404, "Not found")
                route = path[len("/api/modules"):] or "/"
                if method == "GET":
                    if route == "/catalog":
                        mgr.kick_sizes()
                        pending = mgr.sizes_pending()        # read BEFORE building the list: if it says "done", the list below has every size
                        return self.send_json(200, {"modules": mgr.catalog(), "disk": mgr.disk(), "sizesPending": pending})
                    if route == "/status":
                        return self.send_json(200, mgr.status())
                    if route == "/info":
                        return self.send_json(200, mgr.info((q.get("id") or [""])[0]))
                    raise ApiError(404, "Not found")
                # writes: need the custom header (blocks cross-site forms), a trusted Origin, and most need the PIN
                if not self.origin_ok():
                    raise ApiError(403, "Forbidden")
                if self.headers.get("X-NorwinPrep") != "1" and "X-NorwinPrep-PIN" not in self.headers:
                    raise ApiError(403, "Forbidden")
                data = self.body()
                if route == "/refresh":
                    return self.send_json(200, mgr.refresh())
                mgr.check_pin(self.headers.get("X-NorwinPrep-PIN", ""), self.ip())
                if route == "/pin":
                    return self.send_json(200, {"ok": True})
                if route in ("/install", "/remove"):
                    job = mgr.enqueue(str(data.get("id", "")), route[1:])
                    return self.send_json(202, {k: job[k] for k in ("state", "percent", "message", "action")})
                raise ApiError(404, "Not found")
            except ApiError as e:
                self.send_json(e.code, {"error": e.msg})
            except Exception as e:
                self.send_json(500, {"error": "Server error: %s" % e.__class__.__name__})

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")
    return H


def serve(cfg, host="127.0.0.1", port=8090):
    mgr = Manager(cfg)
    srv = ThreadingHTTPServer((host, port), make_handler(mgr))
    srv.daemon_threads = True
    return srv, mgr


if __name__ == "__main__":
    port = int(os.environ.get("NORWINPREP_MODULES_PORT", "8090"))
    srv, _ = serve(make_config(), port=port)
    print("NorwinPrep module manager on 127.0.0.1:%d" % port, flush=True)
    srv.serve_forever()
