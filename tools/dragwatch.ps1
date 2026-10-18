# 拖放过程采样器：每 150 毫秒看一眼左键状态、光标位置、目标点的最上层窗口和前台窗口，
# 打印成时间线。用来分辨"这段拖放里鼠标在哪、谁盖在落点上"。
param(
  [int]$Seconds = 8,
  [int]$ProbeX = 960,
  [int]$ProbeY = 471
)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DW {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public struct P { public int x, y; }
  public static string Cls(IntPtr h) {
    if (h == IntPtr.Zero) return "0";
    StringBuilder c = new StringBuilder(128); GetClassName(h, c, 128);
    uint pid; GetWindowThreadProcessId(h, out pid);
    return c.ToString() + "/" + pid;
  }
  public static string Snapshot(int px, int py) {
    P c; GetCursorPos(out c);
    P t; t.x = px; t.y = py;
    bool down = (GetAsyncKeyState(0x01) & 0x8000) != 0;
    return string.Format("{0} btn={1} 光标=({2},{3}) 落点窗口={4} 前台={5}",
      DateTime.Now.ToString("HH:mm:ss.fff"), down ? "DOWN" : "up  ", c.x, c.y,
      Cls(WindowFromPoint(t)), Cls(GetForegroundWindow()));
  }
}
"@
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  [DW]::Snapshot($ProbeX, $ProbeY)
  Start-Sleep -Milliseconds 150
}
