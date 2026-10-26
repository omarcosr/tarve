package dev.tarve;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.FileObserver;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * The app's file dialogs on Android, through the system picker (Storage Access Framework). An
 * opened document is copied into the app's cache and its path returned, as a desktop dialog
 * returns one. A saved document gets a cache path too: whatever the app writes there is copied
 * to the chosen document each time the file is closed. Folders have no path on Android: the
 * folder dialog reports an error.
 */
public final class TarveFilePicker extends Activity {
    static native void nativeResult(String requestId, String[] paths, String error);

    /** Save targets stay watched for the life of the process. */
    private static final List<FileObserver> watched = new ArrayList<FileObserver>();
    private String requestId, mode;
    private boolean answered;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestId = getIntent().getStringExtra("requestId");
        mode = getIntent().getStringExtra("mode");
        if (state != null) return;
        String[] extensions = getIntent().getStringArrayExtra("extensions");
        String fileName = getIntent().getStringExtra("fileName");
        Intent intent;
        if ("saveFile".equals(mode)) {
            intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mimeOf(fileName));
            if (fileName != null) intent.putExtra(Intent.EXTRA_TITLE, fileName);
        } else if ("openFolder".equals(mode)) {
            answer(new String[0], "Folders cannot be opened on Android: the system gives apps documents, not paths");
            return;
        } else {
            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            List<String> types = new ArrayList<String>();
            if (extensions != null) for (String extension : extensions) {
                String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.replaceFirst("^\\.", "").toLowerCase());
                if (type == null) { types.clear(); break; }
                if (!types.contains(type)) types.add(type);
            }
            if (!types.isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
            if ("openFiles".equals(mode)) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        try {
            startActivityForResult(intent, 1);
        } catch (Exception error) {
            answer(new String[0], "No app can pick documents: " + error.getMessage());
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        if (result != RESULT_OK || data == null) { answer(new String[0], null); return; }
        try {
            List<Uri> uris = new ArrayList<Uri>();
            if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
            List<String> paths = new ArrayList<String>();
            for (Uri uri : uris) paths.add("saveFile".equals(mode) ? saveTarget(uri) : copyIn(uri));
            answer(paths.toArray(new String[0]), null);
        } catch (Exception error) {
            answer(new String[0], "The document could not be read: " + error.getMessage());
        }
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        if (isFinishing()) answer(new String[0], null);
    }

    private void answer(String[] paths, String error) {
        if (!answered && requestId != null) nativeResult(requestId, paths, error);
        answered = true;
        finish();
    }

    private File slot(Uri uri) {
        File directory = new File(getCacheDir(), "picked/" + Integer.toHexString(uri.toString().hashCode()));
        directory.mkdirs();
        String name = displayName(uri);
        return new File(directory, name == null ? "document" : name.replace('/', '_'));
    }

    private String copyIn(Uri uri) throws Exception {
        File file = slot(uri);
        InputStream in = getContentResolver().openInputStream(uri);
        if (in == null) throw new java.io.IOException("no content");
        try { copy(in, new FileOutputStream(file)); } finally { in.close(); }
        return file.getAbsolutePath();
    }

    private String saveTarget(final Uri uri) throws Exception {
        final File file = slot(uri);
        new FileOutputStream(file).close();
        final ContentResolver resolver = getContentResolver();
        FileObserver observer = new FileObserver(file.getAbsolutePath(), FileObserver.CLOSE_WRITE) {
            @Override public void onEvent(int event, String path) {
                try {
                    OutputStream out = resolver.openOutputStream(uri, "wt");
                    if (out != null) copy(new FileInputStream(file), out);
                } catch (Exception ignored) {
                }
            }
        };
        observer.startWatching();
        synchronized (watched) { watched.add(observer); }
        return file.getAbsolutePath();
    }

    private String displayName(Uri uri) {
        Cursor cursor = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null);
        if (cursor == null) return uri.getLastPathSegment();
        try { return cursor.moveToFirst() ? cursor.getString(0) : uri.getLastPathSegment(); } finally { cursor.close(); }
    }

    private static String mimeOf(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        String type = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
        return type == null ? "application/octet-stream" : type;
    }

    private static void copy(InputStream in, OutputStream out) throws java.io.IOException {
        try {
            byte[] buffer = new byte[64 * 1024];
            for (int read; (read = in.read(buffer)) > 0; ) out.write(buffer, 0, read);
        } finally {
            in.close();
            out.close();
        }
    }
}
