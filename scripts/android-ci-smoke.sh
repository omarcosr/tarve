#!/usr/bin/env bash
# Installs dist/CiSmoke.apk on the running emulator, launches it and waits for its
# "tarve-ci-smoke" logcat line (scripts/smoke-android-ci.tsx); fails unless it says ok.
# When the app logs "tarve-ci-smoke-ready-back" it gets a real Back key (`input keyevent 4`),
# again every 5 s until it logs "tarve-ci-smoke-back-done". With several devices attached, pick
# one with ANDROID_SERIAL.
set -euo pipefail
package=dev.tarve.cismoke
# A fresh install: permission answers from an earlier run would change what the app reads.
adb uninstall "$package" >/dev/null 2>&1 || true
adb install dist/CiSmoke.apk
# Media playback and app.notify ask for POST_NOTIFICATIONS (Android 13+): grant it so no
# prompt covers the window and takes the Back key.
adb shell pm grant "$package" android.permission.POST_NOTIFICATIONS || true
adb logcat -c
adb shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 >/dev/null
line=""
sent=0
last=0
for _ in $(seq 1 300); do
  log=$(adb logcat -d -s tarve:I || true)
  line=$(grep -m1 'tarve-ci-smoke {' <<<"$log" || true)
  [ -n "$line" ] && break
  if grep -q 'tarve-ci-smoke-ready-back' <<<"$log" && ! grep -q 'tarve-ci-smoke-back-done' <<<"$log"; then
    now=$(date +%s)
    # Only into our own window: on a shared emulator another app may be on top, and Back would close it.
    focus=$(adb shell dumpsys window || true)
    focus=$(grep -m1 'mCurrentFocus' <<<"$focus" || true)
    if [ $((now - last)) -ge 5 ] && [ "$sent" -lt 12 ] && [[ "$focus" == *"$package"* ]]; then
      echo "sending Back (keyevent 4)"
      adb shell input keyevent 4
      sent=$((sent + 1))
      last=$now
    fi
  fi
  sleep 1
done
echo "--- logcat (tarve)"
adb logcat -d -s tarve:* AndroidRuntime:E DEBUG:F | tail -n 120
if [ -z "$line" ]; then
  echo "::error::the app never logged tarve-ci-smoke"
  exit 1
fi
echo "$line"
case "$line" in
  *'"ok":true'*) ;;
  *) echo "::error::Android smoke failed: ${line#*tarve-ci-smoke }"; exit 1 ;;
esac
# app.notify answered { supported: true }; the notification must also be in the shade.
posted=""
for _ in $(seq 1 15); do
  shade=$(adb shell dumpsys notification --noredact || true)
  if grep -q 'Tarve CI smoke' <<<"$shade"; then posted=1; break; fi
  sleep 1
done
if [ -z "$posted" ]; then
  echo "::error::Android smoke failed: app.notify posted no notification"
  exit 1
fi
echo "Android smoke passed"
