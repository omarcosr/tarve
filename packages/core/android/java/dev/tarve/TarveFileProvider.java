package dev.tarve;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * The files `share(...)` hands to another app, without AndroidX's FileProvider: each shared
 * file gets an unguessable `content://<package>.tarve.files/<token>/<name>` URI, read-only.
 * Only files passed to {@link #uriFor} are served (for the life of the process); the provider
 * is not exported, so other apps reach it only through the grant on the share intent.
 */
public final class TarveFileProvider extends ContentProvider {
    private static final Map<String, File> shared = new HashMap<String, File>();

    static Uri uriFor(Context context, File file) {
        String token = UUID.randomUUID().toString();
        synchronized (shared) { shared.put(token, file); }
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".tarve.files")
            .appendPath(token).appendPath(file.getName()).build();
    }

    private static File fileOf(Uri uri) throws FileNotFoundException {
        String token = uri.getPathSegments().isEmpty() ? null : uri.getPathSegments().get(0);
        File file;
        synchronized (shared) { file = token == null ? null : shared.get(token); }
        if (file == null) throw new FileNotFoundException(uri.toString());
        return file;
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (mode != null && !"r".equals(mode)) throw new SecurityException("Shared files are read-only");
        return ParcelFileDescriptor.open(fileOf(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public String getType(Uri uri) {
        try { return TarveShare.mimeOf(fileOf(uri).getName()); } catch (FileNotFoundException error) { return null; }
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        File file;
        try { file = fileOf(uri); } catch (FileNotFoundException error) { return null; }
        String[] columns = projection == null ? new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE } : projection;
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[i] = file.getName();
            else if (OpenableColumns.SIZE.equals(columns[i])) row[i] = file.length();
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("read-only"); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException("read-only"); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException("read-only"); }
}
