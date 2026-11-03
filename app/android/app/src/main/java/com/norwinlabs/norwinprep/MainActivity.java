package com.norwinlabs.norwinprep;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Thin shell around the NorwinPrep web portal. */
public class MainActivity extends Activity {
    private static final String CONNECT = "file:///android_asset/connect.html";

    private WebView web;
    private ConnectivityManager cm;
    private ConnectivityManager.NetworkCallback wifiCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#10140F"));
        bindToWifi();

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#10140F"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String scheme = req.getUrl().getScheme();
                if ("http".equals(scheme) || "https".equals(scheme) || "file".equals(scheme)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl()));
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                // device went away: go back to the connect page
                if (req.isForMainFrame() && !req.getUrl().toString().startsWith("file:")) {
                    view.loadUrl(CONNECT + "?manual=1");
                }
            }
        });

        // downloads (e.g. APKs from /apps/) are handed to the system browser/download manager
        web.setDownloadListener((url, ua, cd, mime, len) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) { }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(CONNECT);
    }

    /**
     * The NorwinPrep hotspot has no internet, so Android may route this app over mobile data instead.
     * Bind the process to the Wi-Fi network so 10.42.0.1 stays reachable.
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
        } catch (RuntimeException ignored) { }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else if (!String.valueOf(web.getUrl()).startsWith("file:")) {
            web.loadUrl(CONNECT + "?manual=1");   // first back press: offer to change server
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        try {
            if (cm != null && wifiCallback != null) cm.unregisterNetworkCallback(wifiCallback);
        } catch (RuntimeException ignored) { }
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
