package dev.tarve;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.util.ArrayList;

/**
 * `recognizeSpeech` on Android (native/src/android/device.rs), over the framework
 * SpeechRecognizer (the system's recognition service, Google's on most phones). The app asks
 * for RECORD_AUDIO first (the TS side does, through TarvePermissions). One session at a time:
 * starting another cancels the one running. Every callback runs on the UI thread, as
 * SpeechRecognizer requires; answers go back as `speech` events.
 */
public final class TarveSpeech {
    static native void nativeSpeech(String session, String phase, String text, double level, String code, String message);

    private TarveSpeech() { }

    private static SpeechRecognizer recognizer;
    private static String current;
    private static String lastPartial;
    private static long lastLevel;

    private static void send(String session, String phase, String text, double level, String code, String message) {
        try { nativeSpeech(session, phase, text, level, code, message); } catch (UnsatisfiedLinkError ignored) { }
    }

    private static void result(String session, String text, String code, String message) {
        if (session.equals(current)) {
            current = null;
            destroy();
        }
        send(session, "result", text, 0, code, message);
    }

    private static void destroy() {
        if (recognizer == null) return;
        try { recognizer.cancel(); } catch (Exception ignored) { }
        try { recognizer.destroy(); } catch (Exception ignored) { }
        recognizer = null;
    }

    static void start(final Activity activity, final String session, final String language, final boolean partial) {
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                if (current != null) result(current, null, "canceled", "Another speech session started");
                if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    send(session, "result", null, 0, "denied", "Microphone permission not granted (RECORD_AUDIO)");
                    return;
                }
                if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
                    send(session, "result", null, 0, "unavailable", "No speech recognition service on this device");
                    return;
                }
                current = session;
                lastPartial = null;
                try {
                    recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
                    recognizer.setRecognitionListener(listener(session));
                    Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                    if (language != null && !language.isEmpty()) {
                        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
                    }
                    intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial);
                    intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                    intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.getPackageName());
                    recognizer.startListening(intent);
                } catch (Exception error) {
                    result(session, null, "unavailable", String.valueOf(error));
                }
            }
        });
    }

    /** Ends listening; the recogniser then answers with the result. */
    static void stop(Activity activity, final String session) {
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                if (session.equals(current) && recognizer != null) recognizer.stopListening();
            }
        });
    }

    /** Drops the session without a result. */
    static void cancel(Activity activity, final String session) {
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                if (!session.equals(current)) return;
                current = null;
                destroy();
            }
        });
    }

    private static String first(Bundle results) {
        if (results == null) return null;
        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return list == null || list.isEmpty() ? null : list.get(0);
    }

    private static String code(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "denied";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER: return "network";
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "no-speech";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "busy";
            case SpeechRecognizer.ERROR_AUDIO: return "audio";
            default: return "unavailable";
        }
    }

    private static RecognitionListener listener(final String session) {
        return new RecognitionListener() {
            private boolean live() { return session.equals(current); }
            @Override public void onReadyForSpeech(Bundle params) { if (live()) send(session, "ready", null, 0, null, null); }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rms) {
                long now = System.currentTimeMillis();
                if (!live() || now - lastLevel < 100) return;
                lastLevel = now;
                // RMS dB runs about -2 (silence) to 10 (loud).
                send(session, "level", null, Math.max(0, Math.min(1, (rms + 2) / 12.0)), null, null);
            }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { if (live()) send(session, "end", null, 0, null, null); }
            @Override public void onError(int error) {
                if (!live()) return;
                String code = code(error);
                // Stopped after partials but before a final match: keep what was heard.
                if ("no-speech".equals(code) && lastPartial != null) result(session, lastPartial, null, null);
                else result(session, null, code, "SpeechRecognizer error " + error);
            }
            @Override public void onResults(Bundle results) {
                if (!live()) return;
                String text = first(results);
                if (text == null || text.isEmpty()) text = lastPartial;
                if (text == null || text.isEmpty()) result(session, null, "no-speech", "Nothing was recognized");
                else result(session, text, null, null);
            }
            @Override public void onPartialResults(Bundle partial) {
                if (!live()) return;
                String text = first(partial);
                if (text == null || text.isEmpty()) return;
                lastPartial = text;
                send(session, "partial", text, 0, null, null);
            }
            @Override public void onEvent(int type, Bundle params) { }
        };
    }
}
