package dev.tarve;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;

/**
 * The system permission prompt for `app.requestPermissions` (native/src/android/permissions.rs).
 * NativeActivity cannot receive onRequestPermissionsResult, so this translucent activity asks and
 * answers with each permission's state afterwards. Without a request id it asks for
 * POST_NOTIFICATIONS on behalf of TarveNotifications.
 *
 * A state is "granted", "prompt" (never answered: asking shows the dialog) or "denied". Android
 * cannot tell "never asked" from "denied for good", so the permissions the user answered are kept
 * in the app's preferences.
 */
public final class TarvePermissions extends Activity {
    static native void nativeResult(String requestId, String[] names, String[] states);

    private static final String ANSWERED = "dev.tarve.permissions";
    private String requestId;
    private String[] names, permissions;
    private boolean answered;

    /** Called from native/src/android/permissions.rs for app.checkPermissions. */
    public static String state(Context context, String permission) {
        if (context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) return "granted";
        return context.getSharedPreferences(ANSWERED, Context.MODE_PRIVATE).getBoolean(permission, false) ? "denied" : "prompt";
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestId = getIntent().getStringExtra("requestId");
        names = getIntent().getStringArrayExtra("names");
        permissions = getIntent().getStringArrayExtra("permissions");
        if (names == null || permissions == null || names.length != permissions.length) { finish(); return; }
        if (state == null) requestPermissions(permissions, 1);
    }

    @Override public void onRequestPermissionsResult(int request, String[] asked, int[] results) {
        // An empty result means the prompt was dismissed without an answer: the state stays "prompt".
        if (results.length > 0) {
            SharedPreferences.Editor editor = getSharedPreferences(ANSWERED, Context.MODE_PRIVATE).edit();
            for (String permission : asked) editor.putBoolean(permission, true);
            editor.apply();
        }
        answer();
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        if (isFinishing()) answer();
    }

    private void answer() {
        if (answered || permissions == null) return;
        answered = true;
        String[] states = new String[permissions.length];
        for (int i = 0; i < permissions.length; i++) states[i] = state(this, permissions[i]);
        if (requestId != null) {
            try { nativeResult(requestId, names, states); } catch (UnsatisfiedLinkError ignored) { }
        } else {
            TarveNotifications.permissionAnswered(this, states.length > 0 && "granted".equals(states[0]));
        }
        finish();
    }
}
