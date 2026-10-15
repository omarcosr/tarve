# Physical input through Windows (SendInput): moves the real cursor, clicks, scrolls and types.
# Usage: driver.ps1 -ProcessId <app pid> -Steps <json: [{op, x, y, text, delta}]> (client coordinates, physical pixels)
param([int]$ProcessId, [string]$Steps)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Input {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  public static void Activate(IntPtr hwnd) {
    uint pid;
    uint current = GetCurrentThreadId();
    uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint target = GetWindowThreadProcessId(hwnd, out pid);
    AttachThreadInput(current, foreground, true); AttachThreadInput(current, target, true);
    ShowWindow(hwnd, 9); BringWindowToTop(hwnd); SetForegroundWindow(hwnd); SetFocus(hwnd);
    AttachThreadInput(current, target, false); AttachThreadInput(current, foreground, false);
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  public static string Describe(IntPtr hwnd) { var text = new System.Text.StringBuilder(256); GetWindowText(hwnd, text, 256); uint pid; GetWindowThreadProcessId(hwnd, out pid); return hwnd + " '" + text + "' pid " + pid; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  static void Send(INPUT input) { SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Mouse(uint flags, int data) { var i = new INPUT { type = 0 }; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; Send(i); }
  // Navigation keys are extended keys: without the flag Windows reads them as the numeric keypad (Shift+Home would lose Shift).
  static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E; }
  public static void Key(ushort vk, bool up) { var i = new INPUT { type = 1 }; i.u.ki.wVk = vk; i.u.ki.dwFlags = (up ? 2u : 0u) | (Extended(vk) ? 1u : 0u); Send(i); }
  public static void Char(char c) {
    var down = new INPUT { type = 1 }; down.u.ki.wScan = c; down.u.ki.dwFlags = 4;
    var up = new INPUT { type = 1 }; up.u.ki.wScan = c; up.u.ki.dwFlags = 4 | 2;
    Send(down); Send(up);
  }
}
"@
# Physical pixels: without this Windows scales the coordinates of a DPI-unaware process.
[Input]::SetProcessDPIAware() | Out-Null
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $hwnd -eq [IntPtr]::Zero; $i++) {
  $hwnd = (Get-Process -Id $ProcessId).MainWindowHandle
  if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($hwnd -eq [IntPtr]::Zero) { throw "No window for process $ProcessId" }
Write-Host "window: $((Get-Process -Id $ProcessId).MainWindowTitle)"
# Windows lets a background process take the foreground only right after input: tap Alt first.
[Input]::Key(0x12, $false); [Input]::Key(0x12, $true)
[Input]::Activate($hwnd)
Start-Sleep -Milliseconds 300
if ([Input]::GetForegroundWindow() -ne $hwnd) { Write-Host "warning: the app window is not in the foreground" }
foreach ($step in ($Steps | ConvertFrom-Json)) {
  switch ($step.op) {
    "click" {
      $point = New-Object Input+POINT
      $point.X = [int]$step.x; $point.Y = [int]$step.y
      [Input]::ClientToScreen($hwnd, [ref]$point) | Out-Null
      [Input]::SetCursorPos($point.X, $point.Y) | Out-Null
      Start-Sleep -Milliseconds 60
      [Input]::Mouse(0x0002, 0); Start-Sleep -Milliseconds 30; [Input]::Mouse(0x0004, 0)
    }
    "move" {
      $point = New-Object Input+POINT
      $point.X = [int]$step.x; $point.Y = [int]$step.y
      [Input]::ClientToScreen($hwnd, [ref]$point) | Out-Null
      [Input]::SetCursorPos($point.X, $point.Y) | Out-Null
    }
    "wheel" { [Input]::Mouse(0x0800, [int]$step.delta) }
    "type" { foreach ($c in $step.text.ToCharArray()) { [Input]::Char($c); Start-Sleep -Milliseconds 25 } }
    "key" { [Input]::Key([uint16]$step.vk, $false); Start-Sleep -Milliseconds 25; [Input]::Key([uint16]$step.vk, $true) }
    "chord" {
      [Input]::Key([uint16]$step.modifier, $false); [Input]::Key([uint16]$step.vk, $false)
      Start-Sleep -Milliseconds 25
      [Input]::Key([uint16]$step.vk, $true); [Input]::Key([uint16]$step.modifier, $true)
    }
  }
  Start-Sleep -Milliseconds 150
  if ([Input]::GetForegroundWindow() -ne $hwnd) { Write-Host "after $($step.op): foreground is $([Input]::Describe([Input]::GetForegroundWindow())), app $([Input]::Describe($hwnd))" }
}
