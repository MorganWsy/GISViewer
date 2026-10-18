# 打印某个进程主窗口的位置与状态
param([string]$Proc = 'Tulan')
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WR {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public struct R { public int L, T, Rg, B; }
  public static string Get(IntPtr h) {
    R r; GetWindowRect(h, out r);
    return string.Format("{0},{1} - {2},{3}（{4}）", r.L, r.T, r.Rg, r.B, IsIconic(h) ? "最小化" : "显示中");
  }
}
"@
(Get-Process -Name $Proc | Sort-Object StartTime -Descending | Select-Object -First 1) |
  ForEach-Object { [WR]::Get($_.MainWindowHandle) }
