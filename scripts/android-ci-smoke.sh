#!/usr/bin/env bash
# Installs dist/CiSmoke.apk on the running emulator, launches it and waits for its
# "tarve-ci-smoke" logcat line (scripts/smoke-android-ci.tsx); fails unless it says ok.
set -euo pipefail
package=dev.tarve.cismoke
adb install -r dist/CiSmoke.apk
adb logcat -c
adb shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 >/dev/null
line=""
for _ in $(seq 1 90); do
  line=$(adb logcat -d -s tarve:I | grep -m1 'tarve-ci-smoke' || true)
  [ -n "$line" ] && break
  sleep 2
done
echo "--- logcat (tarve)"
adb logcat -d -s tarve:* AndroidRuntime:E DEBUG:F | tail -n 80
if [ -z "$line" ]; then
  echo "::error::the app never logged tarve-ci-smoke"
  exit 1
fi
echo "$line"
case "$line" in
  *'"ok":true'*) echo "Android smoke passed" ;;
  *) echo "::error::Android smoke failed: ${line#*tarve-ci-smoke }"; exit 1 ;;
esac
