package com.norwinlabs.norwinprep;

import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Plain-JVM test of ReleaseClient and the /api/update routes. Run: see .github/workflows/ci.yml. */
public class ReleaseClientTest {
    static int failures = 0;
    static final String SLUG = "NorwinLabs/NorwinPrepDisk", TAG = "v0.6.9";
    static final String APK = "NorwinPrep-0.6.9-android.apk";

    static void check(boolean ok, String msg) {
        System.out.println((ok ? "ok   " : "FAIL ") + msg);
        if (!ok) failures++;
    }

    static String sha(byte[] b) throws Exception {
        StringBuilder s = new StringBuilder();
        for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) s.append(String.format("%02x", x));
        return s.toString();
    }

    static String raw(int port, String method, String path, String headers, String body) throws IOException {
        try (Socket s = new Socket("127.0.0.1", port)) {
            s.setSoTimeout(10000);
            byte[] b = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
            String req = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\n" + (headers == null ? "" : headers)
                    + (body != null ? "Content-Length: " + b.length + "\r\n" : "") + "\r\n";
            s.getOutputStream().write(req.getBytes(StandardCharsets.ISO_8859_1));
            s.getOutputStream().write(b);
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.getInputStream().read(buf)) > 0) all.write(buf, 0, n);
            return all.toString("UTF-8");
        }
    }

    public static void main(String[] args) throws Exception {
        final byte[] apkBytes = new byte[300_000];
        new Random(7).nextBytes(apkBytes);
        final boolean[] corrupt = {false}, loop = {false};
        HttpServer gh = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        final String base = "/" + SLUG + "/releases/download/" + TAG + "/";
        gh.createContext("/", ex -> {
            String p = ex.getRequestURI().getPath();
            byte[] out;
            int code = 200;
            if (p.equals("/repos/" + SLUG + "/releases/latest")) {
                // asset names also appear inside release notes; escaped copies must not be picked up
                String json = "{\"url\":\"x\",\"tag_name\":\"" + TAG + "\",\"name\":\"NorwinPrep " + TAG + "\","
                        + "\"body\":\"see \\\"name\\\":\\\"NorwinPrep-9.9.9-evil.apk\\\"\","
                        + "\"author\":{\"login\":\"bot\",\"html_url\":\"https://github.com/bot\"},"
                        + "\"assets\":[{\"name\":\"" + APK + "\"},{\"name\":\"NorwinPrep-0.6.9-win-x64.exe\"},{\"name\":\"SHA256SUMS\"},{\"name\":\"random.txt\"}]}";
                out = json.getBytes(StandardCharsets.UTF_8);
            } else if (p.equals(base + "SHA256SUMS")) {
                try {
                    out = ((corrupt[0] ? "0".repeat(64) : sha(apkBytes)) + "  " + APK + "\n").getBytes(StandardCharsets.UTF_8);
                } catch (Exception e) {
                    out = new byte[0];
                }
            } else if (p.equals(base + APK)) {
                ex.getResponseHeaders().add("Location", loop[0] ? base + APK : "/cdn/apk");
                ex.sendResponseHeaders(302, -1);
                ex.close();
                return;
            } else if (p.equals("/cdn/apk")) {
                out = apkBytes;
            } else {
                out = "nope".getBytes();
                code = 404;
            }
            ex.sendResponseHeaders(code, out.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(out);
            }
        });
        gh.start();
        String url = "http://127.0.0.1:" + gh.getAddress().getPort();
        ReleaseClient rc = new ReleaseClient(url, url, SLUG, null);

        // ---- check ----
        String j = rc.checkJson();
        check(j.contains("\"tag\":\"v0.6.9\"") && j.contains("releases/tag/v0.6.9"), "checkJson returns tag and release page: " + j.substring(0, 70) + "...");
        check(j.contains(APK) && j.contains("NorwinPrep-0.6.9-win-x64.exe") && j.contains("SHA256SUMS"), "lists the release assets");
        check(!j.contains("random.txt") && !j.contains("evil"), "ignores unrelated files and names inside release notes");
        try {
            new ReleaseClient("http://127.0.0.1:1", "http://127.0.0.1:1", SLUG, null).checkJson();
            check(false, "unreachable GitHub throws");
        } catch (IOException e) {
            check(true, "unreachable GitHub throws IOException");
        }

        // ---- download ----
        File dir = Files.createTempDirectory("dl").toFile();
        AtomicInteger last = new AtomicInteger(-1);
        File f = rc.download(TAG, APK, dir, last::set);
        check(f.getName().equals(APK) && Arrays.equals(Files.readAllBytes(f.toPath()), apkBytes), "download follows the redirect and saves identical bytes");
        check(last.get() >= 0, "progress is reported (last " + last.get() + "%)");
        check(!new File(dir, APK + ".part").exists(), "no .part file left after success");

        corrupt[0] = true;
        File dir2 = Files.createTempDirectory("dl2").toFile();
        try {
            rc.download(TAG, APK, dir2, null);
            check(false, "wrong checksum is refused");
        } catch (IOException e) {
            check(e.getMessage().contains("Checksum mismatch"), "wrong checksum is refused: " + e.getMessage());
        }
        check(!new File(dir2, APK).exists() && !new File(dir2, APK + ".part").exists(), "tampered download is deleted, nothing left to install");
        corrupt[0] = false;

        try {
            rc.download(TAG, "NorwinPrep-0.6.9-linux-arm64.deb", dir2, null);
            check(false, "asset without a published checksum is refused");
        } catch (IOException e) {
            check(e.getMessage().contains("No checksum"), "asset without a published checksum is refused");
        }
        for (String[] bad : new String[][]{{"v1", APK}, {TAG, "../../evil.apk"}, {TAG, "evil.sh"}}) {
            try {
                rc.download(bad[0], bad[1], dir2, null);
                check(false, "rejects " + bad[0] + " / " + bad[1]);
            } catch (IOException e) {
                check(true, "rejects " + bad[0] + " / " + bad[1]);
            }
        }
        loop[0] = true;
        try {
            rc.download(TAG, APK, dir2, null);
            check(false, "redirect loop is stopped");
        } catch (IOException e) {
            check(e.getMessage().contains("redirect"), "redirect loop is stopped: " + e.getMessage());
        }
        loop[0] = false;

        // ---- /api/update routes on the local server ----
        final List<String> installs = new ArrayList<>();
        final boolean[] busy = {false}, offline = {false};
        LocalServer.Updater fake = new LocalServer.Updater() {
            public String checkJson() throws IOException {
                if (offline[0]) throw new IOException("down");
                return "{\"tag\":\"v0.6.9\",\"url\":\"u\",\"assets\":[\"" + APK + "\"]}";
            }

            public void install(String tag, String asset) {
                if (busy[0]) throw new IllegalStateException("An update is already running");
                installs.add(tag + "|" + asset);
            }

            public String statusJson() {
                return "{\"state\":\"downloading\",\"percent\":0,\"message\":\"Starting\",\"tag\":\"v0.6.9\"}";
            }
        };
        LocalServer srv = new LocalServer(p -> { throw new FileNotFoundException(p); }, new LocalServer.Device() {
            public String name() { return "n"; }
            public void setName(String n) { }
            public String platform() { return "android"; }
            public String version() { return "0.6.1"; }
            public String packaging() { return "apk"; }
        }, Files.createTempDirectory("f").toFile(), fake);
        int port = srv.start(0);
        String hdr = "X-NorwinPrep: 1\r\n";
        String r = raw(port, "GET", "/api/device", null, null);
        check(r.contains("\"packaging\":\"apk\"") && r.contains("\"version\":\"0.6.1\"") && r.contains("\"arch\":\"\""), "device info reports version and packaging");
        r = raw(port, "GET", "/api/update/check", null, null);
        check(r.startsWith("HTTP/1.1 200") && r.contains("v0.6.9"), "GET /api/update/check passes the release summary through");
        offline[0] = true;
        r = raw(port, "GET", "/api/update/check", null, null);
        check(r.startsWith("HTTP/1.1 502") && r.contains("Could not reach GitHub."), "offline check returns a clean 502");
        offline[0] = false;
        r = raw(port, "GET", "/api/update/status", null, null);
        check(r.startsWith("HTTP/1.1 200") && r.contains("downloading"), "status endpoint works");
        r = raw(port, "POST", "/api/update/install", hdr, "{\"tag\":\"v0.6.9\",\"asset\":\"" + APK + "\"}");
        check(r.startsWith("HTTP/1.1 202") && installs.equals(Arrays.asList("v0.6.9|" + APK)), "install starts the updater with the validated tag and asset");
        r = raw(port, "POST", "/api/update/install", null, "{\"tag\":\"v0.6.9\",\"asset\":\"" + APK + "\"}");
        check(r.startsWith("HTTP/1.1 403") && installs.size() == 1, "install without the app header is refused");
        r = raw(port, "POST", "/api/update/install", hdr + "Origin: https://evil.example\r\n", "{\"tag\":\"v0.6.9\",\"asset\":\"" + APK + "\"}");
        check(r.startsWith("HTTP/1.1 403") && installs.size() == 1, "install from a foreign website is refused");
        r = raw(port, "POST", "/api/update/install", hdr, "{\"tag\":\"v0.6.9\",\"asset\":\"../../x.apk\"}");
        check(r.startsWith("HTTP/1.1 400") && installs.size() == 1, "install with a path in the asset name is refused");
        r = raw(port, "POST", "/api/update/install", hdr, "{\"tag\":\"main\",\"asset\":\"" + APK + "\"}");
        check(r.startsWith("HTTP/1.1 400"), "install with a non-release tag is refused");
        busy[0] = true;
        r = raw(port, "POST", "/api/update/install", hdr, "{\"tag\":\"v0.6.9\",\"asset\":\"" + APK + "\"}");
        check(r.startsWith("HTTP/1.1 409") && r.contains("already running"), "install while another is running returns 409");
        r = raw(port, "GET", "/api/update/install", null, null);
        check(r.startsWith("HTTP/1.1 404") || r.startsWith("HTTP/1.1 405"), "GET on the install endpoint is not an install");
        srv.stop();
        gh.stop(0);

        System.out.println(failures == 0 ? "ALL PASSED" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}
