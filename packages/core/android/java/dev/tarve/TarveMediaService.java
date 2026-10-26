package dev.tarve;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps a Tarve app alive while it plays media, the way Android music apps stay running in
 * the background: a foreground service of type mediaPlayback with a media notification and a
 * MediaSession (lock screen, headset buttons, Bluetooth, Android Auto controls), and a partial
 * wake lock so decoding and streaming continue with the screen off. The native runtime drives it
 * (native/src/android/media.rs) and receives the controls through nativeAction.
 */
public final class TarveMediaService extends Service {
    static native void nativeAction(String action, double time);

    private static final String CHANNEL = "tarve.media";
    private static final int NOTIFICATION = 0x7a7e;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static TarveMediaService instance;
    // What the notification shows; written on the main thread only.
    private static boolean active, playing, canNext, canPrevious, canSeek;
    private static String title = "", artist = "", album = "", artworkUrl;
    private static long duration = -1, position = -1;
    private static Bitmap artwork;
    private static boolean askedPermission;

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private boolean foreground;

    /** From the runtime, on any thread: shows, updates or (active false) removes the player. */
    public static void update(final Activity activity, final boolean isActive, final String newTitle, final String newArtist,
            final String newAlbum, final String newArtwork, final boolean isPlaying, final double seconds, final double at,
            final boolean next, final boolean previous, final boolean seek) {
        MAIN.post(new Runnable() {
            @Override public void run() {
                active = isActive;
                title = newTitle == null ? "" : newTitle;
                artist = newArtist == null ? "" : newArtist;
                album = newAlbum == null ? "" : newAlbum;
                playing = isPlaying;
                duration = seconds > 0 ? (long) (seconds * 1000) : -1;
                position = at >= 0 ? (long) (at * 1000) : -1;
                canNext = next;
                canPrevious = previous;
                canSeek = seek;
                if (newArtwork == null ? artworkUrl != null : !newArtwork.equals(artworkUrl)) {
                    artworkUrl = newArtwork;
                    artwork = null;
                    if (newArtwork != null && newArtwork.startsWith("https://")) loadArtwork(newArtwork);
                }
                if (!active) {
                    if (instance != null) instance.shutdown();
                    return;
                }
                askNotificationPermission(activity);
                if (instance != null) {
                    instance.refresh();
                } else if (playing) {
                    Intent intent = new Intent(activity, TarveMediaService.class);
                    try {
                        activity.startForegroundService(intent);
                    } catch (RuntimeException error) {
                        // Started from the background (Android 12+ forbids it): the next play in front starts it.
                    }
                }
            }
        });
    }

    private static void askNotificationPermission(Activity activity) {
        if (askedPermission || Build.VERSION.SDK_INT < 33) return;
        askedPermission = true;
        if (activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != 0) {
            activity.requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 0x7a7e);
        }
    }

    private static void loadArtwork(final String url) {
        new Thread(new Runnable() {
            @Override public void run() {
                Bitmap bitmap = null;
                try {
                    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                    connection.setConnectTimeout(10000);
                    connection.setReadTimeout(10000);
                    InputStream stream = connection.getInputStream();
                    try {
                        bitmap = BitmapFactory.decodeStream(stream);
                    } finally {
                        stream.close();
                    }
                } catch (Exception error) {
                    return;
                }
                final Bitmap loaded = bitmap;
                MAIN.post(new Runnable() {
                    @Override public void run() {
                        if (!url.equals(artworkUrl)) return;
                        artwork = loaded;
                        if (instance != null) instance.refresh();
                    }
                });
            }
        }, "tarve-artwork").start();
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Media playback", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
        session = new MediaSession(this, "tarve");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { nativeAction("play", -1); }
            @Override public void onPause() { nativeAction("pause", -1); }
            @Override public void onStop() { nativeAction("pause", -1); }
            @Override public void onSkipToNext() { nativeAction("next", -1); }
            @Override public void onSkipToPrevious() { nativeAction("previous", -1); }
            @Override public void onSeekTo(long ms) { nativeAction("seek", ms / 1000.0); }
        });
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            session.setSessionActivity(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE));
        }
        session.setActive(true);
        PowerManager power = getSystemService(PowerManager.class);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tarve:media");
        wakeLock.setReferenceCounted(false);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action != null && action.startsWith("dev.tarve.media.")) {
            nativeAction(action.substring("dev.tarve.media.".length()), -1);
        }
        refresh();
        if (!active) shutdown();
        return START_NOT_STICKY;
    }

    private PendingIntent control(String name) {
        Intent intent = new Intent(this, TarveMediaService.class).setAction("dev.tarve.media." + name);
        return PendingIntent.getService(this, name.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void refresh() {
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album);
        if (duration > 0) metadata.putLong(MediaMetadata.METADATA_KEY_DURATION, duration);
        if (artwork != null) metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
        session.setMetadata(metadata.build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE;
        if (canNext) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        if (canPrevious) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        if (canSeek) actions |= PlaybackState.ACTION_SEEK_TO;
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        position >= 0 ? position : PlaybackState.PLAYBACK_POSITION_UNKNOWN, playing ? 1f : 0f)
                .build());

        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(getApplicationInfo().icon != 0 ? getApplicationInfo().icon : android.R.drawable.ic_media_play)
                .setContentTitle(title.isEmpty() ? getApplicationInfo().loadLabel(getPackageManager()) : title)
                .setContentText(artist)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(playing)
                .setShowWhen(false)
                .setDeleteIntent(control("pause"));
        if (artwork != null) builder.setLargeIcon(artwork);
        if (session.getController().getSessionActivity() != null) builder.setContentIntent(session.getController().getSessionActivity());
        int shown = 0;
        int[] compact = new int[3];
        if (canPrevious) {
            builder.addAction(new Notification.Action.Builder(null, "Previous", control("previous")).build());
            compact[shown] = shown++;
        }
        builder.addAction(new Notification.Action.Builder(null, playing ? "Pause" : "Play", control(playing ? "pause" : "play")).build());
        compact[shown] = shown++;
        if (canNext) {
            builder.addAction(new Notification.Action.Builder(null, "Next", control("next")).build());
            compact[shown] = shown++;
        }
        int[] visible = new int[shown];
        System.arraycopy(compact, 0, visible, 0, shown);
        builder.setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(visible));
        Notification notification = builder.build();

        if (playing) {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION, notification);
            }
            foreground = true;
            wakeLock.acquire(6 * 60 * 60 * 1000L);
        } else {
            // Paused: the process may be stopped again and the notification dismissed.
            if (foreground) stopForeground(STOP_FOREGROUND_DETACH);
            foreground = false;
            getSystemService(NotificationManager.class).notify(NOTIFICATION, notification);
            if (wakeLock.isHeld()) wakeLock.release();
        }
    }

    private void shutdown() {
        stopForeground(STOP_FOREGROUND_REMOVE);
        getSystemService(NotificationManager.class).cancel(NOTIFICATION);
        foreground = false;
        stopSelf();
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        // Swiped away from recents: the app ends with its player.
        nativeAction("pause", -1);
        shutdown();
    }

    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (session != null) session.release();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }
}
