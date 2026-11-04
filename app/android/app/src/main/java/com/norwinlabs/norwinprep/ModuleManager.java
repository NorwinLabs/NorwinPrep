package com.norwinlabs.norwinprep;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Installs offline content packs (Kiwix .zim files) onto THIS Android device, with no hub involved.
 * Mirrors the content part of desktop/modules-manager.js: Range-resume downloads, SHA-256 verification against the
 * checksum Kiwix publishes next to each file, one download at a time, free-space checks, older editions replaced.
 * Maps, apps and the reader are desktop-only, so they are not listed here. Plain Java so it is tested on a JVM.
 */
public class ModuleManager implements LocalServer.Modules {
    static final Pattern ID_RE = Pattern.compile("^[a-z0-9][a-z0-9-]{0,40}$");
    static final String[] TEXT_FIELDS = {"id", "type", "name", "tagline", "description", "by", "source", "icon", "color", "category"};

    static final class Mod {
        final Map<String, String> text = new LinkedHashMap<>();
        String id, sizeClass, subdir, prefix;
    }

    static final class Job {
        volatile String state = "queued", message = "Waiting…", action;
        volatile int percent;
    }

    static final class Fail extends Exception {
        final int code;

        Fail(int code, String msg) {
            super(msg);
            this.code = code;
        }
    }

