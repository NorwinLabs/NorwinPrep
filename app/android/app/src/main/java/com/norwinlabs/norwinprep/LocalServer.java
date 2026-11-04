package com.norwinlabs.norwinprep;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Local NorwinPrep instance: home page, device-info API and a small file library, bound to 127.0.0.1 only.
 * Plain Java (no Android classes) so it can be unit-tested on a normal JVM. Mirrors desktop/local-server.js.
 */
public class LocalServer {
    /** Opens a bundled site file by path relative to the site root (e.g. "index.html"). */
    public interface Source {
        InputStream open(String path) throws IOException;
    }

    public interface Device {
        String name();
        void setName(String name);
        String platform();
        String version();
        default String arch() { return ""; }
        default String packaging() { return ""; }
    }

    /** App updates: check the latest release, download + install a file from it. */
    public interface Updater {
        String checkJson() throws IOException;
        /** Starts the update in the background. Throws IllegalStateException if one is already running. */
        void install(String tag, String asset) throws IOException;
        String statusJson();
    }

    /** Result of a module API call. */
    public static final class Result {
        public final int code;
        public final String json;

        public Result(int code, String json) {
            this.code = code;
            this.json = json;
        }
    }

    /** The on-device module installer (see ModuleManager). */
    public interface Modules {
        /** route is the part after /api/modules, e.g. "/catalog". */
        Result handle(String method, String route, Map<String, String> query, String body);

        /** File names of installed content packs (e.g. zimgit-water_en_2025-01.zim). */
        java.util.List<String> installedFiles();
    }

    /** Share over Wi-Fi (this phone's hotspot + the read-only ShareServer). */
    public interface Sharing {
        /** JSON like the desktop one: {supported, active, auto, ssid, password, url, reason}. */
        String statusJson();

        /** Starts or stops sharing; returns the status JSON, or throws IOException with a message for the user. */
        String set(boolean on) throws IOException;
    }

    /** Opens an installed content pack in another app (Android has no embedded reader). Returns null on success, else a message. */
    public interface Opener {
        String open(String file);
    }

