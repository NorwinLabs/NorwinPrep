package com.norwinlabs.norwinprep;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads the latest GitHub release and downloads a release file, verifying its SHA-256 against the
 * release's SHA256SUMS. Plain Java (no Android classes) so it can be unit-tested on a normal JVM.
 */
public class ReleaseClient {
    /** Opens a connection; Android passes one that uses a network with working internet. */
    public interface Opener {
        HttpURLConnection open(URL url) throws IOException;
    }

    public interface Progress {
        void onProgress(int percent);
    }

    static final Pattern TAG_RE = Pattern.compile("^v\\d+\\.\\d+\\.\\d+$");
    static final Pattern ASSET_RE = Pattern.compile("^NorwinPrep-[A-Za-z0-9._-]+\\.(apk|exe|AppImage|deb)$");
    private static final Pattern ASSET_NAME = Pattern.compile(
            "\"name\"\\s*:\\s*\"((?:NorwinPrep-[A-Za-z0-9._-]+\\.(?:apk|exe|AppImage|deb))|SHA256SUMS)\"");

    private final String apiBase, dlBase, slug;
    private final Opener opener;

    public ReleaseClient(String apiBase, String dlBase, String slug, Opener opener) {
        this.apiBase = apiBase;
        this.dlBase = dlBase;
        this.slug = slug;
        this.opener = opener != null ? opener : url -> (HttpURLConnection) url.openConnection();
    }

    /** {"tag":"v0.6.9","url":"https://github.com/.../releases/tag/v0.6.9","assets":["NorwinPrep-...apk", ...]} */
    public String checkJson() throws IOException {
        HttpURLConnection c = open(apiBase + "/repos/" + slug + "/releases/latest", "application/vnd.github+json");
        String body;
        try (InputStream in = c.getInputStream()) {
            body = new String(readAll(in, 4_000_000), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
        Matcher t = Pattern.compile("\"tag_name\"\\s*:\\s*\"([^\"]+)\"").matcher(body);
        if (!t.find() || !TAG_RE.matcher(t.group(1)).matches()) throw new IOException("unexpected release tag");
        String tag = t.group(1);
        List<String> names = new ArrayList<>();
        Matcher m = ASSET_NAME.matcher(body);
        while (m.find()) if (!names.contains(m.group(1))) names.add(m.group(1));
        StringBuilder sb = new StringBuilder("{\"tag\":").append(LocalServer.jsonStr(tag))
                .append(",\"url\":").append(LocalServer.jsonStr("https://github.com/" + slug + "/releases/tag/" + tag))
                .append(",\"assets\":[");
        for (int i = 0; i < names.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(LocalServer.jsonStr(names.get(i)));
        }
        return sb.append("]}").toString();
    }

    /** Downloads {@code asset} of release {@code tag} into {@code dir}; returns the verified file. */
    public File download(String tag, String asset, File dir, Progress progress) throws IOException {
        if (!TAG_RE.matcher(tag).matches()) throw new IOException("bad tag");
        if (!ASSET_RE.matcher(asset).matches()) throw new IOException("bad asset");
        String base = dlBase + "/" + slug + "/releases/download/" + tag + "/";

        String sums;
        HttpURLConnection sc = open(base + "SHA256SUMS", null);
        try (InputStream in = sc.getInputStream()) {
            sums = new String(readAll(in, 1_000_000), StandardCharsets.UTF_8);
        } finally {
            sc.disconnect();
        }
        String want = null;
        for (String line : sums.split("\n")) {
            String[] p = line.trim().split("\\s+");
            if (p.length >= 2 && p[1].replaceFirst("^\\*", "").equals(asset)) {
                want = p[0].toLowerCase(Locale.ROOT);
                break;
            }
        }
        if (want == null || !want.matches("[0-9a-f]{64}")) throw new IOException("No checksum published for " + asset);

        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File part = new File(dir, asset + ".part");
        File out = new File(dir, asset);
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        HttpURLConnection dc = open(base + asset, null);
        long total = dc.getContentLengthLong();
        long got = 0;
        try (InputStream in = dc.getInputStream(); FileOutputStream fo = new FileOutputStream(part)) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
                fo.write(buf, 0, n);
                got += n;
                if (progress != null && total > 0) progress.onProgress((int) Math.min(99, got * 100 / total));
            }
        } catch (IOException e) {
            part.delete();
            throw e;
        } finally {
            dc.disconnect();
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest()) hex.append(String.format("%02x", b));
        if (!hex.toString().equals(want)) {
            part.delete();
            throw new IOException("Checksum mismatch. The download was not installed.");
        }
        if (out.exists()) out.delete();
        if (!part.renameTo(out)) throw new IOException("could not save the download");
        return out;
    }

    /** GET with manual redirect handling so every hop goes through the Opener (and never downgrades to http). */
    private HttpURLConnection open(String url, String accept) throws IOException {
        String cur = url;
        for (int i = 0; i < 6; i++) {
            HttpURLConnection c = opener.open(new URL(cur));
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "NorwinPrep-app");
            if (accept != null) c.setRequestProperty("Accept", accept);
            int code = c.getResponseCode();
            if (code == 200) return c;
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) throw new IOException("redirect without location");
                URL next = new URL(new URL(cur), loc);
                if (cur.startsWith("https:") && !"https".equals(next.getProtocol())) throw new IOException("refusing https to http redirect");
                cur = next.toString();
                continue;
            }
            c.disconnect();
            throw new IOException("HTTP " + code);
        }
        throw new IOException("too many redirects");
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            b.write(buf, 0, n);
            if (b.size() > max) throw new IOException("response too large");
        }
        return b.toByteArray();
    }
}
