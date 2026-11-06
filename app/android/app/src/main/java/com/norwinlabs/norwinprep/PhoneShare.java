package com.norwinlabs.norwinprep;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.wifi.SoftApConfiguration;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.content.SharedPreferences;

import java.io.File;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * "Share over Wi-Fi" on a phone: opens a local-only hotspot (Android picks the network name and password) and serves the
 * installed content packs, read-only, to the devices that join. Needs Android's hotspot permission; not unit-testable off a device.
 */
public class PhoneShare implements LocalServer.Sharing {
    private static final int REQ = 71;

    private final Activity act;
    private final LocalServer.Source site;
    private final File zimDir;
    private final ModuleManager modules;
    private final String deviceName;
    private WifiManager.LocalOnlyHotspotReservation reservation;
    private ShareServer server;
    private String ssid, password, url;
    private final SharedPreferences prefs;

    // ---- sign-in password: default NOMAD; once changed it is kept only as a salted PBKDF2 hash ----
    private static String hash(String pw, byte[] salt) {
        try {
            javax.crypto.spec.PBEKeySpec spec = new javax.crypto.spec.PBEKeySpec(pw.toCharArray(), salt, 50000, 256);
            byte[] h = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
            StringBuilder b = new StringBuilder();
            for (byte x : h) b.append(String.format("%02x", x));
            return b.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] unhex(String h) {
        byte[] o = new byte[h.length() / 2];
        for (int i = 0; i < o.length; i++) o[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16);
        return o;
    }

    boolean checkAdmin(String user, String pw) {
        if (!"admin".equals(user) || pw == null) return false;
        String salt = prefs.getString("adminSalt", null), want = prefs.getString("adminHash", null);
        if (salt == null || want == null) return MessageDigest.isEqual("NOMAD".getBytes(), pw.getBytes());
        return MessageDigest.isEqual(hash(pw, unhex(salt)).getBytes(), want.getBytes());
    }

    @Override
    public synchronized String setAdminPassword(String pw) throws IOException {
        if (pw == null || pw.length() < 4 || pw.length() > 64) throw new IOException("The sign-in password must be 4 to 64 characters.");
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        StringBuilder sb = new StringBuilder();
        for (byte x : salt) sb.append(String.format("%02x", x));
        prefs.edit().putString("adminSalt", sb.toString()).putString("adminHash", hash(pw, salt)).apply();
        if (server != null) server.resetSessions();                 // everyone signs in again
        return statusJson();
    }

    private void buzz() {
        try {
            Vibrator v = (Vibrator) act.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) v.vibrate(VibrationEffect.createOneShot(300, VibrationEffect.DEFAULT_AMPLITUDE));
        } catch (RuntimeException ignored) {
        }
    }

    public PhoneShare(Activity act, LocalServer.Source site, File zimDir, ModuleManager modules, String deviceName) {
        this.act = act;
        this.site = site;
        this.zimDir = zimDir;
        this.modules = modules;
        this.deviceName = deviceName;
        this.prefs = act.getSharedPreferences("norwinprep_share", Context.MODE_PRIVATE);
    }

    @Override
    public synchronized String statusJson() {
        boolean active = reservation != null && server != null;
        StringBuilder b = new StringBuilder("{\"supported\":").append(modules != null && Build.VERSION.SDK_INT >= 26)
                .append(",\"active\":").append(active).append(",\"auto\":false,\"canAuto\":false,\"note\":")
                .append(LocalServer.jsonStr("Nearby devices join this phone's Wi-Fi and download the content packs you installed. Android picks the Wi-Fi name and password. Your phone's own hotspot must be off."));
        if (modules == null || Build.VERSION.SDK_INT < 26) b.append(",\"reason\":\"Sharing needs Android 8 or newer.\"");
        if (active) {
            b.append(",\"ssid\":").append(LocalServer.jsonStr(ssid)).append(",\"password\":").append(LocalServer.jsonStr(password))
                    .append(",\"url\":").append(LocalServer.jsonStr(url)).append(",\"login\":\"admin\"").append(",\"clients\":").append(server.activeDevices())
                    .append(",\"adminDefault\":").append(prefs.getString("adminHash", null) == null).append(",\"canChangeWifiPassword\":false");
        }
        return b.append('}').toString();
    }

    @Override
    public synchronized String set(boolean on) throws IOException {
        if (on) start();
        else stop();
        return statusJson();
    }

