package dev.tarve;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * A notification's tap: reports `notificationClick` to a running app, then brings the app's
 * task forward (or starts it, when the process is gone and no one is listening).
 */
public final class TarveNotificationOpen extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        String id = getIntent().getStringExtra("id");
        try { TarveNotifications.nativeClick(id == null ? "" : id); } catch (UnsatisfiedLinkError ignored) { }
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        // Finished first: the task reset that brings the app forward would finish it again.
        finish();
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            startActivity(launch);
        }
    }
}
