package io.github.zedb0t.debtfreedom;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Runs every ~15 minutes via WorkManager. Mirrors the Cloudflare Worker cron:
 * between 8AM and 9PM Eastern, notify for every reminder due today that is
 * not done. Intentionally re-notifies every run (no dedup) — persistent
 * nagging until the user marks the reminder done, same as the push server.
 */
public class ReminderWorker extends Worker {
    public static final String CHANNEL_ID = "reminders";

    public ReminderWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        try {
            String json = ctx.getSharedPreferences(ReminderBridge.PREFS, Context.MODE_PRIVATE)
                .getString(ReminderBridge.KEY_DATA, null);
            if (json == null) return Result.success();

            JSONObject data = new JSONObject(json);

            long snoozeUntil = data.optLong("snoozeUntil", 0);
            if (snoozeUntil > 0 && System.currentTimeMillis() < snoozeUntil) return Result.success();

            TimeZone eastern = TimeZone.getTimeZone("America/New_York");
            Calendar cal = Calendar.getInstance(eastern);
            int hour = cal.get(Calendar.HOUR_OF_DAY);
            if (hour < 8 || hour >= 21) return Result.success();

            SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            fmt.setTimeZone(eastern);
            String today = fmt.format(cal.getTime());

            JSONArray reminders = data.optJSONArray("reminders");
            if (reminders == null) return Result.success();

            ensureChannel(ctx);
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);

            for (int i = 0; i < reminders.length(); i++) {
                JSONObject r = reminders.getJSONObject(i);
                if (r.optBoolean("done", false)) continue;
                if (!today.equals(r.optString("due"))) continue;
                nm.notify(r.optString("id", "r" + i).hashCode(), buildNotification(ctx, "Due Today", r.optString("title", "Reminder")));
            }

            // Daily digest of tasks due within 7 days (or overdue): fires on the
            // first run after 2:30pm ET, once per day.
            int minute = cal.get(Calendar.MINUTE);
            boolean past230 = hour > 14 || (hour == 14 && minute >= 30);
            android.content.SharedPreferences prefs =
                ctx.getSharedPreferences(ReminderBridge.PREFS, Context.MODE_PRIVATE);
            if (past230 && !today.equals(prefs.getString("digestDate", ""))) {
                Calendar week = (Calendar) cal.clone();
                week.add(Calendar.DAY_OF_MONTH, 6);
                String weekEnd = fmt.format(week.getTime());
                StringBuilder names = new StringBuilder();
                int count = 0;
                for (int i = 0; i < reminders.length(); i++) {
                    JSONObject r = reminders.getJSONObject(i);
                    if (r.optBoolean("done", false)) continue;
                    String due = r.optString("due", "");
                    if (due.isEmpty() || due.compareTo(weekEnd) > 0) continue;
                    count++;
                    if (count <= 4) {
                        if (names.length() > 0) names.append(", ");
                        names.append(r.optString("title", "Task"));
                    }
                }
                if (count > 0) {
                    String body = count + " due this week: " + names
                        + (count > 4 ? " +" + (count - 4) + " more" : "");
                    nm.notify("week-digest".hashCode(), buildNotification(ctx, "Tasks This Week", body));
                }
                prefs.edit().putString("digestDate", today).apply();
            }

            // Monthly nag: 1st of the month, first run at/after 3:30pm ET —
            // bills just posted, time to update balances.
            boolean past330 = hour > 15 || (hour == 15 && minute >= 30);
            if (cal.get(Calendar.DAY_OF_MONTH) == 1 && past330
                && !today.equals(prefs.getString("balanceNagDate", ""))) {
                nm.notify("balance-nag".hashCode(), buildNotification(ctx,
                    "New Month — Update Balances",
                    "Bills just posted. Update your debt balances and bank total to keep the plan accurate."));
                prefs.edit().putString("balanceNagDate", today).apply();
            }
        } catch (Exception ignored) {}
        return Result.success();
    }

    static Notification buildNotification(Context ctx, String title, String body) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = Build.VERSION.SDK_INT >= 23
            ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, piFlags);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(ctx, CHANNEL_ID)
            : new Notification.Builder(ctx);
        b.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(pi)
            .setAutoCancel(true);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH);
        return b.build();
    }

    public static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Due-today reminder alerts");
        nm.createNotificationChannel(ch);
    }
}
