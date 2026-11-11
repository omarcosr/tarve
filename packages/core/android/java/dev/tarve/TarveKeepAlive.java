package dev.tarve;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Keeps a Tarve app running in the background while it has work that must not stop: open
 * network sessions, a sync, a download. A foreground service of type specialUse with an ongoing
 * notification (a tap brings the app back) and a partial wake lock, so its threads and sockets
 * keep going with the screen off and Android's cached-app freezer leaves the process alone.
 *
 * The app declares android.permission.FOREGROUND_SERVICE_SPECIAL_USE (package.json
 * `tarve.android.permissions`) and calls `update` from any thread, through JNI from its native
 * plugin: active with a title and text to show or refresh the notification, inactive to end it.
 */
public final class TarveKeepAlive extends Service {
    private static final String CHANNEL = "tarve.keepalive";
    private static final int NOTIFICATION = 0x7a7f;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static TarveKeepAlive instance;
    private static boolean active;
    private static String title = "", text = "";

    private PowerManager.WakeLock wakeLock;

    public static void update(final Context context, final boolean isActive, final String newTitle, final String newText) {
        final Context app = context.getApplicationContext();
        // Without the permission startForeground throws after startForegroundService, and Android
        // then ends the whole process (ForegroundServiceDidNotStartInTimeException): refuse here.
        if (isActive && Build.VERSION.SDK_INT >= 34
                && app.checkSelfPermission("android.permission.FOREGROUND_SERVICE_SPECIAL_USE") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            throw new IllegalStateException("keepAlive needs FOREGROUND_SERVICE_SPECIAL_USE in package.json tarve.android.permissions");
        }
        MAIN.post(new Runnable() {
            @Override public void run() {
                active = isActive;
                title = newTitle == null ? "" : newTitle;
                text = newText == null ? "" : newText;
                if (!active) {
                    if (instance != null) instance.shutdown();
                    return;
                }
                if (instance != null) {
                    instance.refresh();
                    return;
                }
                try {
                    app.startForegroundService(new Intent(app, TarveKeepAlive.class));
                } catch (RuntimeException error) {
                    // Started from the background (Android 12+ forbids it): the next update in front starts it.
                }
            }
        });
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Running in the background", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tarve:keepalive");
        wakeLock.setReferenceCounted(false);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        // A service started with startForegroundService must call startForeground even when the
        // hold was released before it ran, or Android ends the process.
        refresh();
        if (!active) shutdown();
        return START_NOT_STICKY;
    }

    private void refresh() {
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(getApplicationInfo().icon != 0 ? getApplicationInfo().icon : android.R.drawable.stat_notify_sync)
                .setContentTitle(title.isEmpty() ? getApplicationInfo().loadLabel(getPackageManager()) : title)
                .setContentText(text)
                .setOngoing(true)
                .setShowWhen(false);
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) builder.setContentIntent(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE));
        Notification notification = builder.build();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION, notification);
            }
        } catch (RuntimeException error) {
            // The app did not declare FOREGROUND_SERVICE_SPECIAL_USE: there is nothing to keep alive with.
            stopSelf();
            return;
        }
        wakeLock.acquire(24 * 60 * 60 * 1000L);
    }

    private void shutdown() {
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        // Swiped away from recents: the app ends, and with it what kept it running.
        active = false;
        shutdown();
    }

    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }
}
