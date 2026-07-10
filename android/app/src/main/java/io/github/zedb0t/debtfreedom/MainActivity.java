package io.github.zedb0t.debtfreedom;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://zedb0t.github.io/financial-dashboard/";
    private static final String RELEASES_API = "https://api.github.com/repos/Zedb0T/financial-dashboard/releases/latest";
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );

        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(Color.parseColor("#0e1a25"));
            getWindow().setNavigationBarColor(Color.parseColor("#0a1015"));
        }

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.grant(request.getResources());
            }
        });

        webView.addJavascriptInterface(new ReminderBridge(this), "AndroidBridge");
        webView.loadUrl(APP_URL);

        setupNotifications();
        checkForUpdate();
    }

    private void setupNotifications() {
        ReminderWorker.ensureChannel(this);

        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }

        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
            ReminderWorker.class, 15, TimeUnit.MINUTES).build();
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "reminder-check", ExistingPeriodicWorkPolicy.KEEP, req);
    }

    private void checkForUpdate() {
        new Thread(() -> {
            try {
                URL url = new URL(RELEASES_API);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestProperty("Accept", "application/vnd.github+json");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);

                if (conn.getResponseCode() != 200) return;

                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();

                JSONObject release = new JSONObject(sb.toString());
                String tag = release.optString("tag_name", "");
                String latestVersion = tag.startsWith("v") ? tag.substring(1) : tag;

                String cv = "";
                try {
                    PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                    cv = pi.versionName;
                } catch (Exception ignored) {}
                final String currentVersion = cv;

                if (currentVersion.isEmpty() || latestVersion.isEmpty()) return;
                if (compareVersions(latestVersion, currentVersion) <= 0) return;

                String apkUrl = null;
                JSONArray assets = release.optJSONArray("assets");
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.getJSONObject(i);
                        if (asset.optString("name", "").endsWith(".apk")) {
                            apkUrl = asset.optString("browser_download_url");
                            break;
                        }
                    }
                }

                final String downloadUrl = apkUrl != null ? apkUrl
                    : release.optString("html_url", "");
                final String version = latestVersion;

                runOnUiThread(() -> new AlertDialog.Builder(this)
                    .setTitle("Update Available")
                    .setMessage("Version " + version + " is available. You have " + currentVersion + ".")
                    .setPositiveButton("Update", (d, w) -> downloadAndInstall(downloadUrl))
                    .setNegativeButton("Later", null)
                    .show());

            } catch (Exception ignored) {}
        }).start();
    }

    /** Streams the APK straight into a PackageInstaller session — no file ever
     *  hits Downloads. Android shows its own install confirmation; the first
     *  time, it also asks the user to allow this app to install updates. */
    private void downloadAndInstall(String apkUrl) {
        if (Build.VERSION.SDK_INT < 21 || !apkUrl.endsWith(".apk")) {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl)));
            return;
        }

        AlertDialog progress = new AlertDialog.Builder(this)
            .setTitle("Updating")
            .setMessage("Downloading…")
            .setCancelable(false)
            .create();
        progress.show();

        new Thread(() -> {
            PackageInstaller.Session session = null;
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(apkUrl).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                if (conn.getResponseCode() != 200) throw new Exception("HTTP " + conn.getResponseCode());
                long total = conn.getContentLength();

                PackageInstaller installer = getPackageManager().getPackageInstaller();
                int sessionId = installer.createSession(
                    new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL));
                session = installer.openSession(sessionId);

                InputStream in = conn.getInputStream();
                OutputStream out = session.openWrite("update.apk", 0, total > 0 ? total : -1);
                byte[] buf = new byte[65536];
                long done = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    if (total > 0) {
                        final int pct = (int) (done * 100 / total);
                        runOnUiThread(() -> progress.setMessage("Downloading… " + pct + "%"));
                    }
                }
                session.fsync(out);
                out.close();
                in.close();

                runOnUiThread(() -> progress.setMessage("Installing…"));

                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
                PendingIntent pi = PendingIntent.getBroadcast(
                    this, 0, new Intent(this, InstallReceiver.class), flags);
                session.commit(pi.getIntentSender());
                session.close();

                runOnUiThread(progress::dismiss);
            } catch (Exception e) {
                if (session != null) {
                    try { session.abandon(); } catch (Exception ignored) {}
                }
                runOnUiThread(() -> {
                    progress.dismiss();
                    new AlertDialog.Builder(this)
                        .setTitle("Update Failed")
                        .setMessage("Couldn't update in-app. Download in browser instead?")
                        .setPositiveButton("Open Browser", (d, w) ->
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl))))
                        .setNegativeButton("Cancel", null)
                        .show();
                });
            }
        }).start();
    }

    private static int compareVersions(String a, String b) {
        String[] pa = a.split("\\.");
        String[] pb = b.split("\\.");
        int len = Math.max(pa.length, pb.length);
        for (int i = 0; i < len; i++) {
            int va = i < pa.length ? Integer.parseInt(pa[i]) : 0;
            int vb = i < pb.length ? Integer.parseInt(pb[i]) : 0;
            if (va != vb) return va - vb;
        }
        return 0;
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
