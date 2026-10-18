# 拖放注册探针：把一个进程的窗口树列出来，并逐个查 OLE 拖放注册留下的窗口属性。
# RegisterDragDrop 会在目标窗口上留 "OleDropTargetInterface" 和 "OleDropTargetMarshaller"
# 两个窗口属性，属性在不在就说明这块窗口上有没有接收器。
# 用法：pwsh -File tools/droptarget_probe.ps1 -Proc Tulan
param(
  [string]$Proc = 'Tulan',
  [int]$TargetPid = 0
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class DropProbe {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr GetProp(IntPtr h, string name);

  public static List<string> Lines = new List<string>();

  static string Cls(IntPtr h) {
    StringBuilder sb = new StringBuilder(256);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static void Walk(IntPtr h, int depth) {
    uint pid;
    uint tid = GetWindowThreadProcessId(h, out pid);
    IntPtr iface = GetProp(h, "OleDropTargetInterface");
    IntPtr marsh = GetProp(h, "OleDropTargetMarshaller");
    StringBuilder sb = new StringBuilder();
    sb.Append(new string(' ', depth * 2));
    sb.Append("0x").Append(h.ToInt64().ToString("X")).Append(' ').Append(Cls(h));
    sb.Append("  pid=").Append(pid);
    if (!IsWindowVisible(h)) sb.Append("  [不可见]");
    sb.Append(iface != IntPtr.Zero || marsh != IntPtr.Zero
      ? "  接收器=有(iface=0x" + iface.ToInt64().ToString("X") + " marsh=0x" + marsh.ToInt64().ToString("X") + ")"
      : "  接收器=无");
    Lines.Add(sb.ToString());
    IntPtr c = IntPtr.Zero;
    while (true) {
      c = FindWindowEx(h, c, null, null);
      if (c == IntPtr.Zero) break;
      Walk(c, depth + 1);
    }
  }
}
"@

if ($TargetPid -gt 0) { $p = Get-Process -Id $TargetPid } else { $p = Get-Process -Name $Proc -ErrorAction Stop | Select-Object -First 1 }
$h = $p.MainWindowHandle
if (-not $h -or $h -eq 0) { throw "进程 $($p.Id) 没有主窗口" }
Write-Output ("进程 {0} pid={1} 主窗口 0x{2} '{3}'" -f $p.ProcessName, $p.Id, $h.ToInt64().ToString('X'), $p.MainWindowTitle)
[DropProbe]::Lines.Clear()
[DropProbe]::Walk($h, 0)
[DropProbe]::Lines | ForEach-Object { Write-Output $_ }
