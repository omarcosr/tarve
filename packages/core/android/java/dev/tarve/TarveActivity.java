package dev.tarve;

import android.app.NativeActivity;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * The app's activity: NativeActivity (the runtime's android_main) plus the links and files the
 * system asks the app to open. The launch's VIEW intent (onCreate) and every later one
 * (onNewIntent: the activity is singleTask) go to the runtime as `open` events
 * (native/src/android/open_intent.rs), which become `app.onOpenUrl` / `app.onOpenFiles`. A
 * `content://` or `file://` document is copied into the app's cache and its path reported.
 * Opens that arrive before the runtime started wait here until it calls {@link #attach}.
 */
public class TarveActivity extends NativeActivity {
    static native void nativeOpen(String[] urls, String[] files, boolean initial);

    private static final Object lock = new Object();
    private static boolean attached;
    private static final List<Object[]> pending = new ArrayList<Object[]>();

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        // A re-created activity already reported its intent.
        if (state == null) open(getIntent(), true);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        open(intent, false);
    }

    private void open(Intent intent, final boolean initial) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        final Uri uri = intent.getData();
        if (uri == null) return;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (!"content".equals(scheme) && !"file".equals(scheme)) {
            deliver(new String[] { uri.toString() }, new String[0], initial);
            return;
        }
        final Context context = getApplicationContext();
        // Off the UI thread: a document can be large.
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    deliver(new String[0], new String[] { copyIn(context, uri) }, initial);
                } catch (Exception error) {
                    Log.w("tarve", "could not open " + uri + ": " + error);
                }
            }
        }, "tarve-open").start();
    }

    private static void deliver(String[] urls, String[] files, boolean initial) {
        synchronized (lock) {
            if (!attached) {
                pending.add(new Object[] { urls, files, initial });
                return;
            }
        }
        try { nativeOpen(urls, files, initial); } catch (UnsatisfiedLinkError ignored) { }
    }

    /** Called by the runtime once `nativeOpen` is registered and the app can take events. */
    static void attach() {
        List<Object[]> queued;
        synchronized (lock) {
            attached = true;
            queued = new ArrayList<Object[]>(pending);
            pending.clear();
        }
        for (Object[] open : queued) nativeOpen((String[]) open[0], (String[]) open[1], (Boolean) open[2]);
    }

    /** A document's bytes in the app's cache (`opened/<hash>/<display name>`), as a path the app can read. */
    static String copyIn(Context context, Uri uri) throws Exception {
        if ("file".equals(uri.getScheme()) && uri.getPath() != null && new File(uri.getPath()).canRead()) return uri.getPath();
        File directory = new File(context.getCacheDir(), "opened/" + Integer.toHexString(uri.toString().hashCode()));
        directory.mkdirs();
        String name = displayName(context, uri);
        File file = new File(directory, name == null || name.isEmpty() ? "document" : name.replace('/', '_'));
        InputStream in = context.getContentResolver().openInputStream(uri);
        if (in == null) throw new java.io.IOException("no content");
        OutputStream out = new FileOutputStream(file);
        try {
            byte[] buffer = new byte[64 * 1024];
            for (int read; (read = in.read(buffer)) > 0; ) out.write(buffer, 0, read);
        } finally {
            in.close();
            out.close();
        }
        return file.getAbsolutePath();
    }

    private static String displayName(Context context, Uri uri) {
        try {
            Cursor cursor = context.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null);
            if (cursor == null) return uri.getLastPathSegment();
            try { return cursor.moveToFirst() ? cursor.getString(0) : uri.getLastPathSegment(); } finally { cursor.close(); }
        } catch (Exception error) {
            return uri.getLastPathSegment();
        }
    }
}
