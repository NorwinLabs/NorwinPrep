package com.norwinlabs.norwinprep;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Read-only server for devices that join this phone's Wi-Fi: a landing page and the installed content packs as downloads
 * (with Range support, so a big file can resume). GET/HEAD only; there is no way to install, change or delete anything through it.
 * Plain Java so it is tested on a JVM. Mirrors createShare() in desktop/local-server.js, minus the library reader, which Android lacks.
 */
public class ShareServer {
    public interface Packs {
        List<String> installedFiles();

        File zimDir();
    }

    private static final Pattern PACK_RE = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\\.zim$");
    private static final Pattern RANGE_RE = Pattern.compile("^bytes=(\\d*)-(\\d*)$");

    private final LocalServer.Source site;
    private final String name;
    private final Packs packs;
    private final String user, pass;                                  // null = open share (no sign-in)
    private final Map<String, Long> sessions = new java.util.concurrent.ConcurrentHashMap<>();
    private final Map<String, long[]> tries = new java.util.concurrent.ConcurrentHashMap<>();   // ip -> {failures, lockedUntil}
    private final SecureRandom rnd = new SecureRandom();
    private static final long TTL = 12L * 3600 * 1000;
    private static final Pattern COOKIE_RE = Pattern.compile("(?:^|;\\s*)np_sess=([a-f0-9]{48})");
    private static final Pattern IPV4_RE = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");
    private ServerSocket socket;
    private ExecutorService pool;
    private volatile int port;

    public ShareServer(LocalServer.Source site, String deviceName, Packs packs) {
        this(site, deviceName, packs, null, null);
    }

    /** With a user name and password: devices must sign in first (the same page and rules as the desktop share). */
    public ShareServer(LocalServer.Source site, String deviceName, Packs packs, String user, String password) {
        this.site = site;
        this.name = deviceName;
        this.packs = packs;
        this.user = user;
        this.pass = password;
    }

    public int port() {
        return port;
    }

