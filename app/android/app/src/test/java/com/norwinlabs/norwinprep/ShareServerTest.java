package com.norwinlabs.norwinprep;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Plain-JVM test of what a child device can and cannot do on a phone's shared Wi-Fi. */
public class ShareServerTest {
    static int bad = 0;

    static void ok(boolean c, String m) {
        if (!c) {
            bad++;
            System.err.println("FAIL: " + m);
        } else System.out.println("ok   " + m);
    }

    static Object[] req(int port, String method, String path, String range) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
        c.setRequestMethod(method);
        if (range != null) c.setRequestProperty("Range", range);
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        if (in != null) in.transferTo(b);
        return new Object[]{code, b.toByteArray(), c.getHeaderField("Content-Range")};
    }

    /** Raw request that does not follow redirects. Returns {code, body, Location, Set-Cookie}. */
    static String[] raw(int port, String method, String path, String host, String cookie, String form) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
        c.setInstanceFollowRedirects(false);
        c.setRequestMethod(method);
        if (host != null) c.setRequestProperty("Host", host);
        if (cookie != null) c.setRequestProperty("Cookie", cookie);
        if (form != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            c.getOutputStream().write(form.getBytes(StandardCharsets.UTF_8));
        }
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        if (in != null) in.transferTo(b);
        return new String[]{String.valueOf(code), new String(b.toByteArray(), StandardCharsets.UTF_8), c.getHeaderField("Location"), c.getHeaderField("Set-Cookie")};
    }

    static void authTests() throws Exception {
        File dir = Files.createTempDirectory("npshareauth").toFile();
        ShareServer a = new ShareServer(p -> {
            if (p.equals("portal.html")) return new java.io.ByteArrayInputStream("<title>PORTAL</title>".getBytes());
            throw new java.io.FileNotFoundException(p);
        }, "Pat's phone", new ShareServer.Packs() {
            public List<String> installedFiles() { return Collections.emptyList(); }
            public File zimDir() { return dir; }
        }, "admin", "NOMAD");
        int port = a.start(new int[]{0});
        String[] r = raw(port, "GET", "/", null, null, null);
        ok(r[0].equals("302") && r[2].endsWith("/login"), "not signed in: the home page sends you to the sign-in page");
        r = raw(port, "GET", "/login", null, null, null);
        ok(r[0].equals("200") && r[1].contains("Sign in") && r[1].contains("name=\"password\""), "the sign-in page is shown");
        r = raw(port, "GET", "/generate_204", "connectivitycheck.gstatic.com", null, null);
        ok(r[0].equals("302") && r[2].endsWith("/login") && !r[2].contains("gstatic"), "a phone's internet test is sent to the sign-in page");
        ok(raw(port, "GET", "/api/device", null, null, null)[0].equals("302"), "nothing else is readable without signing in");
        ok(raw(port, "POST", "/x", null, null, "a=b")[0].equals("401"), "and nothing can be posted");
        r = raw(port, "POST", "/login", null, null, "username=admin&password=nomad");
        ok(r[0].equals("302") && r[2].contains("e=1") && r[3] == null, "the password is case sensitive: lower-case nomad is refused");
        r = raw(port, "POST", "/login", null, null, "username=root&password=NOMAD");
        ok(r[2] != null && r[2].contains("e=1"), "wrong user name is refused");
        r = raw(port, "POST", "/login", null, null, "username=admin&password=NOMAD");
        ok(r[0].equals("302") && "/".equals(r[2]) && r[3] != null && r[3].matches("np_sess=[a-f0-9]{48};.*HttpOnly.*SameSite=Lax.*"), "admin / NOMAD signs in and sets a private cookie");
        String cookie = r[3].split(";")[0];
        r = raw(port, "GET", "/", null, cookie, null);
        ok(r[0].equals("200") && r[1].contains("PORTAL"), "signed in: the home page opens");
        ok(raw(port, "GET", "/", null, "np_sess=" + "a".repeat(48), null)[0].equals("302"), "a made-up cookie does not work");
        raw(port, "GET", "/logout", null, cookie, null);
        ok(raw(port, "GET", "/", null, cookie, null)[0].equals("302"), "signing out ends the session");
        for (int i = 0; i < 5; i++) raw(port, "POST", "/login", null, null, "username=admin&password=wrong");
        r = raw(port, "POST", "/login", null, null, "username=admin&password=NOMAD");
        ok(r[2] != null && r[2].contains("e=2") && r[3] == null, "after 5 wrong tries it is locked for a minute, even with the right password");
        a.stop();
    }

    static void presenceTests() throws Exception {
        File dir = Files.createTempDirectory("npsharepres").toFile();
        final java.util.concurrent.atomic.AtomicInteger joins = new java.util.concurrent.atomic.AtomicInteger(), last = new java.util.concurrent.atomic.AtomicInteger();
        final String[] pw = {"NOMAD"};
        ShareServer a = new ShareServer(p -> {
            if (p.equals("portal.html")) return new java.io.ByteArrayInputStream("<title>PORTAL</title>".getBytes());
            throw new java.io.FileNotFoundException(p);
        }, "x", new ShareServer.Packs() {
            public List<String> installedFiles() { return Collections.emptyList(); }
            public File zimDir() { return dir; }
        }, "admin", (u, p) -> u.equals("admin") && p.equals(pw[0]));
        a.setListener(n -> { joins.incrementAndGet(); last.set(n); });
        int port = a.start(new int[]{0});
        raw(port, "GET", "/", null, null, null);
        ok(a.activeDevices() == 0 && joins.get() == 0, "the owner's own device (loopback) is not counted as a joined device");
        // password can change while sharing, and sessions end
        String[] r = raw(port, "POST", "/login", null, null, "username=admin&password=NOMAD");
        String cookie = r[3].split(";")[0];
        ok(raw(port, "GET", "/", null, cookie, null)[0].equals("200"), "signed in with the current password");
        pw[0] = "Fresh pass 9";
        a.resetSessions();
        ok(raw(port, "GET", "/", null, cookie, null)[0].equals("302"), "after a password change the old session is signed out");
        ok(raw(port, "POST", "/login", null, null, "username=admin&password=NOMAD")[2].contains("e=1"), "the old password no longer works");
        ok(raw(port, "POST", "/login", null, null, "username=admin&password=Fresh+pass+9")[0].equals("302"), "the new password works");
        a.stop();
    }

    public static void main(String[] a) throws Exception {
        System.setProperty("sun.net.http.allowRestrictedHeaders", "true");
        authTests();
        presenceTests();
        File dir = Files.createTempDirectory("npshare").toFile();
        byte[] pack = new byte[300_000];
        new java.util.Random(7).nextBytes(pack);
        Files.write(new File(dir, "zimgit-water_en_2025-01.zim").toPath(), pack);
        Files.write(new File(dir, "secret.txt").toPath(), "no".getBytes());          // not a pack: must never be served
        final List<String> installed = Collections.singletonList("zimgit-water_en_2025-01.zim");
        ShareServer s = new ShareServer(p -> {
            if (p.equals("portal.html")) return new java.io.ByteArrayInputStream("<title>PORTAL</title>".getBytes());
            throw new java.io.FileNotFoundException(p);
        }, "Pat's phone", new ShareServer.Packs() {
            public List<String> installedFiles() { return installed; }
            public File zimDir() { return dir; }
        });
        int port = s.start(new int[]{0});

        ok(new String((byte[]) req(port, "GET", "/", null)[1]).contains("PORTAL"), "joining devices get the landing page");
        String dev = new String((byte[]) req(port, "GET", "/api/device", null)[1], StandardCharsets.UTF_8);
        ok(dev.contains("\"hasPacks\":true") && dev.contains("\"packCount\":1") && dev.contains("\"share\":true") && dev.contains("\"modules\":false") && dev.contains("Pat's phone"), "device info says: sharing, 1 pack, no install API: " + dev);
        String list = new String((byte[]) req(port, "GET", "/packs/", null)[1]);
        ok(list.contains("zimgit-water_en_2025-01.zim") && list.contains("Kiwix"), "the packs page lists what is installed");
        Object[] full = req(port, "GET", "/packs/zimgit-water_en_2025-01.zim", null);
        ok((int) full[0] == 200 && Arrays.equals((byte[]) full[1], pack), "a pack downloads in full, byte-identical");
        Object[] part = req(port, "GET", "/packs/zimgit-water_en_2025-01.zim", "bytes=100000-");
        ok((int) part[0] == 206 && Arrays.equals((byte[]) part[1], Arrays.copyOfRange(pack, 100000, pack.length)) && "bytes 100000-299999/300000".equals(part[2]), "a Range request resumes mid-file: " + part[2]);
        ok((int) req(port, "GET", "/packs/zimgit-water_en_2025-01.zim", "bytes=999999-")[0] == 416, "a range past the end is refused (416)");
        ok((int) req(port, "GET", "/packs/secret.txt", null)[0] == 404, "files that are not installed packs are never served");
        ok((int) req(port, "GET", "/packs/..%2F..%2Fetc%2Fpasswd", null)[0] == 400 || (int) req(port, "GET", "/packs/..%2F..%2Fetc%2Fpasswd", null)[0] == 404, "path tricks are refused");
        for (String m : new String[]{"POST", "PUT", "DELETE"}) ok((int) req(port, m, "/packs/zimgit-water_en_2025-01.zim", null)[0] == 405, m + " is refused: the share is read-only");
        for (String p : new String[]{"/api/modules/catalog", "/api/share", "/api/open", "/files/", "/index.html", "/wiki/"}) ok((int) req(port, "GET", p, null)[0] == 404, "child cannot reach " + p);
        s.stop();
        System.out.println(bad == 0 ? "ALL PASSED" : bad + " FAILED");
        System.exit(bad == 0 ? 0 : 1);
    }
}
