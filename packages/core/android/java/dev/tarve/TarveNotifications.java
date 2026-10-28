package dev.tarve;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import java.util.ArrayList;
import java.util.List;

/**
 * `app.notify` on Android (native/src/android/notification.rs). On Android 13+ the first
 * notification asks for POST_NOTIFICATIONS (TarvePermissions); notifications queued meanwhile
 * are posted once it is granted and dropped when it is denied, as a desktop drops them when
 * the user turned the app's notifications off. A tap opens the app (TarveNotificationOpen),
 * which raises `notificationClick` with the notification's id.
 */
public final class TarveNotifications {
    static native void nativeClick(String id);

    private static final String CHANNEL = "tarve-notifications";
    private static final String PERMISSION = "android.permission.POST_NOTIFICATIONS";
    private static final List<String[]> pending = new ArrayList<String[]>();
    private static int next = 1;

    private TarveNotifications() { }

    public static void show(Activity activity, String id, String title, String body) {
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            synchronized (pending) {
                pending.add(new String[] { id, title, body });
                if (pending.size() > 1) return;
            }
            Intent intent = new Intent(activity, TarvePermissions.class);
            intent.putExtra("names", new String[] { "POST_NOTIFICATIONS" });
            intent.putExtra("permissions", new String[] { PERMISSION });
            activity.startActivity(intent);
            return;
        }
        post(activity, id, title, body);
    }

    static void permissionAnswered(Context context, boolean granted) {
        List<String[]> items;
        synchronized (pending) {
            items = new ArrayList<String[]>(pending);
            pending.clear();
        }
        if (granted) for (String[] item : items) post(context, item[0], item[1], item[2]);
    }

    /** Also posts timed and place notifications (TarveScheduledNotifications), app running or not. */
    static void post(Context context, String id, String title, String body) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Notifications", NotificationManager.IMPORTANCE_DEFAULT));
        int code;
        synchronized (pending) { code = next++; }
        Intent open = new Intent(context, TarveNotificationOpen.class).putExtra("id", id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent intent = PendingIntent.getActivity(context, code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        // The small icon is drawn from its alpha: tarve_notification (android-build.ts) is white on transparent.
        int icon = context.getResources().getIdentifier("tarve_notification", "drawable", context.getPackageName());
        Notification notification = new Notification.Builder(context, CHANNEL)
            .setSmallIcon(icon != 0 ? icon : android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(intent)
            .setAutoCancel(true)
            .build();
        manager.notify("tarve", code, notification);
    }
}