    private final File zimDir;
    private final String kiwix;
    private final List<Mod> mods;
    private final Map<String, Mod> byId = new LinkedHashMap<>();
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final Map<String, Object[]> cache = new ConcurrentHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "norwinprep-modules");
        t.setDaemon(true);
        return t;
    });
    int timeoutMs = 30000;
    LongSupplier freeSpace;
    private volatile boolean sizesRunning;
    private volatile long sizesOk, sizesFail, lastRefresh;

    /** @param catalogJson the text of catalog.json; @param kiwixBase e.g. https://download.kiwix.org */
    public ModuleManager(File zimDir, String kiwixBase, String catalogJson) {
        this.zimDir = zimDir;
        this.kiwix = kiwixBase.replaceAll("/+$", "");
        this.freeSpace = () -> {
            zimDir.mkdirs();
            return zimDir.getUsableSpace();
        };
        this.mods = loadCatalog(catalogJson);
        for (Mod m : mods) byId.put(m.id, m);
    }

    // ------------------------------------------------------------------ catalog

    static List<Mod> loadCatalog(String json) {
        List<Mod> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        List<Object> all = MiniJson.arr(MiniJson.obj(MiniJson.parse(json)).get("modules"));
        for (Object o : all) {
            Map<String, Object> m = MiniJson.obj(o), inst = MiniJson.obj(m.get("install"));
            String id = MiniJson.str(m.get("id"));
            if (id == null || !ID_RE.matcher(id).matches() || !seen.add(id)) throw new IllegalArgumentException("bad or duplicate module id: " + id);
            if (inst == null || !"zim".equals(inst.get("kind"))) continue;                  // content packs only on Android
            List<Object> plats = MiniJson.arr(m.get("platforms")), hosts = MiniJson.arr(m.get("hosts"));
            if (plats != null && !plats.contains("android")) continue;
            if (hosts != null && !hosts.contains("app")) continue;
            Mod x = new Mod();
            x.id = id;
            x.subdir = MiniJson.str(inst.get("subdir"));
            x.prefix = MiniJson.str(inst.get("prefix"));
            x.sizeClass = MiniJson.str(m.get("sizeClass"));
            if (x.subdir == null || !x.subdir.matches("^[a-z0-9_]+$") || x.prefix == null || !x.prefix.matches("^[A-Za-z0-9_.-]+$")) throw new IllegalArgumentException("bad zim spec for " + id);
            if (x.sizeClass == null || !x.sizeClass.matches("^(s|m|l|xl)$")) throw new IllegalArgumentException("bad sizeClass for " + id);
            for (String f : TEXT_FIELDS) {
                String v = MiniJson.str(m.get(f));
                x.text.put(f, v == null ? "" : v);
            }
            out.add(x);
        }
        return out;
    }

    // ------------------------------------------------------------------ network

    private HttpURLConnection open(String url, String method, long from) throws IOException, Fail {
        String cur = url;
        URL first = new URL(url);
        for (int hop = 0; hop < 6; hop++) {
            URL u = new URL(cur);
            boolean sameOrigin = u.getProtocol().equals(first.getProtocol()) && u.getHost().equals(first.getHost()) && u.getPort() == first.getPort();
            if (!u.getProtocol().equals("https") && !sameOrigin) throw new Fail(502, "The download server redirected somewhere unsafe");
            HttpURLConnection c = (HttpURLConnection) u.openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setRequestMethod(method);
            c.setRequestProperty("User-Agent", "NorwinPrep-Android");
            if (from > 0) c.setRequestProperty("Range", "bytes=" + from + "-");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                cur = new URL(u, c.getHeaderField("Location")).toString();
                c.disconnect();
                continue;
            }
            return c;
        }
        throw new Fail(502, "Too many redirects from the download server");
    }

    private String text(String url) throws IOException, Fail {
        HttpURLConnection c = open(url, "GET", 0);
        try {
            if (c.getResponseCode() != 200) throw new Fail(c.getResponseCode() == 404 ? 404 : 502, "The download server answered HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
                java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    b.write(buf, 0, n);
                    if (b.size() > 8_000_000) throw new Fail(502, "The download server's answer was too large");
                }
                return b.toString("UTF-8");
            }
        } finally {
            c.disconnect();
        }
    }

    private Object cached(String key, long ttlMs, boolean force, java.util.concurrent.Callable<Object> fn) throws Exception {
        Object[] hit = cache.get(key);
        if (hit != null && !force && System.currentTimeMillis() - (Long) hit[0] < ttlMs) return hit[1];
        Object v = fn.call();
        cache.put(key, new Object[]{System.currentTimeMillis(), v == null ? "" : v});
        return v;
    }

    private Object peek(String key) {
        Object[] h = cache.get(key);
        return h == null ? null : h[1];
    }

    private String base(Mod m) {
        return kiwix + "/zim/" + m.subdir + "/";
    }

    private static List<String> versionsIn(String html, String prefix) {
        Matcher x = Pattern.compile(Pattern.quote(prefix) + "_(\\d{4}-\\d{2})\\.zim(?![\\w])").matcher(html);
        Set<String> s = new TreeSet<>();
        while (x.find()) s.add(x.group(1));
        return new ArrayList<>(s);
    }

    private List<String> versions(Mod m, boolean force) throws Exception {
        try {
            String html = (String) cached("list " + base(m), 3600000, force, () -> text(base(m)));
            return versionsIn(html, m.prefix);
        } catch (Fail f) {
            if (f.code == 404) return Collections.emptyList();       // no such folder: the book is not in the library
            throw f;
        }
    }

    private Long headSize(String url) throws Exception {
        Object v = cached("size " + url, 3600000, false, () -> {
            HttpURLConnection c = open(url, "HEAD", 0);
            try {
                String n = c.getHeaderField("Content-Length");
                return n != null && n.matches("\\d{1,15}") ? (Object) Long.valueOf(n) : "";
            } finally {
                c.disconnect();
            }
        });
        return v instanceof Long ? (Long) v : null;
    }

    private Long knownSize(Mod m) {
        Object html = peek("list " + base(m));
        if (!(html instanceof String)) return null;
        List<String> vs = versionsIn((String) html, m.prefix);
        if (vs.isEmpty()) return null;
        Object v = peek("size " + base(m) + m.prefix + "_" + vs.get(vs.size() - 1) + ".zim");
        return v instanceof Long ? (Long) v : null;
    }

    private String latest(Mod m) {
        Object html = peek("list " + base(m));
        if (!(html instanceof String)) return null;
        List<String> vs = versionsIn((String) html, m.prefix);
        return vs.isEmpty() ? null : vs.get(vs.size() - 1).replace('-', '.');
    }

    /** Looks up exact sizes and newest versions in the background: at most every 6 hours, not again for 10 minutes after a failure. */
    void kickSizes(boolean force) {
        synchronized (this) {
            long now = System.currentTimeMillis();
            if (sizesRunning || (!force && (now - sizesOk < 6 * 3600_000L || now - sizesFail < 600_000L))) return;
            sizesRunning = true;
        }
        Thread t = new Thread(this::resolveSizes, "norwinprep-sizes");
        t.setDaemon(true);
        t.start();
    }

    private void resolveSizes() {
        boolean ok = true;
        try {
            Set<String> seenDirs = new HashSet<>();
            int dirs = 0, failed = 0;
            for (Mod m : mods) {
                if (!seenDirs.add(m.subdir)) continue;
                dirs++;
                try {
                    versions(m, true);
                } catch (Exception e) {
                    failed++;                     // one bad folder must not hide the others
                }
            }
            if (dirs > 0 && failed == dirs) throw new IOException("no library listing reachable");     // offline: back off
            ExecutorService pool = Executors.newFixedThreadPool(4, r -> {
                Thread t = new Thread(r);
                t.setDaemon(true);
                return t;
            });
            List<java.util.concurrent.Future<?>> fs = new ArrayList<>();
            for (Mod m : mods) {
                fs.add(pool.submit(() -> {
                    try {
                        List<String> vs = versions(m, false);
                        if (!vs.isEmpty()) headSize(base(m) + m.prefix + "_" + vs.get(vs.size() - 1) + ".zim");
                    } catch (Exception ignored) {
                        // this one module just shows its estimate
                    }
                }));
            }
            for (java.util.concurrent.Future<?> f : fs) f.get();
            pool.shutdown();
        } catch (Exception e) {
            ok = false;
        } finally {
            synchronized (this) {
                sizesRunning = false;
                if (ok) sizesOk = System.currentTimeMillis();
                else sizesFail = System.currentTimeMillis();
            }
        }
    }

    boolean sizesPending() {
        return sizesRunning;
    }

    // ------------------------------------------------------------------ what is installed

    private File[] filesFor(Mod m) {
        File[] list = zimDir.listFiles((d, n) -> n.matches("^" + Pattern.quote(m.prefix) + "_\\d{4}-\\d{2}\\.zim$"));
        if (list == null) return new File[0];
        java.util.Arrays.sort(list);
        return list;
    }

    @Override
    public List<String> installedFiles() {
        List<String> out = new ArrayList<>();
        for (Mod m : mods) for (File f : filesFor(m)) out.add(f.getName());
        Collections.sort(out);
        return out;
    }

    private static String versionOf(File f, Mod m) {
        return f.getName().substring(m.prefix.length() + 1, f.getName().length() - 4).replace('-', '.');
    }

    // ------------------------------------------------------------------ views

    private String catalogJson() {
        kickSizes(false);
        StringBuilder b = new StringBuilder("[");
        boolean firstItem = true;
        for (Mod m : mods) {
            File[] fs = filesFor(m);
            File ins = fs.length > 0 ? fs[fs.length - 1] : null;
            String lat = latest(m);
            if (!firstItem) b.append(',');
            firstItem = false;
            b.append('{');
            for (String k : TEXT_FIELDS) b.append(MiniJson.quote(k)).append(':').append(MiniJson.quote(m.text.get(k))).append(',');
            b.append("\"installed\":").append(ins != null).append(",\"sizeClass\":").append(MiniJson.quote(m.sizeClass));
            if (ins == null) {
                Long ks = knownSize(m);
                if (ks != null) b.append(",\"size\":").append(ks);
            } else {
                long bytes = 0;
                for (File f : fs) bytes += f.length();
                b.append(",\"version\":").append(MiniJson.quote(versionOf(ins, m))).append(",\"bytes\":").append(bytes)
                        .append(",\"updated\":").append(ins.lastModified() / 1000).append(",\"files\":[");
                for (int i = 0; i < fs.length; i++) b.append(i > 0 ? "," : "").append(MiniJson.quote(fs[i].getName()));
                b.append(']');
            }
            if (lat != null) {
                b.append(",\"latest\":").append(MiniJson.quote(lat)).append(",\"updateAvailable\":").append(ins != null && lat.compareTo(versionOf(ins, m)) > 0);
                if (ins == null) b.append(",\"version\":").append(MiniJson.quote(lat));
            }
            Job j = jobs.get(m.id);
            if (j != null) b.append(",\"job\":").append(jobJson(j));
            b.append('}');
        }
        return b.append(']').toString();
    }

    private static String jobJson(Job j) {
        return "{\"state\":" + MiniJson.quote(j.state) + ",\"percent\":" + j.percent + ",\"message\":" + MiniJson.quote(j.message)
                + ",\"action\":" + (j.action == null ? "null" : MiniJson.quote(j.action)) + "}";
    }

    private String diskJson() {
        long free = freeSpace.getAsLong(), total = zimDir.getTotalSpace();
        return "{\"free\":" + free + ",\"total\":" + Math.max(total, free) + "}";
    }

    private String statusJson() {
        StringBuilder b = new StringBuilder("{\"jobs\":{");
        boolean first = true;
        for (Map.Entry<String, Job> e : jobs.entrySet()) {
            if (!first) b.append(',');
            first = false;
            b.append(MiniJson.quote(e.getKey())).append(':').append(jobJson(e.getValue()));
        }
        return b.append("},\"disk\":").append(diskJson()).append('}').toString();
    }

    private String infoJson(String id) throws Exception {
        Mod m = byId.get(id);
        if (m == null) throw new Fail(404, "unknown module");
        try {
            List<String> vs = versions(m, false);
            if (vs.isEmpty()) throw new Fail(404, m.prefix + " was not found in the Kiwix library");
            String ver = vs.get(vs.size() - 1), name = m.prefix + "_" + ver + ".zim";
            Long size = headSize(base(m) + name);
            return "{\"id\":" + MiniJson.quote(id) + ",\"name\":" + MiniJson.quote(m.text.get("name")) + ",\"free\":" + freeSpace.getAsLong()
                    + ",\"bytes\":" + (size == null ? "null" : size.toString()) + ",\"file\":" + MiniJson.quote(name) + ",\"version\":" + MiniJson.quote(ver.replace('-', '.')) + "}";
        } catch (Fail f) {
            throw f;
        } catch (IOException e) {
            throw new Fail(502, "Could not reach the download server (" + e.getClass().getSimpleName() + ")");
        }
    }

    // ------------------------------------------------------------------ install / remove

    private synchronized Job enqueue(String id, String action) throws Fail {
        Mod m = byId.get(id);
        if (m == null) throw new Fail(404, "unknown module");
        Job old = jobs.get(id);
        if (old != null && ("queued".equals(old.state) || "running".equals(old.state))) throw new Fail(409, "Already " + old.state);
        final Job j = new Job();
        j.action = action;
        jobs.put(id, j);
        worker.execute(() -> run(m, j));
        return j;
    }

    private void run(Mod m, Job j) {
        j.state = "running";
        try {
            if ("remove".equals(j.action)) {
                j.message = "Removing…";
                for (File f : filesFor(m)) f.delete();
                for (File f : parts(m)) f.delete();
                j.message = "Removed";
            } else {
                install(m, j);
                j.message = "Installed";
            }
            j.percent = 100;
            j.state = "done";
        } catch (Fail f) {
            j.state = "error";
            j.message = f.getMessage();
        } catch (Exception e) {
            j.state = "error";
            j.message = "Failed: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
    }

    private File[] parts(Mod m) {
        File[] l = zimDir.listFiles((d, n) -> n.startsWith("." + m.prefix + "_") && n.endsWith(".zim.part"));
        return l == null ? new File[0] : l;
    }

    private void needSpace(Long bytes) throws Fail {
        if (bytes == null) return;
        long free = freeSpace.getAsLong();
        if (bytes * 1.05 + 50L * 1024 * 1024 > free) throw new Fail(507, "Not enough free space: needs " + human(bytes) + ", this device has " + human(free));
    }

    static String human(long n) {
        String[] u = {"B", "KB", "MB", "GB", "TB"};
        double v = n;
        int i = 0;
        while (v >= 1024 && i < u.length - 1) {
            v /= 1024;
            i++;
        }
        return (i == 0 ? String.valueOf((long) v) : String.format(java.util.Locale.ROOT, "%.1f", v)) + " " + u[i];
    }

    private void install(Mod m, Job j) throws Exception {
        zimDir.mkdirs();
        j.message = "Looking up the latest version…";
        List<String> vs;
        try {
            vs = versions(m, true);
        } catch (IOException e) {
            throw new Fail(502, "Could not reach the download server. Installing needs internet on this device.");
        }
        if (vs.isEmpty()) throw new Fail(404, m.prefix + " was not found in the Kiwix library");
        String name = m.prefix + "_" + vs.get(vs.size() - 1) + ".zim", url = base(m) + name;
        File dest = new File(zimDir, name);
        Long size = null;
        try {
            size = headSize(url);
        } catch (Exception ignored) {
            // unknown size: the download still works
        }
        File part = new File(zimDir, "." + name + ".part");
        long have = part.exists() ? part.length() : 0;
        needSpace(size == null ? null : Math.max(0, size - have));
        String sha;
        try {
            sha = text(url + ".sha256").trim().split("\\s+")[0].toLowerCase(java.util.Locale.ROOT);
        } catch (IOException | Fail e) {
            throw new Fail(502, "Could not read the checksum for " + name);
        }
        if (!sha.matches("[0-9a-f]{64}")) throw new Fail(502, "No valid checksum is published for " + name);
        download(url, part, sha, size, j);
        if (dest.exists()) dest.delete();
        if (!part.renameTo(dest)) throw new Fail(500, "Could not save " + name);
        for (File old : filesFor(m)) if (!old.getName().equals(name)) old.delete();     // the older edition is replaced
    }

    private void download(String url, File part, String sha, Long total, Job j) throws Exception {
        long have = part.exists() ? part.length() : 0;
        if (total != null && have > total) {
            part.delete();
            have = 0;
        }
        HttpURLConnection c = open(url, "GET", have);
        try {
            int code = c.getResponseCode();
            if (code == 416) {                 // the partial file does not fit the server's file: start over
                part.delete();
                have = 0;
                c.disconnect();
                c = open(url, "GET", 0);
                code = c.getResponseCode();
            }
            boolean append = code == 206 && have > 0;
            if (code != 200 && code != 206) throw new Fail(502, "The download server answered HTTP " + code);
            if (!append) have = 0;
            long len = total != null ? total : (c.getContentLengthLong() > 0 ? c.getContentLengthLong() + have : -1);
            long got = have;
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part, append)) {
                byte[] buf = new byte[65536];
                int n;
                long lastTick = 0;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    got += n;
                    long now = System.currentTimeMillis();
                    if (now - lastTick > 250) {
                        lastTick = now;
                        j.percent = len > 0 ? (int) Math.min(98, got * 100 / len) : 0;
                        j.message = "Downloading… " + human(got) + (len > 0 ? " of " + human(len) : "");
                    }
                }
            }
            if (len > 0 && got != len) throw new Fail(502, "The download was interrupted. Tap Retry to resume where it stopped.");
        } finally {
            c.disconnect();
        }
        j.percent = 99;
        j.message = "Verifying…";
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(part)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder hex = new StringBuilder();
        for (byte x : md.digest()) hex.append(String.format("%02x", x));
        if (!hex.toString().equals(sha)) {
            part.delete();
            throw new Fail(502, "The download was corrupted (checksum mismatch). Tap Retry.");
        }
    }

    // ------------------------------------------------------------------ API

    @Override
    public LocalServer.Result handle(String method, String route, Map<String, String> query, String body) {
        try {
            if (method.equals("GET")) {
                if (route.equals("/catalog")) return ok(200, "{\"modules\":" + catalogJson() + ",\"disk\":" + diskJson() + ",\"sizesPending\":" + sizesPending() + "}");
                if (route.equals("/status")) return ok(200, statusJson());
                if (route.equals("/info")) return ok(200, infoJson(query.getOrDefault("id", "")));
                throw new Fail(404, "Not found");
            }
            if (route.equals("/refresh")) {
                long now = System.currentTimeMillis();
                if (now - lastRefresh < 15000) throw new Fail(429, "Refreshed a moment ago");
                lastRefresh = now;
                kickSizes(true);
                return ok(200, "{\"ok\":true}");
            }
            if (route.equals("/pin")) return ok(200, "{\"ok\":true}");               // your own device: no PIN
            if (route.equals("/install") || route.equals("/remove")) {
                String id = "";
                try {
                    Object v = MiniJson.obj(MiniJson.parse(body == null || body.isEmpty() ? "{}" : body)).get("id");
                    id = v instanceof String ? (String) v : "";
                } catch (RuntimeException e) {
                    throw new Fail(400, "invalid JSON");
                }
                return ok(202, jobJson(enqueue(id, route.substring(1))));
            }
            throw new Fail(404, "Not found");
        } catch (Fail f) {
            return ok(f.code, "{\"error\":" + MiniJson.quote(f.getMessage()) + "}");
        } catch (Exception e) {
            return ok(500, "{\"error\":" + MiniJson.quote("Server error: " + e.getClass().getSimpleName()) + "}");
        }
    }

    private static LocalServer.Result ok(int code, String json) {
        return new LocalServer.Result(code, json);
    }

    /** For tests. */
    boolean idle() {
        for (Job j : jobs.values()) if ("queued".equals(j.state) || "running".equals(j.state)) return false;
        return !sizesRunning;
    }
}
