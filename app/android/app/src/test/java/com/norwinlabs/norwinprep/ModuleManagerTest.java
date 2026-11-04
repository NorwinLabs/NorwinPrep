package com.norwinlabs.norwinprep;

import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Plain-JVM test of the Android module installer, driven through the real LocalServer HTTP API against a fake Kiwix server. */
public class ModuleManagerTest {
    static int bad = 0;

    static void ok(boolean c, String m) {
        if (!c) {
            bad++;
            System.err.println("FAIL: " + m);
        } else System.out.println("ok   " + m);
    }

    static byte[] WATER = new byte[400_000], NEW = new byte[300_000];
    static final List<String> rangeHeaders = new ArrayList<>();
    static volatile boolean corrupt = false;

    static String sha(byte[] b) throws Exception {
        StringBuilder s = new StringBuilder();
        for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) s.append(String.format("%02x", x));
        return s.toString();
    }

    static String[] call(int port, String method, String path, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
        c.setRequestMethod(method);
        c.setRequestProperty("X-NorwinPrep", "1");
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) {
                o.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        if (in != null) in.transferTo(b);
        return new String[]{String.valueOf(code), b.toString("UTF-8")};
    }

    static String field(String json, String key) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"" + key + "\":(\"[^\"]*\"|[^,}]*)").matcher(json);
        return m.find() ? m.group(1).replace("\"", "") : null;
    }

    static String jobState(int port, String id) throws Exception {
        String j = call(port, "GET", "/api/modules/status", null)[1];
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"" + id + "\":\\{\"state\":\"(\\w+)\",\"percent\":(\\d+),\"message\":\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(j);
        return m.find() ? m.group(1) + "|" + m.group(3) : "none";
    }

    static String waitDone(int port, String id) throws Exception {
        for (int i = 0; i < 400; i++) {
            String s = jobState(port, id);
            if (s.startsWith("done") || s.startsWith("error")) return s;
            Thread.sleep(25);
        }
        return "timeout " + jobState(port, id);
    }

    public static void main(String[] a) throws Exception {
        new java.util.Random(1).nextBytes(WATER);
        new java.util.Random(2).nextBytes(NEW);
        HttpServer fake = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        fake.createContext("/", ex -> {
            String p = ex.getRequestURI().getPath();
            byte[] body = null;
            if (p.equals("/zim/other/")) {
                body = ("<a href=\"zimgit-water_en_2025-01.zim\">w</a> <a href=\"zimgit-water_en_2024-06.zim\">o</a> <a href=\"zimgit-water_en_2025-01.zim.sha256\">s</a>").getBytes();
            } else if (p.equals("/zim/other/zimgit-water_en_2025-01.zim.sha256")) {
                try {
                    body = ((corrupt ? sha(NEW) : sha(WATER)) + "  zimgit-water_en_2025-01.zim\n").getBytes();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            } else if (p.equals("/zim/other/zimgit-water_en_2025-01.zim")) {
                String r = ex.getRequestHeaders().getFirst("Range");
                if (r != null) rangeHeaders.add(r);
                long from = r == null ? 0 : Long.parseLong(r.replaceAll("[^0-9-]", "").split("-")[0]);
                if (ex.getRequestMethod().equals("HEAD")) {
                    ex.getResponseHeaders().add("Content-Length", String.valueOf(WATER.length));
                    ex.sendResponseHeaders(200, -1);
                    ex.close();
                    return;
                }
                byte[] part = Arrays.copyOfRange(WATER, (int) from, WATER.length);
                ex.sendResponseHeaders(r == null ? 200 : 206, part.length);
                try (OutputStream o = ex.getResponseBody()) {
                    o.write(part);
                }
                return;
            }
            if (body == null) {
                ex.sendResponseHeaders(404, -1);
                ex.close();
                return;
            }
            if (ex.getRequestMethod().equals("HEAD")) {
                ex.getResponseHeaders().add("Content-Length", String.valueOf(body.length));
                ex.sendResponseHeaders(200, -1);
                ex.close();
                return;
            }
            ex.sendResponseHeaders(200, body.length);
            try (OutputStream o = ex.getResponseBody()) {
                o.write(body);
            }
        });
        fake.start();
        String kiwix = "http://127.0.0.1:" + fake.getAddress().getPort();

        String catalog = "{\"modules\":["
                + "{\"id\":\"water\",\"type\":\"content\",\"name\":\"Water\",\"tagline\":\"t\",\"description\":\"d\",\"by\":\"b\",\"source\":\"s\",\"icon\":\"i\",\"color\":\"c\",\"sizeClass\":\"s\",\"install\":{\"kind\":\"zim\",\"subdir\":\"other\",\"prefix\":\"zimgit-water_en\"},\"platforms\":[\"windows\",\"linux\",\"darwin\",\"android\"]},"
                + "{\"id\":\"ghost\",\"type\":\"content\",\"name\":\"Ghost \\\"Pack\\\"\",\"tagline\":\"t\",\"description\":\"d\",\"by\":\"b\",\"source\":\"s\",\"icon\":\"i\",\"color\":\"c\",\"sizeClass\":\"m\",\"install\":{\"kind\":\"zim\",\"subdir\":\"ghosts\",\"prefix\":\"ghost_en\"},\"platforms\":[\"android\"]},"
                + "{\"id\":\"map-world\",\"type\":\"maps\",\"name\":\"World\",\"sizeClass\":\"l\",\"install\":{\"kind\":\"maps\",\"file\":\"world.pmtiles\",\"maxzoom\":7},\"platforms\":[\"windows\",\"linux\"]},"
                + "{\"id\":\"reader\",\"type\":\"tool\",\"name\":\"Reader\",\"sizeClass\":\"s\",\"install\":{\"kind\":\"kiwix-tools\"},\"platforms\":[\"windows\"],\"hosts\":[\"app\"]},"
                + "{\"id\":\"desk-only\",\"type\":\"content\",\"name\":\"Desk\",\"sizeClass\":\"s\",\"install\":{\"kind\":\"zim\",\"subdir\":\"other\",\"prefix\":\"desk\"},\"platforms\":[\"windows\",\"linux\"]}]}";

        File dir = Files.createTempDirectory("npmods").toFile(), zim = new File(dir, "library/zim"), files = new File(dir, "files");
        files.mkdirs();
        ModuleManager mm = new ModuleManager(zim, kiwix, catalog);
        final List<String> opened = new ArrayList<>();
        LocalServer.Device dev = new LocalServer.Device() {
            public String name() { return "t"; }
            public void setName(String n) { }
            public String platform() { return "android"; }
            public String version() { return "1"; }
        };
        LocalServer srv = new LocalServer(p -> { throw new java.io.FileNotFoundException(p); }, dev, files, null, mm, f -> { opened.add(f); return null; });
        int port = srv.start(0);

        String cat = call(port, "GET", "/api/modules/catalog", null)[1];
        ok(cat.contains("\"id\":\"water\"") && cat.contains("\"id\":\"ghost\"") && !cat.contains("map-world") && !cat.contains("\"reader\"") && !cat.contains("desk-only"), "Android lists only content packs meant for it (no maps, reader, desktop-only)");
        ok(cat.contains("Ghost \\\"Pack\\\"") && MiniJson.parse(cat) != null, "the catalog answer is valid JSON even with quotes in names");
        ok(call(port, "GET", "/api/modules/status", null)[1].contains("\"free\":"), "free space is reported");
        // the page also works without the header on GET, but writes need it
        HttpURLConnection nh = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/modules/install").openConnection();
        nh.setRequestMethod("POST");
        ok(nh.getResponseCode() == 403, "a write without the X-NorwinPrep header is refused");

        String info = call(port, "GET", "/api/modules/info?id=water", null)[1];
        ok(field(info, "file").equals("zimgit-water_en_2025-01.zim") && field(info, "version").equals("2025.01") && field(info, "bytes").equals(String.valueOf(WATER.length)), "info: newest edition, size and version from the library: " + info);
        String[] miss = call(port, "GET", "/api/modules/info?id=ghost", null);
        ok(miss[0].equals("404") && miss[1].contains("not found in the Kiwix library"), "a pack the library does not have is explained");
        ok(call(port, "GET", "/api/modules/info?id=nope", null)[0].equals("404"), "unknown module id: 404");

        // an older edition is already on the phone
        zim.mkdirs();
        Files.write(new File(zim, "zimgit-water_en_2024-06.zim").toPath(), new byte[1234]);
        ok(call(port, "POST", "/api/modules/install", "{\"id\":\"water\"}")[0].equals("202"), "install is accepted");
        String r = waitDone(port, "water");
        ok(r.startsWith("done"), "install finished: " + r);
        ok(Arrays.equals(Files.readAllBytes(new File(zim, "zimgit-water_en_2025-01.zim").toPath()), WATER), "the file on the phone is byte-identical");
        ok(!new File(zim, "zimgit-water_en_2024-06.zim").exists(), "the older edition was replaced");
        ok(call(port, "GET", "/api/modules/catalog", null)[1].matches("(?s).*\"id\":\"water\".*\"installed\":true.*\"version\":\"2025.01\".*"), "the store sees it as installed, version 2025.01");

        // opening: Android hands it to Kiwix
        String wiki = call(port, "GET", "/wiki/", null)[1];
        ok(wiki.contains("zimgit-water_en_2025-01.zim") && wiki.contains("Kiwix"), "the Library page lists installed packs");
        ok(call(port, "POST", "/api/open", "{\"file\":\"zimgit-water_en_2025-01.zim\"}")[0].equals("200") && opened.equals(Arrays.asList("zimgit-water_en_2025-01.zim")), "Open hands the pack to the Kiwix app");
        ok(call(port, "POST", "/api/open", "{\"file\":\"../../etc/passwd\"}")[0].equals("404"), "Open only accepts installed packs (no path tricks)");

        // remove
        call(port, "POST", "/api/modules/remove", "{\"id\":\"water\"}");
        ok(waitDone(port, "water").startsWith("done") && zim.listFiles((d, n) -> n.endsWith(".zim")).length == 0, "remove deletes the pack");

        // resume: half the file is already there; the server must be asked for the rest only
        rangeHeaders.clear();
        Files.write(new File(zim, ".zimgit-water_en_2025-01.zim.part").toPath(), Arrays.copyOf(WATER, 150_000));
        call(port, "POST", "/api/modules/install", "{\"id\":\"water\"}");
        r = waitDone(port, "water");
        ok(r.startsWith("done") && rangeHeaders.contains("bytes=150000-") && Arrays.equals(Files.readAllBytes(new File(zim, "zimgit-water_en_2025-01.zim").toPath()), WATER), "an interrupted download resumes from byte 150000 and is identical: " + r + " " + rangeHeaders);
        call(port, "POST", "/api/modules/remove", "{\"id\":\"water\"}");
        waitDone(port, "water");

        // corrupted download is rejected and nothing is kept
        corrupt = true;
        call(port, "POST", "/api/modules/install", "{\"id\":\"water\"}");
        r = waitDone(port, "water");
        ok(r.startsWith("error") && r.contains("checksum") && zim.listFiles((d, n) -> n.contains("water")).length == 0, "a download that fails its checksum is rejected and deleted: " + r);
        corrupt = false;

        // not enough space
        mm.freeSpace = () -> 100L * 1024;
        call(port, "POST", "/api/modules/install", "{\"id\":\"water\"}");
        r = waitDone(port, "water");
        ok(r.startsWith("error") && r.contains("Not enough free space"), "refuses when the phone is full: " + r);
        mm.freeSpace = () -> 10L * 1024 * 1024 * 1024;

        // offline: clear message
        fake.stop(0);
        call(port, "POST", "/api/modules/install", "{\"id\":\"water\"}");
        r = waitDone(port, "water");
        ok(r.startsWith("error") && r.contains("internet"), "no internet: says installing needs internet: " + r);

        srv.stop();
        System.out.println(bad == 0 ? "ALL PASSED" : bad + " FAILED");
        System.exit(bad == 0 ? 0 : 1);
    }
}
