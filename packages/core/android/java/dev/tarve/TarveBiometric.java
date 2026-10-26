package dev.tarve;

import android.app.Activity;
import android.content.DialogInterface;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;

/**
 * `authenticate({ reason })` on Android (native/src/android/device.rs): the framework
 * BiometricPrompt (Android 9+, no AndroidX). Android 10+ also accepts the device PIN, pattern
 * or password, as Windows Hello does. Answers success, or a code: "unsupported" (no hardware,
 * Android 8), "not-enrolled", "canceled", "lockout" or "failed".
 */
public final class TarveBiometric {
    static native void nativeResult(String id, boolean success, String code, String message);

    private TarveBiometric() { }

    private static void answer(String id, boolean success, String code, String message) {
        try { nativeResult(id, success, code, message); } catch (UnsatisfiedLinkError ignored) { }
    }

    public static void authenticate(final Activity activity, final String id, final String reason) {
        if (Build.VERSION.SDK_INT < 28) {
            answer(id, false, "unsupported", "BiometricPrompt needs Android 9");
            return;
        }
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    show(activity, id, reason);
                } catch (Exception error) {
                    answer(id, false, "failed", String.valueOf(error.getMessage()));
                }
            }
        });
    }

    private static String unavailable(int status) {
        switch (status) {
            case BiometricManager.BIOMETRIC_SUCCESS: return null;
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED: return "not-enrolled";
            default: return "unsupported";
        }
    }

    @SuppressWarnings("deprecation")
    private static void show(Activity activity, final String id, String reason) {
        int sdk = Build.VERSION.SDK_INT;
        int allowed = 0;
        if (sdk >= 30) allowed = BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        if (sdk >= 29) {
            BiometricManager manager = activity.getSystemService(BiometricManager.class);
            String code = manager == null ? "unsupported" : unavailable(sdk >= 30 ? manager.canAuthenticate(allowed) : manager.canAuthenticate());
            // Android 10 counts biometrics only; its prompt still falls back to the device credential.
            if (code != null && !(sdk == 29 && "not-enrolled".equals(code))) {
                answer(id, false, code, "not-enrolled".equals(code) ? "No biometrics or screen lock set up" : "No biometric hardware");
                return;
            }
        }
        BiometricPrompt.Builder builder = new BiometricPrompt.Builder(activity)
            .setTitle(reason == null || reason.isEmpty() ? "Authenticate" : reason);
        if (sdk >= 30) builder.setAllowedAuthenticators(allowed);
        else if (sdk == 29) builder.setDeviceCredentialAllowed(true);
        else builder.setNegativeButton(activity.getString(android.R.string.cancel), activity.getMainExecutor(), new DialogInterface.OnClickListener() {
            @Override public void onClick(DialogInterface dialog, int which) {
                answer(id, false, "canceled", "Canceled");
            }
        });
        final boolean[] answered = { false };
        builder.build().authenticate(new CancellationSignal(), activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                if (answered[0]) return;
                answered[0] = true;
                answer(id, true, null, null);
            }

            @Override public void onAuthenticationError(int error, CharSequence message) {
                if (answered[0]) return;
                answered[0] = true;
                String code;
                switch (error) {
                    case BiometricPrompt.BIOMETRIC_ERROR_CANCELED:
                    case BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED:
                    case 13: // BIOMETRIC_ERROR_NEGATIVE_BUTTON
                        code = "canceled"; break;
                    case BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT:
                    case BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT:
                        code = "lockout"; break;
                    case BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS:
                    case 14: // BIOMETRIC_ERROR_NO_DEVICE_CREDENTIAL
                        code = "not-enrolled"; break;
                    case BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT:
                    case BiometricPrompt.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                        code = "unsupported"; break;
                    default:
                        code = "failed";
                }
                answer(id, false, code, message == null ? null : message.toString());
            }
        });
    }
}
