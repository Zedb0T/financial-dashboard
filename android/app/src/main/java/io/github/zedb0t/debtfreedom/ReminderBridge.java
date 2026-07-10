package io.github.zedb0t.debtfreedom;

import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.webkit.JavascriptInterface;

/**
 * Injected into the WebView as window.AndroidBridge. The web app calls
 * syncReminders() with its active reminders JSON every time data is saved,
 * so the background worker always has a fresh copy to check against.
 */
public class ReminderBridge {
    public static final String PREFS = "reminders";
    public static final String KEY_DATA = "data";

    private final Context context;

    public ReminderBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    @JavascriptInterface
    public void syncReminders(String json) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_DATA, json)
            .apply();
    }

    /** Fires an immediate native notification. Returns false if notifications
     *  are disabled for the app so the web UI can tell the user. */
    @JavascriptInterface
    public boolean testNotification() {
        ReminderWorker.ensureChannel(context);
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 24 && !nm.areNotificationsEnabled()) return false;
        nm.notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE),
            ReminderWorker.buildNotification(context, "Test Notification",
                "Native notifications are working!"));
        return true;
    }
}
