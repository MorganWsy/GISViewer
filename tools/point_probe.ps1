# 查某个屏幕坐标点上面盖的是哪个窗口（逐层往上列到顶层窗口），以及前台窗口是谁
param([int]$X = 960, [int]$Y = 471)
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class PtProbe {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P pt);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public struct P { public int X, Y; }
  public static string Describe(IntPtr h) {
    if (h == IntPtr.Zero) return "(null)";
    StringBuilder c = new StringBuilder(128); GetClassName(h, c, 128);
    StringBuilder t = new StringBuilder(200); GetWindowText(h, t, 200);
    uint pid; GetWindowThreadProcessId(h, out pid);
    return string.Format("{0} [{1}] pid={2} vis={3} '{4}'", h, c.ToString(), pid, IsWindowVisible(h), t.ToString());
  }
  public static string Trace(int x, int y) {
    P p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    List<string> lines = new List<string>();
    lines.Add("hit: " + Describe(h));
    IntPtr cur = h;
    for (int i = 0; i < 20 && cur != IntPtr.Zero; i++) {
      IntPtr par = GetParent(cur);
      if (par == IntPtr.Zero) break;
      lines.Add("  parent: " + Describe(par));
      cur = par;
    }
    lines.Add("root: " + Describe(GetAncestor(h, 2)));   // GA_ROOT
    lines.Add("foreground: " + Describe(GetForegroundWindow()));
    return string.Join(Environment.NewLine, lines);
  }
}
"@
Write-Output ("=== ({0},{1}) ===" -f $X, $Y)
[PtProbe]::Trace($X, $Y)
