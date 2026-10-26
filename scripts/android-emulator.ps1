# Headless Android emulator in Docker (google/android-emulator-container-scripts), for testing
# `tarve build --target android-x64` APKs without a phone. Needs Docker Desktop on WSL2 (/dev/kvm).
#   powershell -File scripts/android-emulator.ps1            # build the image once, start, adb connect
#   powershell -File scripts/android-emulator.ps1 -Stop
# Then: $env:ANDROID_SERIAL="localhost:5555"; adb install -r dist\App.apk
param([switch]$Stop, [string]$Image = "tarve-emulator:35", [string]$SystemImage = "V google_apis x86_64", [int]$Port = 5555)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$work = Join-Path $root "work/android-emulator"
$adb = Join-Path $env:LOCALAPPDATA "Android/Sdk/platform-tools/adb.exe"
if (!(Test-Path $adb)) { $adb = "adb" }

if ($Stop) { docker rm -f tarve-emu | Out-Null; & $adb disconnect "localhost:$Port" | Out-Null; return }

if (!(docker images -q $Image)) {
  $scripts = Join-Path $work "scripts"
  if (!(Test-Path $scripts)) { git clone --depth 1 https://github.com/google/android-emulator-container-scripts $scripts }
  if (!(Test-Path "$scripts/.venv")) { python -m venv "$scripts/.venv"; & "$scripts/.venv/Scripts/pip" install -q -e $scripts }
  # emu-docker downloads the system image and the stable Linux emulator, builds the system image
  # layer and writes the emulator Dockerfile; the emulator layer is built here with a known tag.
  "y" | & "$scripts/.venv/Scripts/emu-docker" create stable $SystemImage --dest "$work/src" --no-metrics
  docker build -t $Image "$work/src/emulator"
}

docker rm -f tarve-emu 2>$null | Out-Null
$key = Get-Content (Join-Path $env:USERPROFILE ".android/adbkey") -Raw
$ErrorActionPreference = "Continue"  # adb writes "device offline" to stderr while the emulator boots
docker run -d --name tarve-emu -e ADBKEY=$key --device /dev/kvm --mount type=tmpfs,destination=/data -p "${Port}:5555" -p 8554:8554 $Image | Out-Null
for ($i = 0; $i -lt 120; $i++) {
  & $adb connect "localhost:$Port" 2>&1 | Out-Null
  if ((& $adb -s "localhost:$Port" shell getprop sys.boot_completed 2>$null) -match "1") { "emulator ready: localhost:$Port"; return }
  Start-Sleep 3
}
throw "the emulator did not boot; see: docker logs tarve-emu"
