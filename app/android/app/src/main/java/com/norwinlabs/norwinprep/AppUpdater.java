package com.norwinlabs.norwinprep;

import android.app.Activity;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;

/**
 * Updates the app from the latest GitHub release. Downloads and verifies the APK (see ReleaseClient),
 * then hands it to Android's package installer; Android always asks you to confirm the install.
 */
public class AppUpdater implements LocalServer.Updater {
    private final Activity activity;
    private final ReleaseClient client;

    private volatile String state = "idle", message = "", tag = "";
    private volatile int percent = 0;

    public AppUpdater(Activity activity) {
        this.activity = activity;
        // The NorwinPrep hotspot has no internet, and this process is bound to Wi-Fi. Reach GitHub through
        // whichever network does have internet (e.g. mobile data) instead of the bound one.
        this.client = new ReleaseClient("https://api.github.com", "https://github.com", "NorwinLabs/NorwinPrepDisk",
                url -> {
                    Network n = internetNetwork();
                    return (HttpURLConnection) (n != null ? n.openConnection(url) : url.openConnection());
                });
    }

    @SuppressWarnings("deprecation")
    private Network internetNetwork() {
        try {
            ConnectivityManager cm = (ConnectivityManager) activity.getSystemService(Activity.CONNECTIVITY_SERVICE);
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities c = cm.getNetworkCapabilities(n);
                if (c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                    return n;
                }
            }
        } catch (RuntimeException ignored) {
        }
        return null;
    }

    @Override
    public String checkJson() throws IOException {
        return client.checkJson();
    }

    @Override
    public void install(final String tag, final String asset) {
        if (state.equals("downloading") || state.equals("installing")) {
            throw new IllegalStateException("An update is already running");
        }
        this.tag = tag;
        this.percent = 0;

        // Android requires a one-time "install unknown apps" permission for this app. Ask before downloading.
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            state = "needs-permission";
            message = "Allow NorwinPrep to install updates on the screen that just opened, press Back, then tap the version again.";
            activity.runOnUiThread(() -> {
                Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    activity.startActivity(i);
                } catch (RuntimeException ignored) {
                }
            });
            return;
        }

        state = "downloading";
        message = "Downloading " + asset + "…";
        new Thread(() -> {
            try {
                File dir = new File(activity.getCacheDir(), "updates");
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
                File apk = client.download(tag, asset, dir, p -> percent = p);
                state = "installing";
                percent = 100;
                message = "Opening the installer…";
                launchInstaller(apk);
                state = "done";
                message = "Tap Install in the Android prompt to finish updating to " + tag + ".";
            } catch (IOException | RuntimeException e) {
                state = "error";
                message = String.valueOf(e.getMessage());
            }
        }, "norwinprep-update").start();
    }

    private void launchInstaller(File apk) {
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.runOnUiThread(() -> activity.startActivity(i));
    }

    @Override
    public String statusJson() {
        return "{\"state\":" + LocalServer.jsonStr(state) + ",\"percent\":" + percent + ",\"message\":" + LocalServer.jsonStr(message)
                + ",\"tag\":" + LocalServer.jsonStr(tag) + "}";
    }
}
