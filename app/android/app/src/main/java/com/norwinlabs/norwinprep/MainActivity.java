package com.norwinlabs.norwinprep;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

import java.io.File;
import java.io.IOException;

/**
 * Starts a local NorwinPrep instance on 127.0.0.1 (home page, device name, file library) and shows it in a WebView.
 * From the home page you can open the local instance, "Localhost", a Pi on its hotspot, or any address.
 */
public class MainActivity extends Activity {
    private static final int PORT = 8787;
    private static final int REQ_FILE = 42;

    private WebView web;
    private LocalServer server;
    private String home;
    private ConnectivityManager cm;
    private ConnectivityManager.NetworkCallback wifiCallback;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#10140F"));

        try {
            startServer();
        } catch (IOException e) {
            TextView t = new TextView(this);
            t.setText("NorwinPrep could not start its local server:\n" + e.getMessage());
            t.setTextColor(Color.WHITE);
            t.setBackgroundColor(Color.parseColor("#10140F"));
            t.setPadding(48, 96, 48, 48);
            setContentView(t);
            return;
        }
        bindToWifi();

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#10140F"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String scheme = req.getUrl().getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl()));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                // a remote device went away: come back to the home page with a message
                String url = req.getUrl().toString();
                if (req.isForMainFrame() && !url.startsWith(home)) {
                    view.loadUrl(home + "?unreachable=" + Uri.encode(url));
                }
            }
        });

        // <input type="file"> needs an explicit chooser in WebView (used for uploads to the local library)
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        // downloads (e.g. APKs from the Pi's /apps/ page) go to the system browser/download manager
        web.setDownloadListener((url, ua, cd, mime, len) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(home);
    }

    private void startServer() throws IOException {
        final SharedPreferences prefs = getSharedPreferences("device", Context.MODE_PRIVATE);
        final String defaultName = ("NorwinPrep (" + Build.MODEL.replaceAll("[^A-Za-z0-9 ._()-]", "-") + ")");
        String version = "0";
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
        }
        final String ver = version;
        File base = getExternalFilesDir(null);
        if (base == null) base = getFilesDir();
        File filesDir = new File(base, "files");
        filesDir.mkdirs();

        server = new LocalServer(
                path -> getAssets().open("site/" + path),
                new LocalServer.Device() {
                    @Override
                    public String name() {
                        String n = prefs.getString("name", defaultName);
                        return LocalServer.NAME_RE.matcher(n).matches() ? n : defaultName;
                    }

                    @Override
                    public void setName(String name) {
                        prefs.edit().putString("name", name).apply();
                    }

                    @Override
                    public String platform() {
                        return "android";
                    }

                    @Override
                    public String version() {
                        return ver;
                    }

                    @Override
                    public String arch() {
                        return Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "";
                    }

                    @Override
                    public String packaging() {
                        return "apk";
                    }
                },
                filesDir,
                new AppUpdater(this));
        home = "http://127.0.0.1:" + server.start(PORT) + "/";
    }

    /**
     * The NorwinPrep hotspot has no internet, so Android may route this app over mobile data instead.
     * Bind the process to the Wi-Fi network so 10.42.0.1 stays reachable (loopback is unaffected).
     */
    private void bindToWifi() {
        cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        NetworkRequest req = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .build();
        wifiCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                cm.bindProcessToNetwork(network);
            }

            @Override
            public void onLost(Network network) {
                cm.bindProcessToNetwork(null);
            }
        };
        try {
            cm.requestNetwork(req, wifiCallback);
        } catch (RuntimeException ignored) {
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
        } else if (web.canGoBack()) {
            web.goBack();
        } else if (!String.valueOf(web.getUrl()).startsWith(home)) {
            web.loadUrl(home + "?stay=1");   // back to the connection options
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        try {
            if (cm != null && wifiCallback != null) cm.unregisterNetworkCallback(wifiCallback);
        } catch (RuntimeException ignored) {
        }
        if (web != null) web.destroy();
        if (server != null) server.stop();
        super.onDestroy();
    }
}
