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
    private ServerSocket socket;
    private ExecutorService pool;
    private volatile int port;

    public ShareServer(LocalServer.Source site, String deviceName, Packs packs) {
        this.site = site;
        this.name = deviceName;
        this.packs = packs;
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
            if (parts.length < 2) {
                LocalServer.respond(out, 400, "text/plain", "Bad request", false);
            } else {
                route(parts[0], parts[1], headers, out);
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

    private void route(String method, String target, Map<String, String> headers, OutputStream out) throws IOException {
        boolean head = method.equals("HEAD");
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
