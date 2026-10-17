# Brings the window of process $ProcessId to the front and saves what the screen
# shows of its client area (physical pixels) to $Out as a PNG.
param([int]$ProcessId, [string]$Out, [string]$Title)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Screen {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
[Screen]::SetProcessDPIAware() | Out-Null
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $hwnd -eq [IntPtr]::Zero; $i++) {
  if ($Title) { $hwnd = (Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1).MainWindowHandle; if (-not $hwnd) { $hwnd = [IntPtr]::Zero } }
  else { $hwnd = (Get-Process -Id $ProcessId).MainWindowHandle }
  if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($hwnd -eq [IntPtr]::Zero) { throw "No window for $ProcessId $Title" }
# Windows lets a background process raise a window only right after input: tap Alt.
[Screen]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [Screen]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[Screen]::SetForegroundWindow($hwnd) | Out-Null
[Screen]::BringWindowToTop($hwnd) | Out-Null
Start-Sleep -Milliseconds 400
$rect = New-Object Screen+RECT
[Screen]::GetClientRect($hwnd, [ref]$rect) | Out-Null
$origin = New-Object Screen+POINT
[Screen]::ClientToScreen($hwnd, [ref]$origin) | Out-Null
$width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
$bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($origin.X, $origin.Y, 0, 0, (New-Object System.Drawing.Size($width, $height)))
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose()
Write-Output ('{"width":' + $width + ',"height":' + $height + '}')
