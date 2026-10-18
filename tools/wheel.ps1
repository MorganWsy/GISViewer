param(
  [string]$Proc = "Tulan",
  [int]$Notches = 20,
  [double]$FracX = 0.5,
  [double]$FracY = 0.45,
  [int]$DelayMs = 60
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WheelNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder b, int m);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$p = Get-Process -Name $Proc -ErrorAction Stop | Select-Object -First 1
$h = $p.MainWindowHandle
# 目标窗口可能被别的窗口盖着：先抬到最前再滚，不然滚轮事件落在别的窗口上
[WheelNative]::ShowWindow($h, 9) | Out-Null
[WheelNative]::BringWindowToTop($h) | Out-Null
$fg = [WheelNative]::GetForegroundWindow()
$fgTid = [WheelNative]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$meTid = [WheelNative]::GetCurrentThreadId()
[WheelNative]::AttachThreadInput($meTid, $fgTid, $true) | Out-Null
$ok = [WheelNative]::SetForegroundWindow($h)
[WheelNative]::AttachThreadInput($meTid, $fgTid, $false) | Out-Null
Start-Sleep -Milliseconds 350
$r = New-Object WheelNative+RECT
[WheelNative]::GetWindowRect($h, [ref]$r) | Out-Null
$x = [int]($r.Left + ($r.Right - $r.Left) * $FracX)
$y = [int]($r.Top + ($r.Bottom - $r.Top) * $FracY)
[WheelNative]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 200
$pt = New-Object WheelNative+POINT
$pt.x = $x; $pt.y = $y
$under = [WheelNative]::WindowFromPoint($pt)
$sb = New-Object System.Text.StringBuilder 256
[WheelNative]::GetClassName($under, $sb, 256) | Out-Null
Write-Host ("前置={0} 落点 0x{1:X} class='{2}'" -f $ok, [int64]$under, $sb.ToString())
for ($i = 0; $i -lt $Notches; $i++) {
  [WheelNative]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero)   # WHEEL, +120 = 上滚放大
  Start-Sleep -Milliseconds $DelayMs
}
Write-Host "滚了 $Notches 格 @ ($x,$y)"
