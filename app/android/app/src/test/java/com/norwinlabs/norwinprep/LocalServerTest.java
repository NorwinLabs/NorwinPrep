package com.norwinlabs.norwinprep;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Plain-JVM test of LocalServer (no Android SDK needed). Run: see .github/workflows/ci.yml. */
public class LocalServerTest {
    static int failures = 0;

    static void check(boolean ok, String msg) {
        System.out.println((ok ? "ok   " : "FAIL ") + msg);
        if (!ok) failures++;
    }

    /** Minimal raw HTTP client so we can send unusual Host/Origin headers. */
    static String[] http(int port, String method, String path, Map<String, String> headers, byte[] body) throws IOException {
        try (Socket s = new Socket("127.0.0.1", port)) {
            s.setSoTimeout(10000);
            StringBuilder h = new StringBuilder(method + " " + path + " HTTP/1.1\r\n");
            Map<String, String> hs = new LinkedHashMap<>();
            hs.put("Host", "127.0.0.1:" + port);
            if (headers != null) hs.putAll(headers);
            if (body != null) hs.put("Content-Length", String.valueOf(body.length));
            for (Map.Entry<String, String> e : hs.entrySet()) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            h.append("\r\n");
            OutputStream o = s.getOutputStream();
            o.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
            if (body != null) o.write(body);
            o.flush();
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.getInputStream().read(buf)) > 0) all.write(buf, 0, n);
            String raw = all.toString("UTF-8");
            int split = raw.indexOf("\r\n\r\n");
            String head = split >= 0 ? raw.substring(0, split) : raw;
            return new String[]{head.split(" ")[1], split >= 0 ? raw.substring(split + 4) : ""};
        }
    }

    static Map<String, String> h(String... kv) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    public static void main(String[] args) throws Exception {
        Path site = Files.createTempDirectory("site");
        Files.write(site.resolve("index.html"), "<title>NorwinPrep</title>home".getBytes(StandardCharsets.UTF_8));
        Path files = Files.createTempDirectory("files");
        final String[] name = {"NorwinPrep (Pixel)"};
        LocalServer srv = new LocalServer(
                p -> {
                    Path f = site.resolve(p).normalize();
                    if (!f.startsWith(site) || !Files.isRegularFile(f)) throw new FileNotFoundException(p);
                    return Files.newInputStream(f);
                },
                new LocalServer.Device() {
                    public String name() { return name[0]; }
                    public void setName(String n) { name[0] = n; }
                    public String platform() { return "android"; }
                    public String version() { return "0.5.0"; }
                }, files.toFile());
        int port = srv.start(0);
        Map<String, String> w = h("X-NorwinPrep", "1");

        String[] r = http(port, "GET", "/", null, null);
        check(r[0].equals("200") && r[1].contains("NorwinPrep"), "home page served");
        r = http(port, "GET", "/api/device", null, null);
        check(r[0].equals("200") && r[1].contains("\"name\":\"NorwinPrep (Pixel)\"") && r[1].contains("\"platform\":\"android\"")
                && r[1].contains("\"mode\":\"local\""), "device name API: " + r[1].substring(0, Math.min(60, r[1].length())));
        r = http(port, "GET", "/api/device", h("Host", "evil.example:" + port), null);
        check(r[0].equals("403"), "foreign Host header refused (DNS rebinding)");
        r = http(port, "GET", "/api/device", h("Host", "localhost:" + port), null);
        check(r[0].equals("200"), "localhost Host header accepted");
        r = http(port, "PUT", "/api/device", h("Content-Type", "application/json"), "{\"name\":\"X\"}".getBytes());
        check(r[0].equals("403") && name[0].equals("NorwinPrep (Pixel)"), "rename without X-NorwinPrep header refused");
        r = http(port, "PUT", "/api/device", h("X-NorwinPrep", "1", "Origin", "https://evil.example"), "{\"name\":\"X\"}".getBytes());
        check(r[0].equals("403"), "rename from foreign Origin refused");
        r = http(port, "PUT", "/api/device", w, "{\"name\":\"<script>\"}".getBytes());
        check(r[0].equals("400"), "invalid device name refused");
        r = http(port, "PUT", "/api/device", h("X-NorwinPrep", "1", "Origin", "http://127.0.0.1:" + port), "{\"name\":\"Bunker Box\"}".getBytes());
        check(r[0].equals("200") && name[0].equals("Bunker Box") && r[1].contains("Bunker Box"), "rename works");

        for (String p : new String[]{"/../x", "/%2e%2e/x", "/files/..%2fx", "/files/.hidden", "/a\\b"}) {
            r = http(port, "GET", p, null, null);
            check(r[0].equals("400") || r[0].equals("404"), "path trick blocked: " + p + " -> " + r[0]);
        }
        r = http(port, "GET", "/nope.html", null, null);
        check(r[0].equals("404"), "missing file is 404");

        byte[] data = "hello prepper".getBytes(StandardCharsets.UTF_8);
        r = http(port, "PUT", "/files/hello.txt", w, data);
        check(r[0].equals("200") && Files.readString(files.resolve("hello.txt")).equals("hello prepper"), "upload stored on disk");
        r = http(port, "GET", "/files/hello.txt", null, null);
        check(r[0].equals("200") && r[1].equals("hello prepper"), "download returns same bytes");
        r = http(port, "GET", "/api/files", null, null);
        check(r[0].equals("200") && r[1].equals("[{\"name\":\"hello.txt\",\"size\":13}]"), "file list JSON: " + r[1]);
        r = http(port, "GET", "/files/", null, null);
        check(r[0].equals("200") && r[1].contains("hello.txt"), "file index page");
        r = http(port, "PUT", "/files/bad$name.txt", w, data);
        check(r[0].equals("400") && r[1].contains("Bad file name") && !Files.exists(files.resolve("bad$name.txt")), "unsafe file name refused with JSON error");
        r = http(port, "PUT", "/files/noheader.txt", null, data);
        check(r[0].equals("403") && !Files.exists(files.resolve("noheader.txt")), "upload without header refused");
        r = http(port, "DELETE", "/files/hello.txt", w, null);
        check(r[0].equals("200") && !Files.exists(files.resolve("hello.txt")), "delete works");
        r = http(port, "DELETE", "/files/hello.txt", w, null);
        check(r[0].equals("404"), "deleting a missing file is 404");

        // port fallback: second server asks for the same (busy) port and must still start
        LocalServer second = new LocalServer(p -> { throw new FileNotFoundException(p); }, new LocalServer.Device() {
            public String name() { return "n"; }
            public void setName(String n) { }
            public String platform() { return "android"; }
            public String version() { return "1"; }
        }, files.toFile());
        int p2 = second.start(port);
        check(p2 != port && p2 > 0, "busy preferred port falls back to a free one (" + p2 + ")");
        second.stop();

        srv.stop();
        System.out.println(failures == 0 ? "ALL PASSED" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}
