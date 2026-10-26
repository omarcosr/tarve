package dev.tarve;

import android.app.Activity;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;

/**
 * The status and navigation bar icons follow the app's background: dark icons over a light
 * window, light ones over a dark window (the bars are transparent over the app's own colour).
 */
public final class TarveSystemBars {
    private TarveSystemBars() {}

    public static void setLight(final Activity activity, final boolean light) {
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                Window window = activity.getWindow();
                if (window == null) return;
                if (Build.VERSION.SDK_INT >= 30) {
                    WindowInsetsController controller = window.getInsetsController();
                    if (controller == null) return;
                    int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    controller.setSystemBarsAppearance(light ? mask : 0, mask);
                } else {
                    View decor = window.getDecorView();
                    int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    int current = decor.getSystemUiVisibility();
                    decor.setSystemUiVisibility(light ? current | flags : current & ~flags);
                }
            }
        });
    }
}
