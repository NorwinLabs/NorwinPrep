#!/usr/bin/env python3
"""Tests for modules-api.py against fake Kiwix / GitHub / Protomaps servers. Run: python3 scripts/test_modules_api.py"""
import hashlib, http.client, importlib.util, json, os, re, shutil, stat, sys, tempfile, threading, time, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("modules_api", os.path.join(HERE, "modules-api.py"))
api = importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
CATALOG = os.path.join(HERE, "..", "app", "shared", "site", "catalog.json")
sha = lambda b: hashlib.sha256(b).hexdigest()
PIN = "123456"

ZIM = os.urandom(300_000)
ZIM_NEW = ZIM
WATER = os.urandom(120_000)
APK = os.urandom(50_000); EXE = os.urandom(60_000); PORT_EXE = os.urandom(61_000)
FAKE = {"sha_ok": True, "sha_missing": False, "listing_new": "2025-03", "tag": "v0.6.9", "apk_sum_ok": True, "pm_ok": True}


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def out(self, code, body=b"", ctype="text/plain", extra=None, head=False):
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers()
        if not head: self.wfile.write(body)
    def do_HEAD(self): self.route(True)
    def do_GET(self): self.route(False)
    def route(self, head):
        p = self.path.split("?")[0]
        zims = {"/zim/other/zimgit-medicine_en_%s.zim" % FAKE["listing_new"]: ZIM, "/zim/other/zimgit-water_en_2025-01.zim": WATER}
        if p == "/zim/other/":
            html = "".join('<a href="%s">%s</a>\n<a href="%s.sha256">x</a>' % (n.split("/")[-1], n.split("/")[-1], n.split("/")[-1]) for n in zims)
            html += '<a href="zimgit-medicine_en_2024-06.zim">old</a>'
            return self.out(200, html.encode(), "text/html", head=head)
        if p in zims:
            data = zims[p]; rng = self.headers.get("Range")
            if rng and not head:
                start = int(re.match(r"bytes=(\d+)-", rng).group(1))
                return self.out(206, data[start:], "application/octet-stream", {"Content-Range": "bytes %d-%d/%d" % (start, len(data) - 1, len(data))})
            return self.out(200, data, "application/octet-stream", head=head)
        if p.endswith(".zim.sha256") and p[:-7] in zims:
            if FAKE["sha_missing"]: return self.out(404, b"no")
            h = sha(zims[p[:-7]]) if FAKE["sha_ok"] else "0" * 64
            return self.out(200, ("%s  %s\n" % (h, p.split("/")[-1][:-7])).encode())
        if p == "/repos/NorwinLabs/NorwinPrepDisk/releases/latest":
            t = FAKE["tag"][1:]
            assets = [{"name": "NorwinPrep-%s-android.apk" % t, "size": len(APK)}, {"name": "NorwinPrep-%s-win-x64.exe" % t, "size": len(EXE)},
                      {"name": "NorwinPrep-%s-portable-x64.exe" % t, "size": len(PORT_EXE)}, {"name": "SHA256SUMS", "size": 400}, {"name": "random.txt", "size": 1}]
            return self.out(200, json.dumps({"tag_name": FAKE["tag"], "assets": assets}).encode(), "application/json")
        m = re.match(r"^/NorwinLabs/NorwinPrepDisk/releases/download/(v[\d.]+)/(.+)$", p)
        if m:
            t = m.group(1)[1:]; files = {"NorwinPrep-%s-android.apk" % t: APK, "NorwinPrep-%s-win-x64.exe" % t: EXE, "NorwinPrep-%s-portable-x64.exe" % t: PORT_EXE}
            if m.group(2) == "SHA256SUMS":
                return self.out(200, "".join("%s  %s\n" % ("1" * 64 if (n.endswith(".apk") and not FAKE["apk_sum_ok"]) else sha(b), n) for n, b in files.items()).encode())
            if m.group(2) in files: return self.out(200, files[m.group(2)], "application/octet-stream")
        if p == "/builds.json": return self.out(200, b'[{"key":"20260101.pmtiles"},{"key":"20260301.pmtiles"}]', "application/json")
        self.out(404, b"nope")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="npmod-")
        self.fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake); self.fake.daemon_threads = True
        threading.Thread(target=self.fake.serve_forever, daemon=True).start()
        fb = "http://127.0.0.1:%d" % self.fake.server_address[1]
        self.restarts = os.path.join(self.tmp, "restarts")
        pm = os.path.join(self.tmp, "pmtiles"); open(pm, "w").write('#!/bin/sh\n[ "$FAKE_PM_FAIL" = 1 ] && { echo "boom: source unreachable" >&2; exit 1; }\nprintf "PM:%s" "$2" > "$3"\n'); os.chmod(pm, 0o755)
        salt = "ab12cd34"; open(os.path.join(self.tmp, "admin"), "w").write("%s:%s" % (salt, sha((salt + PIN).encode())))
        for k in FAKE: FAKE[k] = {"sha_ok": True, "sha_missing": False, "listing_new": "2025-03", "tag": "v0.6.9", "apk_sum_ok": True, "pm_ok": True}[k]
        os.environ.pop("FAKE_PM_FAIL", None)
        cfg = api.make_config({"NORWINPREP_CONF": "/nonexistent", "NORWINPREP_CONTENT": os.path.join(self.tmp, "content"), "NORWINPREP_CATALOG": CATALOG,
            "NORWINPREP_ADMIN_FILE": os.path.join(self.tmp, "admin"), "NORWINPREP_KIWIX_BASE": fb, "NORWINPREP_API_BASE": fb, "NORWINPREP_DL_BASE": fb,
            "NORWINPREP_PROTOMAPS_BASE": fb, "NORWINPREP_PMTILES": pm, "NORWINPREP_HTTP_TIMEOUT": "5",
            "NORWINPREP_RESTART_CMD": "sh -c 'echo x >> %s'" % self.restarts})
        self.srv, self.mgr = api.serve(cfg, port=0)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        self.zim = os.path.join(self.tmp, "content", "zim"); self.maps = os.path.join(self.tmp, "content", "maps"); self.apps = os.path.join(self.tmp, "content", "apps")
    def tearDown(self):
        self.srv.shutdown(); self.fake.shutdown()
        shutil.rmtree(self.tmp, ignore_errors=True)
    def call(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        h = dict(headers or {}); data = None
        if body is not None: data = body if isinstance(body, bytes) else json.dumps(body).encode(); h["Content-Type"] = "application/json"
        c.request(method, path, data, h); r = c.getresponse(); raw = r.read(); c.close()
        try: return r.status, json.loads(raw)
        except ValueError: return r.status, raw
    def get(self, path): return self.call("GET", path)
    def post(self, path, body=None, pin=PIN, extra=None):
        h = {"X-NorwinPrep": "1"}
        if pin is not None: h["X-NorwinPrep-PIN"] = pin
        h.update(extra or {})
        return self.call("POST", path, {} if body is None else body, h)
    def mod(self, mid): return next(m for m in self.get("/api/modules/catalog")[1]["modules"] if m["id"] == mid)
    def wait(self, mid, timeout=30):
        t0 = time.time()
        while time.time() - t0 < timeout:
            j = self.get("/api/modules/status")[1]["jobs"].get(mid)
            if j and j["state"] in ("done", "error"): return j
            time.sleep(0.05)
        self.fail("job %s did not finish: %s" % (mid, self.get("/api/modules/status")[1]["jobs"].get(mid)))
    def restart_count(self): return len(open(self.restarts).read().split()) if os.path.exists(self.restarts) else 0


class CatalogTests(Base):
    def test_real_catalog_is_valid(self):
        mods = api.load_catalog(CATALOG)
        self.assertGreaterEqual(len(mods), 40)
        self.assertEqual({m["type"] for m in mods}, {"content", "maps", "app"})
        self.assertEqual(len({m["id"] for m in mods}), len(mods))
        for m in mods: self.assertTrue(m["name"] and m["tagline"] and m["description"] and m["icon"] and re.match(r"^#[0-9a-f]{6}$", m["color"]), m["id"])
    def test_bad_catalogs_rejected(self):
        for bad in [{"id": "../x", "type": "content", "install": {"kind": "zim", "subdir": "a", "prefix": "b"}},
                    {"id": "ok1", "type": "content", "install": {"kind": "zim", "subdir": "../etc", "prefix": "b"}},
                    {"id": "ok2", "type": "content", "install": {"kind": "shell", "cmd": "rm -rf /"}},
                    {"id": "ok3", "type": "maps", "install": {"kind": "maps", "file": "../x.pmtiles", "maxzoom": 7}},
                    {"id": "ok4", "type": "maps", "install": {"kind": "maps", "file": "a.pmtiles", "maxzoom": 7, "bbox": "1,2,3"}},
                    {"id": "ok5", "type": "app", "install": {"kind": "app", "suffixes": ["a/../b"]}}]:
            p = os.path.join(self.tmp, "bad.json"); json.dump({"modules": [bad]}, open(p, "w"))
            with self.assertRaises((ValueError, KeyError, TypeError)): api.load_catalog(p)
    def test_catalog_starts_empty(self):
        s, c = self.get("/api/modules/catalog")
        self.assertEqual(s, 200); self.assertTrue(all(not m["installed"] for m in c["modules"])); self.assertGreater(c["disk"]["free"], 0)
    def test_detects_installed_and_update(self):
        os.makedirs(self.zim); open(os.path.join(self.zim, "zimgit-medicine_en_2024-06.zim"), "wb").write(b"x" * 10)
        m = self.mod("medicine"); self.assertTrue(m["installed"]); self.assertEqual(m["version"], "2024.06"); self.assertNotIn("updateAvailable", m)
        self.assertEqual(self.post("/api/modules/refresh")[0], 200)
        m = self.mod("medicine"); self.assertEqual(m["latest"], "2025.03"); self.assertTrue(m["updateAvailable"])
        w = self.mod("water"); self.assertFalse(w["installed"]); self.assertEqual(w["version"], "2025.01")
    def test_refresh_is_throttled(self):
        self.assertEqual(self.post("/api/modules/refresh")[0], 200); self.assertEqual(self.post("/api/modules/refresh")[0], 429)


class AuthTests(Base):
    def test_writes_need_header_and_pin(self):
        self.assertEqual(self.call("POST", "/api/modules/install", {"id": "water"})[0], 403)
        self.assertEqual(self.post("/api/modules/install", {"id": "water"}, pin=None)[0], 403)
        s, r = self.post("/api/modules/install", {"id": "water"}, pin="000000"); self.assertEqual(s, 403); self.assertIn("Wrong", r["error"])
        self.assertEqual(self.post("/api/modules/pin")[0], 200)
        self.assertFalse(self.mod("water")["installed"] or "job" in self.mod("water"))
    def test_pin_must_be_digits(self):
        self.assertEqual(self.post("/api/modules/pin", pin="12 34")[0], 403); self.assertEqual(self.post("/api/modules/pin", pin="abcdef")[0], 403)
    def test_brute_force_is_locked_out(self):
        codes = [self.post("/api/modules/pin", pin="99999%d" % i)[0] for i in range(7)]
        self.assertEqual(codes[:5], [403] * 5); self.assertEqual(codes[5:], [429, 429])
        self.assertEqual(self.post("/api/modules/pin")[0], 429, "even the right PIN is refused while locked out")
    def test_lockout_is_per_client(self):
        for i in range(5): self.post("/api/modules/pin", pin="99999%d" % i, extra={"X-Real-IP": "10.42.0.50"})
        self.assertEqual(self.post("/api/modules/pin", extra={"X-Real-IP": "10.42.0.51"})[0], 200)
    def test_no_pin_configured_means_read_only(self):
        os.unlink(os.path.join(self.tmp, "admin"))
        s, r = self.post("/api/modules/install", {"id": "water"}); self.assertEqual(s, 403); self.assertIn("set-admin-pin", r["error"])
        self.assertEqual(self.get("/api/modules/catalog")[0], 200)
    def test_bad_requests(self):
        self.assertEqual(self.post("/api/modules/install", {"id": "nope"})[0], 404)
        for bad in ["../../etc/passwd", "water; rm -rf /", "", "A" * 80]: self.assertEqual(self.post("/api/modules/install", {"id": bad})[0], 404, bad)
        self.assertEqual(self.call("POST", "/api/modules/install", b"{not json", {"X-NorwinPrep": "1", "X-NorwinPrep-PIN": PIN})[0], 400)
        self.assertEqual(self.call("POST", "/api/modules/install", b"x" * 5000, {"X-NorwinPrep": "1", "X-NorwinPrep-PIN": PIN})[0], 413)
        self.assertEqual(self.get("/api/modules/nothing")[0], 404); self.assertEqual(self.get("/elsewhere")[0], 404)
        self.assertEqual(self.post("/api/modules/nothing")[0], 404)


class ContentTests(Base):
    def test_info(self):
        s, i = self.get("/api/modules/info?id=medicine"); self.assertEqual(s, 200)
        self.assertEqual((i["file"], i["version"], i["bytes"]), ("zimgit-medicine_en_2025-03.zim", "2025.03", len(ZIM))); self.assertGreater(i["free"], 0)
        self.assertEqual(self.get("/api/modules/info?id=nope")[0], 404)
        s, i = self.get("/api/modules/info?id=survival-se"); self.assertEqual(s, 404); self.assertIn("not found in the Kiwix library", i["error"])
    def test_info_when_kiwix_unreachable(self):
        self.mgr.cfg["kiwix"] = "http://127.0.0.1:1"; s, i = self.get("/api/modules/info?id=medicine"); self.assertEqual(s, 502); self.assertIn("Could not reach", i["error"])
    def test_install_verifies_and_replaces_old(self):
        os.makedirs(self.zim); old = os.path.join(self.zim, "zimgit-medicine_en_2024-06.zim"); open(old, "wb").write(b"old")
        s, r = self.post("/api/modules/install", {"id": "medicine"}); self.assertEqual(s, 202)
        j = self.wait("medicine"); self.assertEqual(j["state"], "done", j)
        self.assertEqual(open(os.path.join(self.zim, "zimgit-medicine_en_2025-03.zim"), "rb").read(), ZIM)
        self.assertFalse(os.path.exists(old), "older edition removed"); self.assertEqual([f for f in os.listdir(self.zim) if f.endswith(".part")], [])
        self.assertEqual(self.restart_count(), 1, "library restarted so the new book shows up")
        m = self.mod("medicine"); self.assertTrue(m["installed"]); self.assertEqual(m["version"], "2025.03")
    def test_bad_checksum_installs_nothing(self):
        FAKE["sha_ok"] = False; self.post("/api/modules/install", {"id": "medicine"})
        j = self.wait("medicine"); self.assertEqual(j["state"], "error"); self.assertIn("Checksum mismatch", j["message"])
        self.assertEqual(os.listdir(self.zim), [], "no file and no .part left"); self.assertEqual(self.restart_count(), 0)
    def test_missing_checksum_file_still_installs(self):
        FAKE["sha_missing"] = True; self.post("/api/modules/install", {"id": "medicine"}); self.assertEqual(self.wait("medicine")["state"], "done")
    def test_resume_partial_download(self):
        os.makedirs(self.zim); open(os.path.join(self.zim, ".zimgit-medicine_en_2025-03.zim.part"), "wb").write(ZIM[:100_000])
        self.post("/api/modules/install", {"id": "medicine"}); self.assertEqual(self.wait("medicine")["state"], "done")
        self.assertEqual(open(os.path.join(self.zim, "zimgit-medicine_en_2025-03.zim"), "rb").read(), ZIM, "resumed file is byte-identical (and passed the full-file checksum)")
    def test_resume_with_corrupt_part_is_caught(self):
        os.makedirs(self.zim); open(os.path.join(self.zim, ".zimgit-medicine_en_2025-03.zim.part"), "wb").write(b"\x00" * 100_000)
        self.post("/api/modules/install", {"id": "medicine"}); j = self.wait("medicine"); self.assertEqual(j["state"], "error"); self.assertIn("Checksum", j["message"])
        self.assertFalse(os.path.exists(os.path.join(self.zim, "zimgit-medicine_en_2025-03.zim")))
    def test_queue_and_duplicate(self):
        a = self.post("/api/modules/install", {"id": "medicine"}); b = self.post("/api/modules/install", {"id": "water"})
        self.assertEqual((a[0], b[0]), (202, 202)); self.assertEqual(self.post("/api/modules/install", {"id": "water"})[0], 409)
        self.assertEqual(self.wait("medicine")["state"], "done"); self.assertEqual(self.wait("water")["state"], "done")
        self.assertTrue(self.mod("water")["installed"] and self.mod("medicine")["installed"])
    def test_not_enough_space(self):
        self.mgr.disk = lambda: {"free": 1000, "total": 10 ** 9}
        self.post("/api/modules/install", {"id": "medicine"}); j = self.wait("medicine"); self.assertEqual(j["state"], "error"); self.assertIn("Not enough free space", j["message"])
        self.assertTrue(not os.path.exists(self.zim) or os.listdir(self.zim) == [])
    def test_not_in_library(self):
        self.post("/api/modules/install", {"id": "survival-se"}); j = self.wait("survival-se"); self.assertEqual(j["state"], "error"); self.assertIn("not found", j["message"])
    def test_remove(self):
        self.post("/api/modules/install", {"id": "water"}); self.wait("water")
        self.assertEqual(self.post("/api/modules/remove", {"id": "water"})[0], 202); self.assertEqual(self.wait("water")["state"], "done")
        self.assertFalse(self.mod("water")["installed"]); self.assertEqual(self.restart_count(), 2)
        self.post("/api/modules/remove", {"id": "water"}); self.assertEqual(self.wait("water")["state"], "error")
    def test_server_survives_restart_failure(self):
        self.mgr.cfg["restart_cmd"] = "false"; self.post("/api/modules/install", {"id": "water"}); j = self.wait("water")
        self.assertEqual(j["state"], "done"); self.assertTrue(self.mod("water")["installed"])


class MapsAndAppsTests(Base):
    def test_map_install(self):
        self.post("/api/modules/install", {"id": "map-world"}); j = self.wait("map-world"); self.assertEqual(j["state"], "done", j)
        self.assertTrue(open(os.path.join(self.maps, "world.pmtiles")).read().endswith("20260301.pmtiles"), "uses the newest Protomaps build")
        self.assertEqual([f for f in os.listdir(self.maps) if f.startswith(".")], []); self.assertTrue(self.mod("map-world")["installed"])
    def test_map_failure_leaves_nothing(self):
        os.environ["FAKE_PM_FAIL"] = "1"; self.post("/api/modules/install", {"id": "map-usa"}); j = self.wait("map-usa")
        self.assertEqual(j["state"], "error"); self.assertIn("source unreachable", j["message"]); self.assertEqual(os.listdir(self.maps), [])
    def test_map_needs_tool(self):
        self.mgr.cfg["pmtiles"] = "/nonexistent/pmtiles"; self.post("/api/modules/install", {"id": "map-world"}); j = self.wait("map-world")
        self.assertEqual(j["state"], "error"); self.assertIn("install-pmtiles", j["message"])
    def test_remove_map(self):
        self.post("/api/modules/install", {"id": "map-world"}); self.wait("map-world"); self.post("/api/modules/remove", {"id": "map-world"}); self.wait("map-world")
        self.assertFalse(os.path.exists(os.path.join(self.maps, "world.pmtiles")))
    def test_app_install_verifies_all_files_and_replaces_old(self):
        os.makedirs(self.apps); old = os.path.join(self.apps, "NorwinPrep-0.6.1-win-x64.exe"); open(old, "wb").write(b"old")
        self.post("/api/modules/install", {"id": "app-windows"}); j = self.wait("app-windows"); self.assertEqual(j["state"], "done", j)
        self.assertEqual(sorted(os.listdir(self.apps)), ["NorwinPrep-0.6.9-portable-x64.exe", "NorwinPrep-0.6.9-win-x64.exe"])
        self.assertEqual(open(os.path.join(self.apps, "NorwinPrep-0.6.9-win-x64.exe"), "rb").read(), EXE)
        m = self.mod("app-windows"); self.assertTrue(m["installed"]); self.assertEqual(m["version"], "0.6.9")
    def test_app_bad_checksum(self):
        FAKE["apk_sum_ok"] = False; self.post("/api/modules/install", {"id": "app-android"}); j = self.wait("app-android")
        self.assertEqual(j["state"], "error"); self.assertIn("Checksum mismatch", j["message"]); self.assertEqual(os.listdir(self.apps), [])
    def test_app_missing_from_release(self):
        self.post("/api/modules/install", {"id": "app-pi64"}); j = self.wait("app-pi64"); self.assertEqual(j["state"], "error"); self.assertIn("no linux-arm64", j["message"])
    def test_app_update_detection(self):
        os.makedirs(self.apps); open(os.path.join(self.apps, "NorwinPrep-0.6.1-android.apk"), "wb").write(b"x")
        self.post("/api/modules/refresh"); m = self.mod("app-android"); self.assertEqual((m["version"], m["latest"], m["updateAvailable"]), ("0.6.1", "0.6.9", True))
        self.post("/api/modules/install", {"id": "app-android"}); self.wait("app-android")
        self.assertFalse(self.mod("app-android")["updateAvailable"])
    def test_app_info(self):
        s, i = self.get("/api/modules/info?id=app-windows"); self.assertEqual(s, 200); self.assertEqual(i["bytes"], len(EXE) + len(PORT_EXE)); self.assertEqual(i["version"], "0.6.9")


class CorsTests(Base):
    """The apps serve their screen from http://127.0.0.1:<port> and call this API from there."""
    def raw(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body, headers or {}); r = c.getresponse(); data = r.read(); h = {k.lower(): v for k, v in r.getheaders()}; c.close()
        return r.status, h, data
    def test_preflight_allowed_for_app_origin(self):
        s, h, _ = self.raw("OPTIONS", "/api/modules/install", {"Origin": "http://127.0.0.1:8787", "Access-Control-Request-Method": "POST"})
        self.assertEqual(s, 204); self.assertEqual(h["access-control-allow-origin"], "http://127.0.0.1:8787")
        self.assertIn("x-norwinprep-pin", h["access-control-allow-headers"].lower()); self.assertIn("POST", h["access-control-allow-methods"])
        s, h, _ = self.raw("OPTIONS", "/api/modules/install", {"Origin": "http://localhost:51234"}); self.assertEqual(s, 204)
    def test_preflight_refused_for_other_sites(self):
        for o in ["https://evil.example", "http://evil.example", "http://127.0.0.1.evil.example:8787", "http://localhost.evil.example:80", "null", "http://127.0.0.1"]:
            s, h, _ = self.raw("OPTIONS", "/api/modules/install", {"Origin": o}); self.assertEqual(s, 403, o); self.assertNotIn("access-control-allow-origin", h, o)
    def test_reads_expose_cors_only_to_app_origin(self):
        s, h, _ = self.raw("GET", "/api/modules/catalog", {"Origin": "http://127.0.0.1:8787"}); self.assertEqual((s, h.get("access-control-allow-origin")), (200, "http://127.0.0.1:8787"))
        s, h, _ = self.raw("GET", "/api/modules/catalog", {"Origin": "https://evil.example"}); self.assertEqual(s, 200); self.assertNotIn("access-control-allow-origin", h, "other sites can't read the response")
    def test_forged_write_from_other_site_refused_even_with_pin(self):
        hdr = {"X-NorwinPrep": "1", "X-NorwinPrep-PIN": PIN, "Content-Type": "application/json"}
        s, _, d = self.raw("POST", "/api/modules/install", dict(hdr, Origin="https://evil.example"), b'{"id":"water"}'); self.assertEqual(s, 403)
        s, _, _ = self.raw("POST", "/api/modules/remove", dict(hdr, Origin="http://127.0.0.1.evil.example:80"), b'{"id":"water"}'); self.assertEqual(s, 403)
        self.assertFalse("job" in self.mod("water"), "nothing was started")
    def test_write_from_app_origin_and_own_page_works(self):
        hdr = {"X-NorwinPrep": "1", "X-NorwinPrep-PIN": PIN, "Content-Type": "application/json"}
        s, h, _ = self.raw("POST", "/api/modules/pin", dict(hdr, Origin="http://127.0.0.1:8787"), b"{}"); self.assertEqual((s, h.get("access-control-allow-origin")), (200, "http://127.0.0.1:8787"))
        s, _, _ = self.raw("POST", "/api/modules/pin", dict(hdr, Origin="http://norwinprep.local", Host="norwinprep.local"), b"{}"); self.assertEqual(s, 200, "the Pi's own page (same host) works")
        s, _, _ = self.raw("POST", "/api/modules/pin", dict(hdr, Origin="http://10.42.0.1", Host="10.42.0.1"), b"{}"); self.assertEqual(s, 200)
        s, _, _ = self.raw("POST", "/api/modules/pin", dict(hdr, Origin="http://10.42.0.1", Host="norwinprep.local"), b"{}"); self.assertEqual(s, 403, "an origin that is not this host is refused")


if __name__ == "__main__":
    unittest.main(verbosity=1)
