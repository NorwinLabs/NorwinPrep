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

    public static void main(String[] a) throws Exception {
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