    /** Listens on all interfaces (the hotspot's address is not known up front). Tries the preferred ports in order. */
    public synchronized int start(int[] preferred) throws IOException {
        InetAddress any = InetAddress.getByName("0.0.0.0");
        IOException last = null;
        for (int p : preferred) {
            try {
                socket = new ServerSocket(p, 50, any);
                break;
            } catch (IOException e) {
                last = e;
            }
        }
        if (socket == null) throw last != null ? last : new IOException("no port");
        port = socket.getLocalPort();
        pool = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "norwinprep-share");
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
        }, "norwinprep-share-accept");
        acceptor.setDaemon(true);
        acceptor.start();
        return port;
    }

    public synchronized void stop() {
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
        }
        socket = null;
        if (pool != null) pool.shutdownNow();
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            String line = readLine(in);
            if (line == null) return;
            String[] parts = line.split(" ");
            Map<String, String> headers = new HashMap<>();
            for (int i = 0; i < 100; i++) {
                String h = readLine(in);
                if (h == null || h.isEmpty()) break;
                int idx = h.indexOf(':');
                if (idx > 0) headers.put(h.substring(0, idx).trim().toLowerCase(Locale.ROOT), h.substring(idx + 1).trim());
            }
            String body = "";
            if (parts.length >= 2 && parts[0].equals("POST")) {
                int len = 0;
                try {
                    len = Integer.parseInt(headers.getOrDefault("content-length", "0"));
                } catch (NumberFormatException ignored) {
                }
                if (len < 0 || len > 2048) {
                    LocalServer.respond(out, 413, "text/plain", "Too large", false);
                    out.flush();
                    return;
                }
                byte[] b = new byte[len];
                int got = 0;
                while (got < len) {
                    int n = in.read(b, got, len - got);
                    if (n < 0) break;
                    got += n;
                }
                body = new String(b, 0, got, StandardCharsets.UTF_8);
            }
            if (parts.length < 2) {
                LocalServer.respond(out, 400, "text/plain", "Bad request", false);
            } else {
                String me = s.getLocalAddress() == null ? "" : s.getLocalAddress().getHostAddress();
                String ip = s.getInetAddress() == null ? "" : s.getInetAddress().getHostAddress();
                route(parts[0], parts[1], headers, out, body, ip, me);
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
        StringBuilder b = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.append((char) c);
            if (b.length() > 8192) throw new IOException("line too long");
        }
        return c == -1 && b.length() == 0 ? null : b.toString();
    }

    private static String digest(String v) {
        try {
            return java.util.Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(v.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static boolean same(String a, String b) {
        return MessageDigest.isEqual(digest(a).getBytes(StandardCharsets.ISO_8859_1), digest(b).getBytes(StandardCharsets.ISO_8859_1));
    }

    static boolean ownHost(String host) {
        String h = host == null ? "" : host.toLowerCase(Locale.ROOT).replaceAll(":\\d+$", "");
        return h.isEmpty() || h.equals("localhost") || IPV4_RE.matcher(h).matches() || (h.startsWith("[") && h.endsWith("]")) || h.endsWith(".local") || !h.contains(".");
    }

    private boolean signedIn(Map<String, String> headers) {
        Matcher m = COOKIE_RE.matcher(headers.getOrDefault("cookie", ""));
        if (!m.find()) return false;
        Long exp = sessions.get(m.group(1));
        if (exp == null || exp < System.currentTimeMillis()) {
            sessions.remove(m.group(1));
            return false;
        }
        return true;
    }

    private static void redirect(OutputStream out, String location, String cookie) throws IOException {
        String h = "HTTP/1.1 302 Found\r\nLocation: " + location + "\r\nContent-Length: 0\r\nCache-Control: no-store\r\n" + (cookie == null ? "" : "Set-Cookie: " + cookie + "\r\n")
                + "Connection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.ISO_8859_1));
    }

    private static String loginPage(String msg) {
        return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Sign in - NorwinPrep</title>"
                + "<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d0f14;color:#e9ebf1;font:16px/1.5 system-ui,sans-serif}"
                + "form{width:min(92vw,360px);background:#12151c;border:1px solid #272b36;border-radius:18px;padding:26px}h1{margin:0 0 4px;font-size:22px}p{margin:0 0 16px;color:#8b92a3;font-size:14px}"
                + "label{display:block;margin:12px 0 4px;font-size:13px;color:#8b92a3}input{width:100%;padding:12px;border-radius:10px;border:1px solid #3a4152;background:#0d0f14;color:inherit;font:inherit}"
                + "button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:10px;background:#fff;color:#0d0f14;font:inherit;font-weight:700}.e{margin-top:12px;color:#ff8a98;font-size:14px}</style></head><body>"
                + "<form method=\"POST\" action=\"/login\"><h1>NorwinPrep</h1><p>Sign in to download the content packs on this phone. No internet needed.</p>"
                + "<label for=\"u\">Username</label><input id=\"u\" name=\"username\" autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\" required autofocus>"
                + "<label for=\"p\">Password</label><input id=\"p\" name=\"password\" type=\"password\" required>" + (msg.isEmpty() ? "" : "<div class=\"e\" role=\"alert\">" + msg + "</div>")
                + "<button type=\"submit\">Sign in</button></form></body></html>";
    }

    private static String formValue(String body, String key) {
        for (String kv : body.split("&")) {
            int i = kv.indexOf('=');
            if (i > 0 && kv.substring(0, i).equals(key)) {
                try {
                    return URLDecoder.decode(kv.substring(i + 1), "UTF-8");
                } catch (Exception e) {
                    return "";
                }
            }
        }
        return "";
    }

    /** Returns true when the request was fully handled here (sign-in page, redirect, refusal). */
    private boolean gate(String method, String path, String target, Map<String, String> headers, OutputStream out, String body, String ip, String me) throws IOException {
        boolean head = method.equals("HEAD"), get = method.equals("GET") || head;
        String login = "http://" + (me.contains(":") ? "[" + me + "]" : me) + (port == 80 ? "" : ":" + port) + "/login";
        if (!ownHost(headers.get("host"))) {                       // a phone's "is there internet?" test: send it to the sign-in page
            redirect(out, login, null);
            return true;
        }
        if (path.equals("/login") && get) {
            String msg = target.contains("e=1") ? "Wrong username or password." : target.contains("e=2") ? "Too many tries. Wait a minute and try again." : "";
            LocalServer.respond(out, 200, "text/html; charset=utf-8", loginPage(msg), head);
            return true;
        }
        if (path.equals("/login") && method.equals("POST")) {
            long[] t = tries.computeIfAbsent(ip, k -> new long[2]);
            if (t[1] > System.currentTimeMillis()) {
                redirect(out, "/login?e=2", null);
                return true;
            }
            boolean good = same(formValue(body, "username"), user) & same(formValue(body, "password"), pass);
            if (good) {
                tries.remove(ip);
                byte[] raw = new byte[24];
                rnd.nextBytes(raw);
                StringBuilder tok = new StringBuilder();
                for (byte b : raw) tok.append(String.format("%02x", b));
                if (sessions.size() > 200) sessions.clear();
                sessions.put(tok.toString(), System.currentTimeMillis() + TTL);
                redirect(out, "/", "np_sess=" + tok + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200");
            } else {
                if (++t[0] >= 5) {
                    t[0] = 0;
                    t[1] = System.currentTimeMillis() + 60000;
                }
                redirect(out, "/login?e=1", null);
            }
            return true;
        }
        if (path.equals("/logout")) {
            Matcher m = COOKIE_RE.matcher(headers.getOrDefault("cookie", ""));
            if (m.find()) sessions.remove(m.group(1));
            redirect(out, "/login", "np_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
            return true;
        }
        if (!signedIn(headers)) {
            if (get) redirect(out, "/login", null);
            else LocalServer.respond(out, 401, "application/json", "{\"error\":\"Sign in first\"}", false);
            return true;
        }
        return false;
    }

    private void route(String method, String target, Map<String, String> headers, OutputStream out, String body, String ip, String me) throws IOException {
        boolean head = method.equals("HEAD");
        if (user != null) {
            String gp = target;
            int gq = gp.indexOf('?');
            if (gq >= 0) gp = gp.substring(0, gq);
            if (gate(method, gp, target, headers, out, body, ip, me)) return;
        }
        if (!method.equals("GET") && !head) {
            LocalServer.respond(out, 405, "text/plain", "Read-only", head);          // nothing can be changed from here
            return;
        }
        String path = target;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        try {
            path = URLDecoder.decode(path.replace("+", "%2B"), "UTF-8");
        } catch (IllegalArgumentException e) {
            LocalServer.respond(out, 400, "text/plain", "Bad request", head);
            return;
        }
        if (path.indexOf('\0') >= 0 || path.indexOf('\\') >= 0 || path.contains("..")) {
            LocalServer.respond(out, 400, "text/plain", "Bad request", head);
            return;
        }
        List<String> files = packs.installedFiles();
        if (path.equals("/api/device")) {
            LocalServer.respond(out, 200, "application/json; charset=utf-8", "{\"name\":" + LocalServer.jsonStr(name)
                    + ",\"mode\":\"pi\",\"share\":true,\"modules\":false,\"hasLibrary\":false,\"hasMaps\":false,\"hasApps\":false,\"hasPacks\":"
                    + !files.isEmpty() + ",\"packCount\":" + files.size() + "}", head);
            return;
        }
        if (path.equals("/")) {
            serveSite(out, "portal.html", head);
            return;
        }
        if (path.equals("/packs") || path.equals("/packs/")) {
            StringBuilder rows = new StringBuilder();
            for (String f : files) {
                File file = new File(packs.zimDir(), f);
                rows.append("<li><a href=\"/packs/").append(LocalServer.urlEnc(f)).append("\">").append(LocalServer.html(f)).append("</a><span>")
                        .append(ModuleManager.human(file.length())).append("</span></li>");
            }
            LocalServer.respond(out, 200, "text/html; charset=utf-8",
                    "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Content packs</title>"
                            + "<style>body{font:16px system-ui;background:#0d0f14;color:#e9ebf1;margin:0;padding:16px}a{color:#4aa3ff;overflow-wrap:anywhere}ul{list-style:none;padding:0}"
                            + "li{display:flex;gap:12px;justify-content:space-between;align-items:center;border:1px solid #272b36;border-radius:16px;padding:12px 14px;margin:8px 0}"
                            + "span{color:#8b92a3;white-space:nowrap;font-size:13px}</style><body><p><a href=\"/\">&larr; Back</a></p><h1>Content packs</h1>"
                            + "<p>Download a pack, then open it with the free Kiwix app. Nothing here needs the internet.</p><ul>"
                            + (rows.length() == 0 ? "<li>Nothing has been installed on this device yet.</li>" : rows) + "</ul>", head);
            return;
        }
        if (path.startsWith("/packs/")) {
            String f = path.substring(7);
            if (!PACK_RE.matcher(f).matches() || !files.contains(f)) {
                LocalServer.respond(out, 404, "text/plain", "Not found", head);
                return;
            }
            serveFile(out, new File(packs.zimDir(), f), headers.get("range"), head);
            return;
        }
        LocalServer.respond(out, 404, "text/plain", "Not found", head);
    }

    private void serveSite(OutputStream out, String rel, boolean head) throws IOException {
        try (InputStream is = site.open(rel)) {
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) b.write(buf, 0, n);
            LocalServer.respond(out, 200, LocalServer.typeFor(rel), b.toByteArray(), head);
        } catch (IOException e) {
            LocalServer.respond(out, 404, "text/plain", "Not found", head);
        }
    }

    private static void serveFile(OutputStream out, File f, String range, boolean head) throws IOException {
        long size = f.length(), from = 0, to = size - 1;
        int code = 200;
        if (range != null) {
            Matcher m = RANGE_RE.matcher(range);
            if (!m.matches() || (m.group(1).isEmpty() && m.group(2).isEmpty())) {
                LocalServer.respond(out, 416, "text/plain", "Bad range", head);
                return;
            }
            if (m.group(1).isEmpty()) {                                 // last N bytes
                long n = Long.parseLong(m.group(2));
                from = Math.max(0, size - n);
            } else {
                from = Long.parseLong(m.group(1));
                if (!m.group(2).isEmpty()) to = Math.min(to, Long.parseLong(m.group(2)));
            }
            if (from > to || from >= size) {
                LocalServer.respond(out, 416, "text/plain", "Range not satisfiable", head);
                return;
            }
            code = 206;
        }
        long len = to - from + 1;
        String h = "HTTP/1.1 " + code + (code == 206 ? " Partial Content" : " OK") + "\r\nContent-Type: application/octet-stream\r\nContent-Length: " + len
                + "\r\nAccept-Ranges: bytes\r\n" + (code == 206 ? "Content-Range: bytes " + from + "-" + to + "/" + size + "\r\n" : "")
                + "Content-Disposition: attachment; filename=\"" + f.getName() + "\"\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.ISO_8859_1));
        if (head) return;
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            raf.seek(from);
            byte[] buf = new byte[65536];
            long left = len;
            while (left > 0) {
                int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) break;
                out.write(buf, 0, n);
                left -= n;
            }
        }
    }
}
