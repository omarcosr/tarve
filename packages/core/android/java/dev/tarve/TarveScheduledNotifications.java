package dev.tarve;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import java.util.Map;

/**
 * `notify({ at })` and `notify({ place })` on Android (native/src/android/notification.rs):
 * notifications that fire with the app closed. A time is an AlarmManager alarm (exact when the
 * app may schedule exact alarms, else inexact, allowed while idle); a place is a LocationManager
 * proximity alert (no Google Play services), which needs ACCESS_FINE_LOCATION and, to fire in
 * the background, ACCESS_BACKGROUND_LOCATION. Each is kept in SharedPreferences and armed again
 * after a reboot (with RECEIVE_BOOT_COMPLETED) or an app update; each fires once.
 */
public final class TarveScheduledNotifications extends BroadcastReceiver {
    private static final String PREFS = "tarve-scheduled-notifications";
    private static final String FIRE = "dev.tarve.SCHEDULED_NOTIFICATION";

    static void set(Context context, String id, String title, String body, long at, boolean place, double latitude, double longitude, float radius, boolean leave) {
        context = context.getApplicationContext();
        cancel(context, id);
        String entry = (place ? "place" : "time") + "\n" + at + "\n" + latitude + "\n" + longitude + "\n" + radius + "\n" + (leave ? 1 : 0) + "\n" + clean(title) + "\n" + clean(body);
        prefs(context).edit().putString(id, entry).apply();
        arm(context, id, entry);
    }

    static void cancel(Context context, String id) {
        context = context.getApplicationContext();
        prefs(context).edit().remove(id).apply();
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms != null) alarms.cancel(intent(context, id, false));
        LocationManager location = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (location != null) {
            try { location.removeProximityAlert(intent(context, id, true)); } catch (SecurityException ignored) { }
        }
    }

    private static String clean(String text) { return text == null ? "" : text.replace('\n', ' '); }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static PendingIntent intent(Context context, String id, boolean place) {
        Intent intent = new Intent(context, TarveScheduledNotifications.class).setAction(FIRE)
            .setData(Uri.parse("tarve-notification://" + (place ? "place/" : "time/") + Uri.encode(id)))
            .putExtra("id", id);
        // A proximity alert adds KEY_PROXIMITY_ENTERING, so that intent must stay mutable.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (place && Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : PendingIntent.FLAG_IMMUTABLE);
        return PendingIntent.getBroadcast(context, (place ? "p:" : "t:").concat(id).hashCode(), intent, flags);
    }

    private static void arm(Context context, String id, String entry) {
        String[] p = entry.split("\n", 8);
        if (p.length < 8) return;
        if ("place".equals(p[0])) {
            LocationManager location = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
            if (location == null) return;
            try {
                location.addProximityAlert(Double.parseDouble(p[2]), Double.parseDouble(p[3]), Float.parseFloat(p[4]), -1, intent(context, id, true));
            } catch (SecurityException ignored) {
                // No location permission: nothing fires until the app sets it again with one.
            } catch (NumberFormatException ignored) { }
            return;
        }
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        long at;
        try { at = Long.parseLong(p[1]); } catch (NumberFormatException error) { return; }
        long when = Math.max(at, System.currentTimeMillis() + 1000);
        PendingIntent pending = intent(context, id, false);
        try {
            if (Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pending);
            else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pending);
        } catch (SecurityException error) {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pending);
        }
    }

    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            for (Map.Entry<String, ?> entry : prefs(context).getAll().entrySet()) arm(context, entry.getKey(), String.valueOf(entry.getValue()));
            return;
        }
        if (!FIRE.equals(action)) return;
        String id = intent.getStringExtra("id");
        if (id == null) return;
        String entry = prefs(context).getString(id, null);
        if (entry == null) return;
        String[] p = entry.split("\n", 8);
        if (p.length < 8) return;
        if ("place".equals(p[0])) {
            boolean entering = intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, true);
            if (entering == "1".equals(p[5])) return;
        }
        cancel(context, id);
        TarveNotifications.post(context, id, p[6], p[7]);
    }
}