    public synchronized void stop() {
        if (reservation != null) {
            try {
                reservation.close();
            } catch (Exception ignored) {
            }
            reservation = null;
        }
        if (server != null) {
            server.stop();
            server = null;
        }
    }

    private boolean hasPermission() {
        String p = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.NEARBY_WIFI_DEVICES : Manifest.permission.ACCESS_FINE_LOCATION;
        return act.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED;
    }

    private void start() throws IOException {
        if (reservation != null) return;
        if (modules == null || Build.VERSION.SDK_INT < 26) throw new IOException("Sharing needs Android 8 or newer.");
        if (!hasPermission()) {
            final String p = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.NEARBY_WIFI_DEVICES : Manifest.permission.ACCESS_FINE_LOCATION;
            act.runOnUiThread(() -> act.requestPermissions(new String[]{p}, REQ));
            throw new IOException("Allow the permission Android is asking for, then tap Start sharing again.");
        }
        final ShareServer s = new ShareServer(site, deviceName, new ShareServer.Packs() {
            @Override
            public List<String> installedFiles() {
                return modules.installedFiles();
            }

            @Override
            public File zimDir() {
                return zimDir;
            }
        }, "admin", (u, p) -> checkAdmin(u, p));
        s.setListener(n -> buzz());                          // a phone in your pocket tells you someone joined
        int port;
        try {
            port = s.start(new int[]{8080, 8888, 0});
        } catch (IOException e) {
            throw new IOException("Could not start the sharing server.");
        }
        final WifiManager wm = (WifiManager) act.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        final CountDownLatch done = new CountDownLatch(1);
        final WifiManager.LocalOnlyHotspotReservation[] got = new WifiManager.LocalOnlyHotspotReservation[1];
        final int[] failure = {-1};
        try {
            wm.startLocalOnlyHotspot(new WifiManager.LocalOnlyHotspotCallback() {
                @Override
                public void onStarted(WifiManager.LocalOnlyHotspotReservation r) {
                    got[0] = r;
                    done.countDown();
                }

                @Override
                public void onFailed(int reason) {
                    failure[0] = reason;
                    done.countDown();
                }
            }, new Handler(Looper.getMainLooper()));
            if (!done.await(20, TimeUnit.SECONDS)) {
                s.stop();
                throw new IOException("The hotspot did not start in time.");
            }
        } catch (SecurityException e) {
            s.stop();
            throw new IOException("Android needs Location turned on to start a hotspot. Turn it on, then try again.");
        } catch (InterruptedException e) {
            s.stop();
            throw new IOException("Interrupted.");
        }
        if (got[0] == null) {
            s.stop();
            throw new IOException(failure[0] == WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE
                    ? "Turn off your phone's own Wi-Fi hotspot or tethering first, then try again."
                    : failure[0] == WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED
                    ? "Hotspots are not allowed on this device."
                    : "Android could not start the hotspot.");
        }
        reservation = got[0];
        server = s;
        readCredentials(reservation);
        url = "http://" + hotspotAddress() + ":" + port;
    }

    @SuppressWarnings("deprecation")
    private void readCredentials(WifiManager.LocalOnlyHotspotReservation r) {
        if (Build.VERSION.SDK_INT >= 30) {
            SoftApConfiguration c = r.getSoftApConfiguration();
            ssid = c.getSsid();
            password = c.getPassphrase();
        } else {
            WifiConfiguration c = r.getWifiConfiguration();
            ssid = c.SSID == null ? "" : c.SSID.replace("\"", "");
            password = c.preSharedKey == null ? "" : c.preSharedKey.replace("\"", "");
        }
        if (ssid == null) ssid = "";
        if (password == null) password = "";
    }

    /** The phone's address on the hotspot network (devices that join open this). The interface name differs between makers. */
    private static String hotspotAddress() {
        String best = null;
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String n = ni.getName().toLowerCase();
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    boolean ap = n.startsWith("ap") || n.startsWith("swlan") || n.equals("wlan1") || n.startsWith("softap");
                    if (ap) return a.getHostAddress();
                    if (best == null && a.getHostAddress().endsWith(".1") && !n.equals("wlan0")) best = a.getHostAddress();
                }
            }
        } catch (Exception ignored) {
        }
        return best != null ? best : "192.168.43.1";
    }
}
