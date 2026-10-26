package dev.tarve;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * `getCurrentPosition` / `watchPosition` on Android (native/src/android/device.rs), over the
 * framework LocationManager (no Google Play services). The app asks for ACCESS_FINE_LOCATION /
 * ACCESS_COARSE_LOCATION first (the TS side does, through TarvePermissions); without either
 * the answer is "denied". Fixes go back as `[latitude, longitude, accuracy, altitude,
 * altitudeAccuracy, heading, speed, time]`, NaN where unknown.
 */
public final class TarveLocation {
    static native void nativeLocation(String id, boolean watch, double[] fix, String code, String message);

    private TarveLocation() { }

    private static final Map<String, Object[]> watches = new HashMap<String, Object[]>();

    private static boolean granted(Context context, String permission) {
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private static void answer(String id, boolean watch, Location location, String code, String message) {
        try { nativeLocation(id, watch, location == null ? null : fix(location), code, message); } catch (UnsatisfiedLinkError ignored) { }
    }

    private static double[] fix(Location l) {
        double nan = Double.NaN;
        return new double[] {
            l.getLatitude(), l.getLongitude(), l.hasAccuracy() ? l.getAccuracy() : nan,
            l.hasAltitude() ? l.getAltitude() : nan, l.hasVerticalAccuracy() ? l.getVerticalAccuracyMeters() : nan,
            l.hasBearing() ? l.getBearing() : nan, l.hasSpeed() ? l.getSpeed() : nan, l.getTime(),
        };
    }

    /** Enabled providers this app may use: fused (Android 12+) and network, GPS when fine location is granted. */
    private static List<String> providers(Context context, LocationManager manager, boolean high) {
        boolean fine = granted(context, Manifest.permission.ACCESS_FINE_LOCATION);
        List<String> list = new ArrayList<String>();
        if (Build.VERSION.SDK_INT >= 31 && manager.isProviderEnabled("fused")) list.add("fused");
        if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) list.add(LocationManager.NETWORK_PROVIDER);
        // GPS when asked for accuracy, or when nothing else is on (an emulator has GPS only).
        if (fine && (high || list.isEmpty()) && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) list.add(LocationManager.GPS_PROVIDER);
        return list;
    }

    private static abstract class Listener implements LocationListener {
        @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
        @Override public void onProviderEnabled(String provider) { }
        @Override public void onProviderDisabled(String provider) { }
    }

    /** Checks permission and providers; null (after answering) when the request cannot go on. */
    private static List<String> start(Context context, LocationManager manager, String id, boolean watch, boolean high) {
        if (!granted(context, Manifest.permission.ACCESS_FINE_LOCATION) && !granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)) {
            answer(id, watch, null, "denied", "Location permission not granted (ACCESS_FINE_LOCATION or ACCESS_COARSE_LOCATION)");
            return null;
        }
        List<String> list = manager == null ? new ArrayList<String>() : providers(context, manager, high);
        if (list.isEmpty()) {
            answer(id, watch, null, "unavailable", "Location is turned off");
            return null;
        }
        return list;
    }

    /** One fix: a recent enough last known one, else the first fix of any provider, else "timeout". */
    public static void get(Context context, final String id, boolean high, long timeoutMs, long maximumAgeMs) {
        final LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        List<String> list = start(context, manager, id, false, high);
        if (list == null) return;
        try {
            if (maximumAgeMs > 0) {
                Location best = null;
                for (String provider : list) {
                    Location last = manager.getLastKnownLocation(provider);
                    if (last == null) continue;
                    long age = (SystemClock.elapsedRealtimeNanos() - last.getElapsedRealtimeNanos()) / 1_000_000L;
                    if (age <= maximumAgeMs && (best == null || last.getAccuracy() < best.getAccuracy())) best = last;
                }
                if (best != null) { answer(id, false, best, null, null); return; }
            }
            final Handler main = new Handler(Looper.getMainLooper());
            final boolean[] done = { false };
            final Runnable[] timeout = { null };
            final LocationListener listener = new Listener() {
                @Override public void onLocationChanged(Location location) {
                    synchronized (done) { if (done[0]) return; done[0] = true; }
                    manager.removeUpdates(this);
                    main.removeCallbacks(timeout[0]);
                    answer(id, false, location, null, null);
                }
            };
            timeout[0] = new Runnable() {
                @Override public void run() {
                    synchronized (done) { if (done[0]) return; done[0] = true; }
                    manager.removeUpdates(listener);
                    answer(id, false, null, "timeout", "No location fix in time");
                }
            };
            for (String provider : list) manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper());
            main.postDelayed(timeout[0], Math.max(1L, timeoutMs));
        } catch (SecurityException error) {
            answer(id, false, null, "denied", error.getMessage());
        } catch (Exception error) {
            answer(id, false, null, "unavailable", error.getMessage());
        }
    }

    /** Fixes about every second until {@link #clear}. */
    public static void watch(Context context, final String id, boolean high) {
        final LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        List<String> list = start(context, manager, id, true, high);
        if (list == null) return;
        LocationListener listener = new Listener() {
            @Override public void onLocationChanged(Location location) {
                answer(id, true, location, null, null);
            }
        };
        try {
            for (String provider : list) manager.requestLocationUpdates(provider, 1000L, 0f, listener, Looper.getMainLooper());
            synchronized (watches) { watches.put(id, new Object[] { manager, listener }); }
        } catch (SecurityException error) {
            manager.removeUpdates(listener);
            answer(id, true, null, "denied", error.getMessage());
        } catch (Exception error) {
            manager.removeUpdates(listener);
            answer(id, true, null, "unavailable", error.getMessage());
        }
    }

    public static void clear(String id) {
        Object[] watch;
        synchronized (watches) { watch = watches.remove(id); }
        if (watch != null) ((LocationManager) watch[0]).removeUpdates((LocationListener) watch[1]);
    }
}