    static final Pattern NAME_RE = Pattern.compile("^[A-Za-z0-9 ._()\\-]{1,40}$");
    static final Pattern FILE_RE = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9 ._()\\-]{0,99}$");
    static final long MAX_UPLOAD = 500L * 1024 * 1024;

    private final Source site;
    private final Device device;
    private final File filesDir;
    private final Updater updater;
    private final Modules modules;
    private final Opener opener;
    private volatile Sharing sharing;
    private ServerSocket socket;
    private ExecutorService pool;
    private volatile int port;

    public LocalServer(Source site, Device device, File filesDir) {
        this(site, device, filesDir, null);
    }

    public LocalServer(Source site, Device device, File filesDir, Updater updater) {
        this(site, device, filesDir, updater, null, null);
    }

    public LocalServer(Source site, Device device, File filesDir, Updater updater, Modules modules, Opener opener) {
        this.site = site;
        this.device = device;
        this.filesDir = filesDir;
        this.updater = updater;
        this.modules = modules;
        this.opener = opener;
    }

    public int port() {
        return port;
    }

    /** Attached after construction because the sharing code needs the activity (permissions, hotspot). */
    public void setSharing(Sharing s) {
        this.sharing = s;
    }

    /** Starts on {@code preferred}; if that port is taken, picks a free one. Returns the port in use. */
    public synchronized int start(int preferred) throws IOException {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        try {
            socket = new ServerSocket(preferred, 50, loopback);
        } catch (IOException busy) {
            socket = new ServerSocket(0, 50, loopback);
        }
        port = socket.getLocalPort();
        pool = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "norwinprep-http");
            t.setDaemon(true);
            return t;
        });
        Thread acceptor = new Thread(() -> {
            while (!socket.isClosed()) {
                try {
                    final Socket s = socket.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException e) {
                    break;
                }
            }
        }, "norwinprep-accept");
        acceptor.setDaemon(true);
        acceptor.start();
        return port;
    }

    public synchronized void stop() {
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
        }
        if (pool != null) pool.shutdownNow();
    }

    // ------------------------------------------------------------------ request handling

    private static class Request {
        String method, target;
        Map<String, String> headers = new HashMap<>();
        InputStream in;
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(15000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            Request req = readRequest(in);
            if (req == null) {
                respond(out, 400, "text/plain", "Bad request", false);
            } else {
                route(req, out);
            }
            out.flush();
        } catch (IOException ignored) {
        } finally {
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new IOException("line too long");
        }
        if (c == -1 && b.size() == 0) return null;
        return b.toString("ISO-8859-1");
    }

    private static Request readRequest(InputStream in) throws IOException {
        String line = readLine(in);
        if (line == null) return null;
        String[] parts = line.split(" ");
        if (parts.length < 2) return null;
        Request r = new Request();
        r.method = parts[0];
        r.target = parts[1];
        r.in = in;
        for (int i = 0; i < 100; i++) {
            String h = readLine(in);
            if (h == null || h.isEmpty()) return r;
            int idx = h.indexOf(':');
            if (idx > 0) r.headers.put(h.substring(0, idx).trim().toLowerCase(Locale.ROOT), h.substring(idx + 1).trim());
        }
        return null;
    }

    private void route(Request req, OutputStream out) throws IOException {
        final boolean head = req.method.equals("HEAD");
        final boolean writes = req.method.equals("PUT") || req.method.equals("POST") || req.method.equals("DELETE");
        final String origin1 = "http://127.0.0.1:" + port, origin2 = "http://localhost:" + port;

        // Defend against DNS-rebinding and cross-site requests to this loopback server
        String host = req.headers.get("host");
        if (host == null || !(("http://" + host).equals(origin1) || ("http://" + host).equals(origin2))) {
            respond(out, 403, "text/plain", "Forbidden", head);
            return;
        }
        if (writes) {
            String origin = req.headers.get("origin");
            if (origin != null && !origin.equals(origin1) && !origin.equals(origin2)) {
                respond(out, 403, "text/plain", "Forbidden", head);
                return;
            }
            if (!"1".equals(req.headers.get("x-norwinprep"))) {
                respond(out, 403, "text/plain", "Forbidden", head);
                return;
            }
        } else if (!req.method.equals("GET") && !head) {
            respond(out, 405, "text/plain", "Method not allowed", head);
            return;
        }

        String path = req.target;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        try {
            path = URLDecoder.decode(path.replace("+", "%2B"), "UTF-8");
        } catch (IllegalArgumentException e) {
            respond(out, 400, "text/plain", "Bad request", head);
            return;
        }
        if (path.indexOf('\0') >= 0 || path.indexOf('\\') >= 0 || Arrays.asList(path.split("/")).contains("..")) {
            respond(out, 400, "text/plain", "Bad request", head);
            return;
        }

        if (path.equals("/api/device")) {
            if (!writes) {
                respond(out, 200, "application/json; charset=utf-8", deviceJson(), head);
            } else if (req.method.equals("DELETE")) {
                respond(out, 405, "text/plain", "Method not allowed", head);
            } else {
                String body = new String(readBody(req, 4096), StandardCharsets.UTF_8);
                java.util.regex.Matcher m = Pattern.compile("\"name\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(body);
                String name = m.find() ? m.group(1).trim() : "";
                if (!NAME_RE.matcher(name).matches()) {
                    respond(out, 400, "application/json; charset=utf-8",
                            "{\"error\":\"Name must be 1-40 letters, numbers, spaces or . _ - ( )\"}", head);
                } else {
                    device.setName(name);
                    respond(out, 200, "application/json; charset=utf-8", deviceJson(), head);
                }
            }
            return;
        }

        // ---- install content onto THIS device (no hub, no PIN: it is your own app) ----
        if (path.equals("/api/modules") || path.startsWith("/api/modules/")) {
            if (modules == null) {
                respond(out, 404, "application/json; charset=utf-8", "{\"error\":\"modules not available\"}", head);
                return;
            }
            Map<String, String> qs = new HashMap<>();
            int qi = req.target.indexOf('?');
            if (qi >= 0) {
                for (String kv : req.target.substring(qi + 1).split("&")) {
                    int eq = kv.indexOf('=');
                    try {
                        if (eq > 0) qs.put(URLDecoder.decode(kv.substring(0, eq), "UTF-8"), URLDecoder.decode(kv.substring(eq + 1), "UTF-8"));
                    } catch (IllegalArgumentException ignored) {
                    }
                }
            }
            String body = writes ? new String(readBody(req, 4096), StandardCharsets.UTF_8) : "";
            String route = path.length() > 12 ? path.substring(12) : "/";
            Result r = modules.handle(writes ? "POST" : "GET", route, qs, body);
            respond(out, r.code, "application/json; charset=utf-8", r.json, head);
            return;
        }
        if (path.equals("/api/share")) {
            Sharing sh = sharing;
            if (sh == null) {
                respond(out, 200, "application/json; charset=utf-8", "{\"supported\":false}", head);
            } else if (!writes) {
                respond(out, 200, "application/json; charset=utf-8", sh.statusJson(), head);
            } else {
                String body = new String(readBody(req, 1024), StandardCharsets.UTF_8);
                java.util.regex.Matcher om = Pattern.compile("\"on\"\\s*:\\s*(true|false)").matcher(body);
                if (!om.find()) {
                    respond(out, 400, "application/json; charset=utf-8", "{\"error\":\"missing on\"}", head);
                } else {
                    try {
                        respond(out, 200, "application/json; charset=utf-8", sh.set(om.group(1).equals("true")), head);
                    } catch (IOException e) {
                        respond(out, 409, "application/json; charset=utf-8", "{\"error\":" + jsonStr(String.valueOf(e.getMessage())) + "}", head);
                    }
                }
            }
            return;
        }
        if (path.equals("/api/open") && req.method.equals("POST")) {
            String body = new String(readBody(req, 2048), StandardCharsets.UTF_8);
            java.util.regex.Matcher fm = Pattern.compile("\"file\"\\s*:\\s*\"([^\"]*)\"").matcher(body);
            String file = fm.find() ? fm.group(1) : "";
            if (modules == null || opener == null || !modules.installedFiles().contains(file)) {
                respond(out, 404, "application/json; charset=utf-8", "{\"error\":\"That content pack is not installed.\"}", head);
                return;
            }
            String err = opener.open(file);
            respond(out, err == null ? 200 : 409, "application/json; charset=utf-8", err == null ? "{\"ok\":true}" : "{\"error\":" + jsonStr(err) + "}", head);
            return;
        }
        if ((path.equals("/wiki") || path.equals("/wiki/")) && !writes && modules != null) {
            StringBuilder rows = new StringBuilder();
            for (String f : modules.installedFiles()) {
                rows.append("<li><span>").append(html(f)).append("</span><button data-f=\"").append(html(f)).append("\">Open</button></li>");
            }
            respond(out, 200, "text/html; charset=utf-8",
                    "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                            + "<title>Library</title><style>body{font:16px system-ui;background:#0d0f14;color:#e9ebf1;margin:0;padding:16px}a{color:#4aa3ff}"
                            + "ul{list-style:none;padding:0}li{display:flex;gap:10px;align-items:center;justify-content:space-between;border:1px solid #272b36;border-radius:16px;padding:12px 14px;margin:8px 0}"
                            + "span{overflow-wrap:anywhere}button{height:36px;padding:0 16px;border-radius:10px;border:1px solid #fff;background:#fff;color:#0d0f14;font-weight:700}"
                            + "#m{color:#ff8a98;min-height:1.4em}</style><body><p><a href=\"/\">&larr; Module Store</a></p><h1>Library</h1>"
                            + "<p>Content packs are read with the free Kiwix app. Tap Open to view one there.</p><ul>"
                            + (rows.length() == 0 ? "<li>Nothing installed yet. Install a pack from the Module Store.</li>" : rows) + "</ul><div id=\"m\"></div>"
                            + "<script>document.querySelectorAll('button[data-f]').forEach(function(b){b.onclick=function(){fetch('/api/open',{method:'POST',headers:{'X-NorwinPrep':'1','Content-Type':'application/json'},"
                            + "body:JSON.stringify({file:b.dataset.f})}).then(function(r){return r.json()}).then(function(j){document.getElementById('m').textContent=j.error||''})}})</script>", head);
            return;
        }

        if (path.equals("/api/update/check") && !writes) {
            if (updater == null) {
                respond(out, 404, "application/json; charset=utf-8", "{\"error\":\"updates not available\"}", head);
            } else {
                try {
                    respond(out, 200, "application/json; charset=utf-8", updater.checkJson(), head);
                } catch (IOException e) {
                    respond(out, 502, "application/json; charset=utf-8", "{\"error\":\"Could not reach GitHub.\"}", head);
                }
            }
            return;
        }
        if (path.equals("/api/update/status") && !writes) {
            respond(out, 200, "application/json; charset=utf-8", updater == null ? "{\"state\":\"idle\"}" : updater.statusJson(), head);
            return;
        }
        if (path.equals("/api/update/install") && req.method.equals("POST")) {
            if (updater == null) {
                respond(out, 404, "application/json; charset=utf-8", "{\"error\":\"updates not available\"}", head);
                return;
            }
            String body = new String(readBody(req, 2048), StandardCharsets.UTF_8);
            java.util.regex.Matcher tm = Pattern.compile("\"tag\"\\s*:\\s*\"([^\"]*)\"").matcher(body);
            java.util.regex.Matcher am = Pattern.compile("\"asset\"\\s*:\\s*\"([^\"]*)\"").matcher(body);
            String tag = tm.find() ? tm.group(1) : "";
            String asset = am.find() ? am.group(1) : "";
            if (!ReleaseClient.TAG_RE.matcher(tag).matches() || !ReleaseClient.ASSET_RE.matcher(asset).matches()) {
                respond(out, 400, "application/json; charset=utf-8", "{\"error\":\"bad tag or asset\"}", head);
                return;
            }
            try {
                updater.install(tag, asset);
                respond(out, 202, "application/json; charset=utf-8", updater.statusJson(), head);
            } catch (IllegalStateException busy) {
                respond(out, 409, "application/json; charset=utf-8", "{\"error\":" + jsonStr(String.valueOf(busy.getMessage())) + "}", head);
            } catch (IOException e) {
                respond(out, 500, "application/json; charset=utf-8", "{\"error\":" + jsonStr(String.valueOf(e.getMessage())) + "}", head);
            }
            return;
        }

        if (path.equals("/api/files") && !writes) {
            StringBuilder sb = new StringBuilder("[");
            File[] list = listFiles();
            for (int i = 0; i < list.length; i++) {
                if (i > 0) sb.append(',');
                sb.append("{\"name\":").append(jsonStr(list[i].getName())).append(",\"size\":").append(list[i].length()).append('}');
            }
            respond(out, 200, "application/json; charset=utf-8", sb.append(']').toString(), head);
            return;
        }

        if (path.equals("/files") || path.equals("/files/")) {
            if (writes) {
                respond(out, 405, "text/plain", "Method not allowed", head);
                return;
            }
            StringBuilder rows = new StringBuilder();
            for (File f : listFiles()) {
                rows.append("<li><a href=\"/files/").append(urlEnc(f.getName())).append("\">").append(html(f.getName())).append("</a></li>");
            }
            respond(out, 200, "text/html; charset=utf-8",
                    "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                            + "<title>Files</title><body style=\"font:16px system-ui;background:#10140f;color:#e8eddf;padding:1rem\">"
                            + "<p><a style=\"color:#9acd32\" href=\"/\">&larr; Home</a></p><h1>Files</h1><ul>"
                            + (rows.length() == 0 ? "<li>No files yet.</li>" : rows) + "</ul>", head);
            return;
        }

        if (path.startsWith("/files/")) {
            String name = path.substring(7);
            if (!FILE_RE.matcher(name).matches()) {
                respond(out, 400, "application/json; charset=utf-8", "{\"error\":" + jsonStr("Bad file name: " + clip(name, 60)) + "}", head);
                return;
            }
            File f = new File(filesDir, name);
            if (req.method.equals("PUT")) {
                String cl = req.headers.get("content-length");
                long len;
                try {
                    len = Long.parseLong(cl == null ? "" : cl);
                } catch (NumberFormatException e) {
                    respond(out, 411, "application/json; charset=utf-8", "{\"error\":\"Length required\"}", head);
                    return;
                }
                if (len < 0 || len > MAX_UPLOAD) {
                    respond(out, 413, "application/json; charset=utf-8", "{\"error\":\"File too large (limit 500 MB)\"}", head);
                    return;
                }
                filesDir.mkdirs();
                File tmp = new File(filesDir, name + ".part");
                long got = 0;
                try (FileOutputStream fo = new FileOutputStream(tmp)) {
                    byte[] buf = new byte[16384];
                    while (got < len) {
                        int n = req.in.read(buf, 0, (int) Math.min(buf.length, len - got));
                        if (n < 0) break;
                        fo.write(buf, 0, n);
                        got += n;
                    }
                }
                if (got != len) {
                    tmp.delete();
                    respond(out, 400, "application/json; charset=utf-8", "{\"error\":\"Upload interrupted\"}", head);
                    return;
                }
                if (f.exists()) f.delete();
                if (!tmp.renameTo(f)) {
                    tmp.delete();
                    respond(out, 500, "application/json; charset=utf-8", "{\"error\":\"write failed\"}", head);
                    return;
                }
                respond(out, 200, "application/json; charset=utf-8", "{\"name\":" + jsonStr(name) + ",\"size\":" + got + "}", head);
                return;
            }
            if (req.method.equals("DELETE")) {
                if (f.isFile() && f.delete()) {
                    respond(out, 200, "application/json; charset=utf-8", "{\"deleted\":" + jsonStr(name) + "}", head);
                } else {
                    respond(out, 404, "application/json; charset=utf-8", "{\"error\":\"not found\"}", head);
                }
                return;
            }
            if (!f.isFile()) {
                respond(out, 404, "text/plain", "Not found", head);
                return;
            }
            writeHeaders(out, 200, typeFor(name), f.length());
            if (!head) {
                try (FileInputStream fi = new FileInputStream(f)) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = fi.read(buf)) > 0) out.write(buf, 0, n);
                }
            }
            return;
        }

        // static site
        if (writes) {
            respond(out, 405, "text/plain", "Method not allowed", head);
            return;
        }
        String rel = path.equals("/") ? "index.html" : path.substring(1);
        try (InputStream is = site.open(rel)) {
            byte[] data = readAll(is);
            respond(out, 200, typeFor(rel), data, head);
        } catch (FileNotFoundException e) {
            respond(out, 404, "text/plain", "Not found", head);
        } catch (IOException e) {
            respond(out, 404, "text/plain", "Not found", head);
        }
    }

    // ------------------------------------------------------------------ helpers

    private String deviceJson() {
        return "{\"name\":" + jsonStr(device.name()) + ",\"mode\":\"local\",\"platform\":" + jsonStr(device.platform())
                + ",\"version\":" + jsonStr(device.version()) + ",\"arch\":" + jsonStr(device.arch())
                + ",\"packaging\":" + jsonStr(device.packaging()) + ",\"address\":\"http://127.0.0.1:" + port
                + "\",\"filesDir\":" + jsonStr(filesDir.getAbsolutePath()) + "}";
    }

    private File[] listFiles() {
        File[] list = filesDir.listFiles(f -> f.isFile() && FILE_RE.matcher(f.getName()).matches());
        if (list == null) return new File[0];
        Arrays.sort(list, Comparator.comparing(File::getName, String.CASE_INSENSITIVE_ORDER));
        return list;
    }

    private static byte[] readBody(Request req, int max) throws IOException {
        String cl = req.headers.get("content-length");
        int len = 0;
        try {
            len = cl == null ? 0 : Integer.parseInt(cl);
        } catch (NumberFormatException ignored) {
        }
        if (len > max) len = max;
        byte[] b = new byte[len];
        int got = 0;
        while (got < len) {
            int n = req.in.read(b, got, len - got);
            if (n < 0) break;
            got += n;
        }
        return Arrays.copyOf(b, got);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return b.toByteArray();
    }

    private static final Map<Integer, String> STATUS = new HashMap<>();

    static {
        STATUS.put(200, "OK");
        STATUS.put(202, "Accepted");
        STATUS.put(409, "Conflict");
        STATUS.put(502, "Bad Gateway");
        STATUS.put(400, "Bad Request");
        STATUS.put(403, "Forbidden");
        STATUS.put(404, "Not Found");
        STATUS.put(405, "Method Not Allowed");
        STATUS.put(411, "Length Required");
        STATUS.put(413, "Payload Too Large");
        STATUS.put(206, "Partial Content");
        STATUS.put(416, "Range Not Satisfiable");
        STATUS.put(429, "Too Many Requests");
        STATUS.put(507, "Insufficient Storage");
        STATUS.put(500, "Internal Server Error");
    }

    private static void writeHeaders(OutputStream out, int code, String type, long length) throws IOException {
        String h = "HTTP/1.1 " + code + " " + STATUS.get(code) + "\r\nContent-Type: " + type + "\r\nContent-Length: " + length
                + "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.ISO_8859_1));
    }

    static void respond(OutputStream out, int code, String type, String body, boolean head) throws IOException {
        respond(out, code, type, body.getBytes(StandardCharsets.UTF_8), head);
    }

    static void respond(OutputStream out, int code, String type, byte[] body, boolean head) throws IOException {
        writeHeaders(out, code, type, body.length);
        if (!head) out.write(body);
    }

    static String typeFor(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".json")) return "application/json; charset=utf-8";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".txt")) return "text/plain; charset=utf-8";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".gif")) return "image/gif";
        return "application/octet-stream";
    }

    static String jsonStr(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    static String html(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;");
    }

    static String urlEnc(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (java.io.UnsupportedEncodingException e) {
            return s;
        }
    }

    private static String clip(String s, int n) {
        return s.length() > n ? s.substring(0, n) : s;
    }
}
