package dev.tarve;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.util.ArrayList;

/**
 * `share(...)` on Android (native/src/android/device.rs): the system chooser over ACTION_SEND,
 * or ACTION_SEND_MULTIPLE for several files. Files go out as `content://` URIs of
 * {@link TarveFileProvider} with a read grant, so the receiving app needs no storage access.
 */
public final class TarveShare {
    private TarveShare() { }

    /** Shows the chooser; null when shown, otherwise why not. */
    public static String share(Activity activity, String title, String text, String url, String[] files) {
        try {
            String body = text == null ? "" : text;
            if (url != null && !url.isEmpty() && !body.contains(url)) body = body.isEmpty() ? url : body + "\n" + url;
            ArrayList<Uri> uris = new ArrayList<Uri>();
            String type = null;
            if (files != null) for (String path : files) {
                File file = new File(path);
                if (!file.canRead()) return "Cannot read " + path;
                uris.add(TarveFileProvider.uriFor(activity, file));
                String mime = mimeOf(file.getName());
                type = type == null ? mime : type.equals(mime) ? type : type.split("/")[0].equals(mime.split("/")[0]) ? type.split("/")[0] + "/*" : "*/*";
            }
            Intent intent;
            if (uris.isEmpty()) {
                intent = new Intent(Intent.ACTION_SEND);
                intent.setType("text/plain");
            } else if (uris.size() == 1) {
                intent = new Intent(Intent.ACTION_SEND);
                intent.setType(type);
                intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            } else {
                intent = new Intent(Intent.ACTION_SEND_MULTIPLE);
                intent.setType(type);
                intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            }
            if (!body.isEmpty()) intent.putExtra(Intent.EXTRA_TEXT, body);
            if (title != null) {
                intent.putExtra(Intent.EXTRA_SUBJECT, title);
                intent.putExtra(Intent.EXTRA_TITLE, title);
            }
            if (!uris.isEmpty()) {
                // The chooser and the chosen app read the files through this grant.
                ClipData clip = ClipData.newRawUri(title == null ? "" : title, uris.get(0));
                for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
                intent.setClipData(clip);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
            Intent chooser = Intent.createChooser(intent, title);
            if (!uris.isEmpty()) chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(chooser);
            return null;
        } catch (Exception error) {
            return String.valueOf(error.getMessage());
        }
    }

    static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        String type = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
        return type == null ? "application/octet-stream" : type;
    }
}
